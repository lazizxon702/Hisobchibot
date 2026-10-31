import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, createMockPrismaService } from './test-utils';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { SalesService } from '../src/modules/sales/sales.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { UsersService } from '../src/modules/users/users.service';
import { CustomersService } from '../src/modules/customers/customers.service';
import { FinancingProgramsService } from '../src/modules/financing-programs/financing-programs.service';
import { StoresService } from '../src/modules/stores/stores.service';
import { AttachmentsService } from '../src/modules/attachments/attachments.service';
import { StorageService } from '../src/infrastructure/storage/storage.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { SequenceService } from '../src/infrastructure/sequence/sequence.service';
import { OutboxService } from '../src/infrastructure/outbox/outbox.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import {
  PaymentMethod,
  Currency,
  PaymentStatus,
  RoleName,
  AttachmentType,
  TransactionStatus,
} from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';

describe('Scenarios 17 - 21 (Reversals, Debt Settlement, Draft Persistence & Privacy)', () => {
  let db: any;
  let prisma: any;
  let paymentsService: PaymentsService;
  let salesService: SalesService;
  let ordersService: OrdersService;
  let usersService: UsersService;
  let customersService: CustomersService;
  let programsService: FinancingProgramsService;
  let storesService: StoresService;
  let attachmentsService: AttachmentsService;
  let storageService: StorageService;
  let auditService: AuditService;
  let sequenceService: SequenceService;
  let outboxService: OutboxService;
  let redisService: RedisService;

  let admin: any;
  let seller: any;
  let operator: any;
  let otherOperator: any;
  let sale: any;

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
    storageService = new StorageService();
    attachmentsService = new AttachmentsService(prisma, storageService, usersService);

    paymentsService = new PaymentsService(
      prisma,
      sequenceService,
      usersService,
      auditService,
      outboxService,
      redisService,
    );

    salesService = new SalesService(prisma, usersService, customersService, auditService);
    ordersService = new OrdersService(
      prisma,
      sequenceService,
      customersService,
      programsService,
      storesService,
      auditService,
    );

    db.roles.push(
      { id: 'role-admin', name: RoleName.SUPER_ADMIN },
      { id: 'role-seller', name: RoleName.SELLER },
      { id: 'role-operator', name: RoleName.CONTINUATION_OPERATOR },
    );

    admin = await prisma.user.create({
      data: { telegramId: BigInt(4001), firstName: 'Admin', isActive: true, isApproved: true },
    });
    await prisma.userRole.create({ data: { userId: admin.id, roleId: 'role-admin' } });

    seller = await prisma.user.create({
      data: { telegramId: BigInt(4002), firstName: 'Seller', isActive: true, isApproved: true },
    });
    await prisma.userRole.create({ data: { userId: seller.id, roleId: 'role-seller' } });

    operator = await prisma.user.create({
      data: { telegramId: BigInt(4003), firstName: 'Operator', isActive: true, isApproved: true },
    });
    await prisma.userRole.create({ data: { userId: operator.id, roleId: 'role-operator' } });

    otherOperator = await prisma.user.create({
      data: { telegramId: BigInt(4004), firstName: 'Other Op', isActive: true, isApproved: true },
    });
    await prisma.userRole.create({ data: { userId: otherOperator.id, roleId: 'role-operator' } });

    const cust = await prisma.customer.create({
      data: { fullName: 'Mijoz 2', phone1: '+998909990011', generalLimit: 15000000, withdrawableLimit: 15000000 },
    });
    const store = await prisma.store.create({ data: { name: 'Store 2', address: 'Tashkent' } });
    const prog = await prisma.financingProgram.create({ data: { name: 'Prog 2', requiresContinuation: true } });

    const order = await prisma.order.create({
      data: {
        orderNumber: 'ORD-2026-000100',
        sellerId: seller.id,
        programId: prog.id,
        storeId: store.id,
        customerId: cust.id,
        contractEndDate: new Date('2026-12-31'),
        agentPercentage: 5,
        clientPayoutAmount: 10000000,
        totalPrice: 10000000,
        totalQuantity: 1,
        businessDate: new Date(),
      },
    });

    await prisma.orderAssignment.create({
      data: { orderId: order.id, operatorId: operator.id, assignedBy: seller.id, status: 'ACCEPTED' },
    });

    const oItem = await prisma.orderItem.create({
      data: { orderId: order.id, category: 'Telefon', brand: 'Xiaomi', model: '14', quantity: 1, unitPrice: 10000000, totalPrice: 10000000 },
    });

    const unit = await prisma.inventoryUnit.create({
      data: { orderId: order.id, orderItemId: oItem.id, category: 'Telefon', imei1: '123123123123123' },
    });

    sale = await salesService.createSale({
      orderId: order.id,
      operatorId: operator.id,
      buyer: { fullName: 'Харидор 2', phone: '+998909990022' },
      plannedSalePrice: 10000000,
      actualSalePrice: 10000000,
      items: [{ inventoryUnitId: unit.id, unitPrice: 10000000 }],
      debtDueDate: new Date('2026-12-10'),
    });
  });

  // 17. Reversal молиявий тарихни сақлаб қолдиқни тиклайди.
  it('Scenario 17: Reversal молиявий тарихни сақлаб қолдиқни тиклайди (тўлов ўчирилмайди, статус янгиланади)', async () => {
    // Make payment of 4,000,000
    const payment = await paymentsService.recordPayment({
      saleId: sale.id,
      method: PaymentMethod.CASH,
      currency: Currency.UZS,
      originalAmount: 4000000,
      createdById: operator.id,
    });

    let updatedSale = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(updatedSale.remainingAmount.toString()).toBe('6000000');

    // Admin reverses the payment
    const reversal = await paymentsService.reversePayment({
      paymentId: payment.id,
      adminId: admin.id,
      reason: 'Клиент хато сумма ўтказганлиги сабабли бекор қилинди',
    });

    expect(reversal).toBeDefined();

    // The payment record is NEVER deleted!
    const reversedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(reversedPayment).toBeDefined();
    expect(reversedPayment.status).toBe(TransactionStatus.REVERSED);

    // Sale remaining amount restored back to 10,000,000
    updatedSale = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(updatedSale.paidAmount.toString()).toBe('0');
    expect(updatedSale.remainingAmount.toString()).toBe('10000000');
    expect(updatedSale.paymentStatus).toBe(PaymentStatus.DEBT);
  });

  // 18. Қарз ёпилганда статус янгиланади ва эслатма бекор бўлади.
  it('Scenario 18: Қарз тўлиқ тўланганда статус «Оплачено» бўлади ва эслатмалар бекор қилинади', async () => {
    // Add an active reminder for this sale
    await prisma.reminder.create({
      data: {
        saleId: sale.id,
        type: 'ONE_DAY_BEFORE',
        scheduledFor: new Date('2026-12-09'),
        isCancelled: false,
      },
    });

    // Pay full 10,000,000
    await paymentsService.recordPayment({
      saleId: sale.id,
      method: PaymentMethod.CASH,
      currency: Currency.UZS,
      originalAmount: 10000000,
      createdById: operator.id,
    });

    const updatedSale = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(updatedSale.remainingAmount.toString()).toBe('0');
    expect(updatedSale.paymentStatus).toBe(PaymentStatus.PAID);
    expect(updatedSale.hasDebt).toBe(false);

    // Active reminders must be cancelled
    const reminders = await prisma.reminder.findMany({ where: { saleId: sale.id } });
    expect(reminders.every((r: any) => r.isCancelled === true)).toBe(true);

    // Debt schedules must be marked settled
    const schedules = await prisma.debtSchedule.findMany({ where: { saleId: sale.id } });
    expect(schedules.every((s: any) => s.isSettled === true)).toBe(true);
  });

  // 19. Сервер қайта ишга тушганда қоралама тикланади.
  it('Scenario 19: Сервер қайта ишга тушганда ёки Redis тозаланганда қоралама PostgreSQL’дан тикланади', async () => {
    // Save draft in PostgreSQL
    const formData = {
      customerName: 'Нодирбек',
      customerPhone: '+998901234567',
      selectedProgram: 'Alif 6 ойлик',
      step: 'STEP_CUSTOMER_LIMIT',
    };

    await ordersService.saveDraft(seller.id, 'STEP_CUSTOMER_LIMIT', formData);

    // Simulate server restart by creating new OrdersService instance with same database
    const newOrdersService = new OrdersService(
      prisma,
      sequenceService,
      customersService,
      programsService,
      storesService,
      auditService,
    );

    const restoredDraft = await newOrdersService.getDraft(seller.id);
    expect(restoredDraft).toBeDefined();
    expect(restoredDraft?.step).toBe('STEP_CUSTOMER_LIMIT');
    expect(restoredDraft?.formData.customerName).toBe('Нодирбек');
  });

  // 20. Рухсатсиз паспорт файли очилмайди.
  it('Scenario 20: Рухсатсиз ходим клиентнинг паспорти фотосини оча олмайди (ҳимояланган)', async () => {
    // Create passport attachment uploaded by seller
    const passportAtt = await prisma.attachment.create({
      data: {
        type: AttachmentType.PASSPORT_PHOTO,
        fileName: 'passport_scan.jpg',
        mimeType: 'image/jpeg',
        fileSize: 5000,
        storagePath: 'secure/passports/scan.jpg',
        createdById: seller.id,
      },
    });

    // Unrelated operator attempts to access passport photo -> must throw ForbiddenException
    await expect(
      attachmentsService.getAttachmentAccess(passportAtt.id, otherOperator.id),
    ).rejects.toThrow(ForbiddenException);

    // Admin CAN access
    const adminAccess = await attachmentsService.getAttachmentAccess(passportAtt.id, admin.id);
    expect(adminAccess).toBeDefined();

    // Seller who uploaded CAN access
    const sellerAccess = await attachmentsService.getAttachmentAccess(passportAtt.id, seller.id);
    expect(sellerAccess).toBeDefined();
  });

  // 21. Telegram билдиришномаси хатоси сақланган операцияни бузмайди.
  it('Scenario 21: Telegram хабари юбориш хатоси сақланган молиявий тўловни бузмайди (Transactional Outbox)', async () => {
    // Record payment
    const payment = await paymentsService.recordPayment({
      saleId: sale.id,
      method: PaymentMethod.CASH,
      currency: Currency.UZS,
      originalAmount: 2000000,
      createdById: operator.id,
    });

    // Payment is safely committed in DB
    const savedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(savedPayment).toBeDefined();
    expect(savedPayment.status).toBe(TransactionStatus.CONFIRMED);

    // An outbox event was created in the same transaction
    const outboxEvents = await outboxService.getPendingEvents(10);
    const notificationEvent = outboxEvents.find((e) => e.topic === 'telegram_notification');
    expect(notificationEvent).toBeDefined();

    // Simulate Telegram network failure during outbox processing
    await outboxService.markFailed(notificationEvent!.id, 'Telegram API network timeout (ETIMEDOUT)');

    // The payment remains completely intact and valid in the DB!
    const refreshedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(refreshedPayment.status).toBe(TransactionStatus.CONFIRMED);

    const refreshedSale = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(refreshedSale.paidAmount.toString()).toBe('2000000');
    expect(refreshedSale.remainingAmount.toString()).toBe('8000000');
  });
});
