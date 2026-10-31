import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, createMockPrismaService } from './test-utils';
import { OrdersService } from '../src/modules/orders/orders.service';
import { CustomersService } from '../src/modules/customers/customers.service';
import { FinancingProgramsService } from '../src/modules/financing-programs/financing-programs.service';
import { StoresService } from '../src/modules/stores/stores.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { SequenceService } from '../src/infrastructure/sequence/sequence.service';
import { AssignmentsService } from '../src/modules/assignments/assignments.service';
import { UsersService } from '../src/modules/users/users.service';
import { DaftarService } from '../src/modules/daftar/daftar.service';
import { OutboxService } from '../src/infrastructure/outbox/outbox.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import {
  OrderStatus,
  RoleName,
  AttachmentType,
  DaftarStatus,
} from '@prisma/client';
import { BadRequestException } from '@nestjs/common';

describe('Scenarios 1 - 5 (Stage 1 and Handoff Rules)', () => {
  let db: any;
  let prisma: any;
  let ordersService: OrdersService;
  let customersService: CustomersService;
  let programsService: FinancingProgramsService;
  let storesService: StoresService;
  let sequenceService: SequenceService;
  let auditService: AuditService;
  let assignmentsService: AssignmentsService;
  let usersService: UsersService;
  let daftarService: DaftarService;
  let outboxService: OutboxService;
  let redisService: RedisService;

  let seller: any;
  let operator: any;
  let store: any;
  let programTrust1: any;
  let programOther: any;
  let contractAttachment: any;
  let passportAttachment: any;

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
    daftarService = new DaftarService(prisma, usersService, auditService, outboxService);

    assignmentsService = new AssignmentsService(
      prisma,
      usersService,
      daftarService,
      auditService,
      outboxService,
      redisService,
    );

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

    // Setup users
    seller = await prisma.user.create({
      data: { telegramId: BigInt(1001), firstName: 'Seller 1', isActive: true, isApproved: true },
    });
    await prisma.userRole.create({ data: { userId: seller.id, roleId: 'role-seller' } });

    operator = await prisma.user.create({
      data: { telegramId: BigInt(1002), firstName: 'Operator 1', isActive: true, isApproved: true },
    });
    await prisma.userRole.create({ data: { userId: operator.id, roleId: 'role-operator' } });

    // Setup Store & Programs
    store = await prisma.store.create({
      data: { name: 'Малика Дўкон 12', address: 'Тошкент' },
    });

    programTrust1 = await prisma.financingProgram.create({
      data: { name: 'Trust 1 (Ishonch)', requiresContinuation: false, code: 'TRUST_1' },
    });

    programOther = await prisma.financingProgram.create({
      data: { name: 'Бошқа', requiresContinuation: true, code: 'OTHER' },
    });

    // Setup Attachments
    contractAttachment = await prisma.attachment.create({
      data: {
        type: AttachmentType.CONTRACT_SCREENSHOT,
        fileName: 'contract.png',
        mimeType: 'image/png',
        fileSize: 1024,
        storagePath: 'contracts/c1.png',
        createdById: seller.id,
      },
    });

    passportAttachment = await prisma.attachment.create({
      data: {
        type: AttachmentType.PASSPORT_PHOTO,
        fileName: 'passport.jpg',
        mimeType: 'image/jpeg',
        fileSize: 2048,
        storagePath: 'passports/p1.jpg',
        createdById: seller.id,
      },
    });
  });

  // 1. Сотувчи буюртма ва бир нечта товар қўшади.
  it('Scenario 1: Сотувчи буюртма ва бир нечта товар қўшади, нарх ва сони тўғри ҳисобланади', async () => {
    const order = await ordersService.submitStage1Order({
      sellerId: seller.id,
      programId: programOther.id,
      storeId: store.id,
      contractEndDate: '2026-12-31',
      daftarRejected: false,
      customer: {
        fullName: 'Алиев Вали',
        phone1: '+998901234567',
        generalLimit: 20000000,
        withdrawableLimit: 15000000,
      },
      agentPercentage: 5,
      clientPayoutAmount: 14000000,
      attachmentIds: [contractAttachment.id, passportAttachment.id],
      items: [
        {
          category: 'Телефон',
          brand: 'Samsung',
          model: 'Galaxy S24',
          quantity: 2,
          unitPrice: 5000000,
          devices: [
            { imei1: '123456789012345' },
            { imei1: '123456789012346' },
          ],
        },
        {
          category: 'Техника',
          brand: 'Artel',
          model: 'Muzlatgich',
          quantity: 1,
          unitPrice: 4000000,
          devices: [{ barcode: '4780001234567' }],
        },
      ],
    });

    expect(order).toBeDefined();
    expect(order.orderNumber).toMatch(/^ORD-2026-\d{6}$/);
    expect(order.totalQuantity).toBe(3); // 2 + 1
    // Total price = 2 * 5,000,000 + 1 * 4,000,000 = 14,000,000
    expect(order.totalPrice.toString()).toBe('14000000');
    expect(order.status).toBe(OrderStatus.AWAITING_DAFTAR);
  });

  // 2. Мажбурий файлсиз биринчи босқич якунланмайди.
  it('Scenario 2: Мажбурий файлсиз биринчи босқич якунланмайди (шартнома ёки паспортсиз хато)', async () => {
    // Missing passport photo
    await expect(
      ordersService.submitStage1Order({
        sellerId: seller.id,
        programId: programOther.id,
        storeId: store.id,
        contractEndDate: '2026-12-31',
        daftarRejected: false,
        customer: {
          fullName: 'Каримов Сардор',
          phone1: '+998901112233',
          generalLimit: 10000000,
          withdrawableLimit: 8000000,
        },
        agentPercentage: 5,
        clientPayoutAmount: 7500000,
        attachmentIds: [contractAttachment.id], // only contract, missing passport
        items: [
          {
            category: 'Телефон',
            brand: 'Xiaomi',
            model: 'Redmi Note 13',
            quantity: 1,
            unitPrice: 3000000,
            devices: [{ imei1: '987654321012345' }],
          },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // 3. Ечиладиган лимит умумий лимитдан ошмайди.
  it('Scenario 3: Ечиладиган лимит умумий лимитдан ошганда рад этилади', async () => {
    await expect(
      ordersService.submitStage1Order({
        sellerId: seller.id,
        programId: programOther.id,
        storeId: store.id,
        contractEndDate: '2026-12-31',
        daftarRejected: false,
        customer: {
          fullName: 'Темиров Умид',
          phone1: '+998909998877',
          generalLimit: 10000000,
          withdrawableLimit: 15000000, // Invalid: 15M > 10M!
        },
        agentPercentage: 5,
        clientPayoutAmount: 9000000,
        attachmentIds: [contractAttachment.id, passportAttachment.id],
        items: [
          {
            category: 'Телефон',
            brand: 'Apple',
            model: 'iPhone 15',
            quantity: 1,
            unitPrice: 9000000,
            devices: [{ imei1: '111222333444555' }],
          },
        ],
      }),
    ).rejects.toThrow('Ечиладиган лимит суммаси умумий лимитдан ошмаслиги керак');
  });

  // 4. Учта истисно дастурида ўтказиш тугмаси чиқмайди.
  it('Scenario 4: Trust 1 (requiresContinuation=false) дастурида 1-босқич FIRST_STAGE_COMPLETED бўлади ва операторга ўтказилмайди', async () => {
    const order = await ordersService.submitStage1Order({
      sellerId: seller.id,
      programId: programTrust1.id, // requiresContinuation = false
      storeId: store.id,
      contractEndDate: '2026-12-31',
      daftarRejected: false,
      customer: {
        fullName: 'Бобур Раҳимов',
        phone1: '+998935554433',
        generalLimit: 12000000,
        withdrawableLimit: 10000000,
      },
      agentPercentage: 5,
      clientPayoutAmount: 9500000,
      attachmentIds: [contractAttachment.id, passportAttachment.id],
      items: [
        {
          category: 'Техника',
          brand: 'Samsung',
          model: 'Kir yuvish mashinasi',
          quantity: 1,
          unitPrice: 7000000,
          devices: [{ barcode: '8800011223344' }],
        },
      ],
    });

    expect(order.status).toBe(OrderStatus.FIRST_STAGE_COMPLETED);

    // Attempting to assign should be rejected
    await expect(
      assignmentsService.assignOrder(order.id, operator.id, seller.id),
    ).rejects.toThrow('кўзда тутилмаган (requiresContinuation=false)');
  });

  // 5. Бошқа дастурда буюртма операторга ўтади.
  it('Scenario 5: Бошқа дастурда (requiresContinuation=true) дафтар тасдиғидан сўнг буюртма операторга бириктирилади', async () => {
    const order = await ordersService.submitStage1Order({
      sellerId: seller.id,
      programId: programOther.id,
      storeId: store.id,
      contractEndDate: '2026-12-31',
      daftarRejected: false,
      customer: {
        fullName: 'Жасур Алимов',
        phone1: '+998971110022',
        generalLimit: 25000000,
        withdrawableLimit: 20000000,
      },
      agentPercentage: 5,
      clientPayoutAmount: 18000000,
      attachmentIds: [contractAttachment.id, passportAttachment.id],
      items: [
        {
          category: 'Телефон',
          brand: 'Apple',
          model: 'iPhone 15 Pro',
          quantity: 1,
          unitPrice: 15000000,
          devices: [{ imei1: '358999123456789' }],
        },
      ],
    });

    expect(order.status).toBe(OrderStatus.AWAITING_DAFTAR);

    // Setup reviewer and approve
    const reviewer = await prisma.user.create({
      data: { telegramId: BigInt(1003), firstName: 'Reviewer', isActive: true, isApproved: true },
    });
    db.roles.push({ id: 'role-reviewer', name: RoleName.DAFTAR_REVIEWER });
    await prisma.userRole.create({ data: { userId: reviewer.id, roleId: 'role-reviewer' } });

    await daftarService.updateReviewStatus({
      orderId: order.id,
      reviewerId: reviewer.id,
      status: DaftarStatus.APPROVED,
    });

    // Assign to operator
    const assignment = await assignmentsService.assignOrder(order.id, operator.id, seller.id);
    expect(assignment).toBeDefined();

    const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updatedOrder.status).toBe(OrderStatus.ASSIGNED);
  });
});
