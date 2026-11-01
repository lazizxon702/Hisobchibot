import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, createMockPrismaService } from './test-utils';
import { OrdersService } from '../src/modules/orders/orders.service';
import { CustomersService } from '../src/modules/customers/customers.service';
import { FinancingProgramsService } from '../src/modules/financing-programs/financing-programs.service';
import { StoresService } from '../src/modules/stores/stores.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { SequenceService } from '../src/infrastructure/sequence/sequence.service';
import { UsersService } from '../src/modules/users/users.service';
import { SalesService } from '../src/modules/sales/sales.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { DebtsService } from '../src/modules/debts/debts.service';
import { OutboxService } from '../src/infrastructure/outbox/outbox.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import {
  OrderStatus,
  InventoryUnitStatus,
  PaymentStatus,
  PaymentMethod,
  Currency,
  DaftarStatus,
  RoleName,
} from '@prisma/client';
import { DecimalUtil } from '../src/common/decimal.util';

describe('36-Point Full Business Process Tests', () => {
  let db: any;
  let prisma: any;
  let ordersService: OrdersService;
  let customersService: CustomersService;
  let programsService: FinancingProgramsService;
  let storesService: StoresService;
  let auditService: AuditService;
  let sequenceService: SequenceService;
  let usersService: UsersService;
  let salesService: SalesService;
  let paymentsService: PaymentsService;
  let debtsService: DebtsService;
  let outboxService: OutboxService;
  let redisService: RedisService;

  let seller: any;
  let operator: any;
  let store: any;
  let programPayme: any;
  let programAlif6: any;

  beforeEach(async () => {
    db = createInMemoryDb();
    prisma = createMockPrismaService(db);

    auditService = new AuditService(prisma);
    sequenceService = new SequenceService(prisma);
    customersService = new CustomersService(prisma);
    programsService = new FinancingProgramsService(prisma);
    storesService = new StoresService(prisma);
    outboxService = new OutboxService(prisma);
    redisService = new RedisService();
    usersService = new UsersService(prisma, auditService);
    salesService = new SalesService(prisma, usersService, customersService, auditService, sequenceService);
    paymentsService = new PaymentsService(prisma, sequenceService, usersService, auditService, outboxService, redisService);
    debtsService = new DebtsService(prisma, usersService);
    ordersService = new OrdersService(
      prisma,
      sequenceService,
      customersService,
      programsService,
      storesService,
      auditService,
    );

    // Setup base roles
    db.roles.push(
      { id: 'role-seller', name: RoleName.SELLER },
      { id: 'role-operator', name: RoleName.CONTINUATION_OPERATOR },
      { id: 'role-admin', name: RoleName.SUPER_ADMIN },
    );

    seller = {
      id: 'usr-seller',
      telegramId: BigInt(2038308226),
      firstName: 'Исфандиёр',
      lastName: 'Исроилов',
      isActive: true,
      roles: ['SELLER'],
    };
    operator = {
      id: 'usr-operator',
      telegramId: BigInt(987654321),
      firstName: 'Одил',
      lastName: 'Камолов',
      isActive: true,
      roles: ['CONTINUATION_OPERATOR'],
    };

    db.users.push(seller, operator);
    db.userRoles.push(
      { userId: seller.id, roleId: 'role-seller' },
      { userId: operator.id, roleId: 'role-operator' },
    );

    store = {
      id: 'store-1',
      name: 'Planet Phone',
      address: 'Малика бозори, 15-дўкон',
      isActive: true,
    };
    db.stores.push(store);

    programPayme = {
      id: 'prog-payme',
      name: 'Payme',
      requiresContinuation: true,
      rulesSummary: 'Payme 1-20 bandlar',
      isActive: true,
    };
    programAlif6 = {
      id: 'prog-alif6',
      name: 'Alif 6 ойлик',
      requiresContinuation: false,
      rulesSummary: 'Alif 6 ойлик (ўтказиш талаб қилинмайди)',
      isActive: true,
    };
    db.programs.push(programPayme, programAlif6);
  });

  it('Stage 1 (Points 1–20): creates order and flags for handoff when not in exemption list', async () => {
    // 1–20 fields
    const order = await ordersService.createStage1Order36({
      sellerId: seller.id,
      programId: programPayme.id,
      storeId: store.id,
      contractEndDate: new Date(Date.now() + 180 * 24 * 3600 * 1000), // 4
      daftarRejected: false, // 5
      customer: { // 6–8, 12–13
        fullName: 'Алишер Усмонов',
        phone1: '+998901112233',
        phone2: '+998934445566',
        generalLimit: 2000000,
        withdrawableLimit: 1500000,
      },
      productPrice: 1500000, // 14
      agentPercentage: 20, // 15
      clientPayoutAmount: 1200000, // 16: 1500000 - 20%
      productName: 'iPhone 15 Pro — 1 ta', // 17
      imeiOrBarcode: '354890123456789', // 18
      quantity: 1, // 19
      daftarStatus: DaftarStatus.APPROVED, // 20
    });

    expect(order).toBeDefined();
    expect(order.checkNumber).toBeGreaterThan(0);
    expect(order.customer.fullName).toBe('Алишер Усмонов');
    expect(order.customer.phone1).toBe('+998901112233');
    expect(order.customer.phone2).toBe('+998934445566');
    expect(DecimalUtil.formatMoney(order.totalPrice)).toBe('1 500 000 UZS');
    expect(DecimalUtil.formatMoney(order.clientPayoutAmount)).toBe('1 200 000 UZS');
    expect(order.items[0].model).toBe('iPhone 15 Pro — 1 ta');
    expect(order.inventoryUnits[0].imei1).toBe('354890123456789');

    // Because Payme is NOT in ['Trust 1 (Ishonch)', 'Alif 6 ойлик', 'Alif Кодирака'],
    // it MUST require handoff to continuation operator:
    expect(order.program.requiresContinuation).toBe(true);
    expect(order.status).toBe(OrderStatus.READY_FOR_HANDOFF);
  });

  it('Stage 1 Exemption: Trust 1 / Alif 6 ойлик does not require continuation handoff', async () => {
    const order = await ordersService.createStage1Order36({
      sellerId: seller.id,
      programId: programAlif6.id,
      storeId: store.id,
      contractEndDate: new Date(Date.now() + 180 * 24 * 3600 * 1000),
      daftarRejected: false,
      customer: {
        fullName: 'Бобур Мирзо',
        phone1: '+998912223344',
        generalLimit: 1300000,
        withdrawableLimit: 1300000,
      },
      productPrice: 1300000,
      agentPercentage: 30,
      clientPayoutAmount: 910000,
      productName: 'Alif 6 ойлик — 1 ta',
      quantity: 1,
      daftarStatus: DaftarStatus.APPROVED,
    });

    expect(order.program.requiresContinuation).toBe(false);
    expect(order.status).toBe(OrderStatus.FIRST_STAGE_COMPLETED);
  });

  it('Stage 2 (Points 21–34) & Debt Settlement (Points 35–36)', async () => {
    // 1. Stage 1 Order
    const order = await ordersService.createStage1Order36({
      sellerId: seller.id,
      programId: programPayme.id,
      storeId: store.id,
      contractEndDate: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      daftarRejected: false,
      customer: {
        fullName: 'Жавлон Каримов',
        phone1: '+998905556677',
        generalLimit: 2000000,
        withdrawableLimit: 1800000,
      },
      productPrice: 1800000,
      agentPercentage: 15,
      clientPayoutAmount: 1530000,
      productName: 'Samsung Galaxy S24',
      quantity: 1,
      daftarStatus: DaftarStatus.APPROVED,
    });

    // 2. Stage 2 Sale (Points 21–34)
    const dueDate = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const sale = await salesService.createFullSale36({
      orderId: order.id,
      operatorId: operator.id, // 2nd stage continuation operator
      inventoryStatus: InventoryUnitStatus.SOLD, // 21
      buyer: { // 24–26
        fullName: 'Сардор Раҳимов',
        phone: '+998971112233',
        address: 'Малика бозори, 15-дўкон',
      },
      plannedSalePrice: 1800000, // 27
      actualSalePrice: 1800000, // 28
      paidAmount: 1000000, // 29
      paymentMethod: PaymentMethod.CASH, // 29
      hasDebt: true, // 30
      remainingAmount: 800000, // 31
      debtDueDate: dueDate, // 32
      paymentStatus: PaymentStatus.PARTIAL, // 34
    });

    expect(sale).toBeDefined();
    expect(DecimalUtil.formatMoney(sale.actualSalePrice)).toBe('1 800 000 UZS');
    expect(DecimalUtil.formatMoney(sale.paidAmount)).toBe('1 000 000 UZS');
    expect(DecimalUtil.formatMoney(sale.remainingAmount)).toBe('800 000 UZS');
    expect(sale.hasDebt).toBe(true);
    expect(sale.debtSchedules.length).toBe(1);
    expect(sale.debtSchedules[0].isSettled).toBe(false);

    // 3. Point 35: Active Debts list
    const debts = await debtsService.listActiveDebts(operator.id);
    const foundDebt = debts.find((d) => d.id === sale.id);
    expect(foundDebt).toBeDefined();
    expect(DecimalUtil.formatMoney(foundDebt!.remainingAmount)).toBe('800 000 UZS');

    // 4. Point 36: Settle remaining debt with UZS Card payment
    const payment = await paymentsService.recordPayment({
      saleId: sale.id,
      method: PaymentMethod.UZS_CARD,
      currency: Currency.UZS,
      originalAmount: 800000,
      createdById: operator.id,
    });

    expect(payment).toBeDefined();
    expect(payment.receiptNumber).toMatch(/^PAY-\d{4}-\d+$/);
    expect(DecimalUtil.formatMoney(payment.calculatedAmount)).toBe('800 000 UZS');

    // Verify sale is fully paid and debt settled
    const updatedSale = await salesService.getSaleById(sale.id);
    expect(DecimalUtil.formatMoney(updatedSale.remainingAmount)).toBe('0 UZS');
    expect(updatedSale.paymentStatus).toBe(PaymentStatus.PAID);
    expect(updatedSale.debtSchedules[0].isSettled).toBe(true);
  });
});
