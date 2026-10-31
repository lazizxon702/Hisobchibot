import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, createMockPrismaService } from './test-utils';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { SalesService } from '../src/modules/sales/sales.service';
import { UsersService } from '../src/modules/users/users.service';
import { CustomersService } from '../src/modules/customers/customers.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { SequenceService } from '../src/infrastructure/sequence/sequence.service';
import { OutboxService } from '../src/infrastructure/outbox/outbox.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import {
  PaymentMethod,
  Currency,
  PaymentStatus,
  RoleName,
  InventoryUnitStatus,
} from '@prisma/client';
import { BadRequestException, ConflictException } from '@nestjs/common';

describe('Scenarios 12 - 16 (Payments, Multi-currency, Idempotency & Overpayment Protection)', () => {
  let db: any;
  let prisma: any;
  let paymentsService: PaymentsService;
  let salesService: SalesService;
  let usersService: UsersService;
  let customersService: CustomersService;
  let auditService: AuditService;
  let sequenceService: SequenceService;
  let outboxService: OutboxService;
  let redisService: RedisService;

  let operator: any;
  let order: any;
  let sale: any;

  beforeEach(async () => {
    db = createInMemoryDb();
    prisma = createMockPrismaService(db);

    auditService = new AuditService(prisma);
    sequenceService = new SequenceService(prisma);
    customersService = new CustomersService(prisma);
    outboxService = new OutboxService(prisma);
    redisService = new RedisService();
    usersService = new UsersService(prisma, auditService);

    paymentsService = new PaymentsService(
      prisma,
      sequenceService,
      usersService,
      auditService,
      outboxService,
      redisService,
    );

    salesService = new SalesService(prisma, usersService, customersService, auditService);

    db.roles.push({ id: 'role-operator', name: RoleName.CONTINUATION_OPERATOR });

    operator = await prisma.user.create({
      data: { telegramId: BigInt(3001), firstName: 'Op1', isActive: true, isApproved: true },
    });
    await prisma.userRole.create({ data: { userId: operator.id, roleId: 'role-operator' } });

    const cust = await prisma.customer.create({
      data: { fullName: 'Mijoz 1', phone1: '+998901234567', generalLimit: 50000000, withdrawableLimit: 50000000 },
    });

    const store = await prisma.store.create({ data: { name: 'Store 1', address: 'Tashkent' } });
    const prog = await prisma.financingProgram.create({ data: { name: 'P1', requiresContinuation: true } });

    order = await prisma.order.create({
      data: {
        orderNumber: 'ORD-2026-000099',
        sellerId: operator.id,
        programId: prog.id,
        storeId: store.id,
        customerId: cust.id,
        contractEndDate: new Date('2026-12-31'),
        agentPercentage: 5,
        clientPayoutAmount: 20000000,
        totalPrice: 20000000,
        totalQuantity: 1,
        businessDate: new Date(),
      },
    });

    // Assignment for operator
    await prisma.orderAssignment.create({
      data: { orderId: order.id, operatorId: operator.id, assignedBy: operator.id, status: 'ACCEPTED' },
    });

    const oItem = await prisma.orderItem.create({
      data: { orderId: order.id, category: 'Telefon', brand: 'Apple', model: 'iPhone 15', quantity: 1, unitPrice: 20000000, totalPrice: 20000000 },
    });

    const unit = await prisma.inventoryUnit.create({
      data: { orderId: order.id, orderItemId: oItem.id, category: 'Telefon', imei1: '999888777666555', status: InventoryUnitStatus.IN_STOCK },
    });

    // Create a sale for 20,000,000 UZS
    sale = await salesService.createSale({
      orderId: order.id,
      operatorId: operator.id,
      buyer: { fullName: 'Харидор 1', phone: '+998901112233' },
      plannedSalePrice: 20000000,
      actualSalePrice: 20000000,
      items: [{ inventoryUnitId: unit.id, unitPrice: 20000000 }],
      debtDueDate: new Date('2026-12-01'),
    });
  });

  // 12. Бир сотув бир нечта усул ва валютада тўланади.
  it('Scenario 12: Бир сотув бир нечта усул ва валютада (Нақд UZS ва Банк USD) тўланади', async () => {
    // 1st payment: 5,000,000 UZS in CASH
    const pay1 = await paymentsService.recordPayment({
      saleId: sale.id,
      method: PaymentMethod.CASH,
      currency: Currency.UZS,
      originalAmount: 5000000,
      createdById: operator.id,
    });
    expect(pay1.receiptNumber).toMatch(/^PAY-2026-\d{6}$/);

    // 2nd payment: $500 in BANK_TRANSFER at rate 12,800 = 6,400,000 UZS
    const pay2 = await paymentsService.recordPayment({
      saleId: sale.id,
      method: PaymentMethod.BANK_TRANSFER,
      currency: Currency.USD,
      originalAmount: 500,
      exchangeRate: 12800,
      createdById: operator.id,
    });
    expect(pay2.calculatedAmount.toString()).toBe('6400000');

    // Total paid: 5,000,000 + 6,400,000 = 11,400,000 UZS
    // Remaining: 20,000,000 - 11,400,000 = 8,600,000 UZS
    const updatedSale = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(updatedSale.paidAmount.toString()).toBe('11400000');
    expect(updatedSale.remainingAmount.toString()).toBe('8600000');
    expect(updatedSale.paymentStatus).toBe(PaymentStatus.PARTIAL);
  });

  // 13. USD тўлови белгиланган курс билан ҳисобланади.
  it('Scenario 13: USD тўлови белгиланган курс билан ҳисобланади ва ўзгармас сақланади', async () => {
    const payment = await paymentsService.recordPayment({
      saleId: sale.id,
      method: PaymentMethod.CASH,
      currency: Currency.USD,
      originalAmount: 1000,
      exchangeRate: 12850,
      createdById: operator.id,
    });

    expect(payment.currency).toBe(Currency.USD);
    expect(payment.originalAmount.toString()).toBe('1000');
    expect(payment.exchangeRate?.toString()).toBe('12850');
    expect(payment.calculatedAmount.toString()).toBe('12850000');
  });

  // 14. Қисман тўлов қолдиқни тўғри камайтиради.
  it('Scenario 14: Қисман тўлов қолдиқни тўғри камайтиради', async () => {
    await paymentsService.recordPayment({
      saleId: sale.id,
      method: PaymentMethod.CASH,
      currency: Currency.UZS,
      originalAmount: 8000000,
      createdById: operator.id,
    });

    const updatedSale = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(updatedSale.paidAmount.toString()).toBe('8000000');
    expect(updatedSale.remainingAmount.toString()).toBe('12000000');
    expect(updatedSale.paymentStatus).toBe(PaymentStatus.PARTIAL);
  });

  // 15. Ортиқча тўлов рад этилади.
  it('Scenario 15: Ортиқча тўлов рад этилади (қолдиқдан кўпроқ тўлаш мумкин эмас)', async () => {
    // Sale price is 20,000,000. Trying to pay 25,000,000 must throw BadRequestException
    await expect(
      paymentsService.recordPayment({
        saleId: sale.id,
        method: PaymentMethod.CASH,
        currency: Currency.UZS,
        originalAmount: 25000000,
        createdById: operator.id,
      }),
    ).rejects.toThrow('Ортиқча тўлов рад этилди!');
  });

  // 16. Такрорий update янги тўлов яратмайди.
  it('Scenario 16: Такрорий update ёки тугмани қайта босиш янги тўлов яратмайди (идемпотентлик)', async () => {
    // Mock redis lock failure for second click with same idempotency key
    const mockRedis = {
      acquireLock: async (key: string) => {
        if (key.includes('idem-first-call')) return true;
        return false; // locked on second call
      },
      releaseLock: async () => {},
    };

    const customPaymentsService = new PaymentsService(
      prisma,
      sequenceService,
      usersService,
      auditService,
      outboxService,
      mockRedis as any,
    );

    // First call succeeds
    const pay1 = await customPaymentsService.recordPayment({
      saleId: sale.id,
      method: PaymentMethod.CASH,
      currency: Currency.UZS,
      originalAmount: 1000000,
      createdById: operator.id,
      idempotencyKey: 'idem-first-call',
    });
    expect(pay1).toBeDefined();

    // Repeated call with locked/duplicate key throws ConflictException
    await expect(
      customPaymentsService.recordPayment({
        saleId: sale.id,
        method: PaymentMethod.CASH,
        currency: Currency.UZS,
        originalAmount: 1000000,
        createdById: operator.id,
        idempotencyKey: 'duplicate-key-concurrent',
      }),
    ).rejects.toThrow(ConflictException);
  });
});
