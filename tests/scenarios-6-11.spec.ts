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
import { SalesService } from '../src/modules/sales/sales.service';
import { DebtsService } from '../src/modules/debts/debts.service';
import { OutboxService } from '../src/infrastructure/outbox/outbox.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import {
  OrderStatus,
  RoleName,
  AttachmentType,
  DaftarStatus,
  InventoryUnitStatus,
} from '@prisma/client';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

describe('Scenarios 6 - 11 (Daftar, Assignment Concurrency, Scoped Access & Inventory Sales)', () => {
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
  let salesService: SalesService;
  let debtsService: DebtsService;
  let outboxService: OutboxService;
  let redisService: RedisService;

  let seller: any;
  let operator1: any;
  let operator2: any;
  let reviewer: any;
  let store: any;
  let program: any;
  let order: any;

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

    salesService = new SalesService(prisma, usersService, customersService, auditService);
    debtsService = new DebtsService(prisma, usersService, auditService);

    db.roles.push(
      { id: 'role-seller', name: RoleName.SELLER },
      { id: 'role-operator', name: RoleName.CONTINUATION_OPERATOR },
      { id: 'role-reviewer', name: RoleName.DAFTAR_REVIEWER },
      { id: 'role-admin', name: RoleName.SUPER_ADMIN },
    );

    seller = await prisma.user.create({
      data: { telegramId: BigInt(2001), firstName: 'Seller', isActive: true, isApproved: true },
    });
    await prisma.userRole.create({ data: { userId: seller.id, roleId: 'role-seller' } });

    operator1 = await prisma.user.create({
      data: { telegramId: BigInt(2002), firstName: 'Operator 1', isActive: true, isApproved: true },
    });
    await prisma.userRole.create({ data: { userId: operator1.id, roleId: 'role-operator' } });

    operator2 = await prisma.user.create({
      data: { telegramId: BigInt(2003), firstName: 'Operator 2', isActive: true, isApproved: true },
    });
    await prisma.userRole.create({ data: { userId: operator2.id, roleId: 'role-operator' } });

    reviewer = await prisma.user.create({
      data: { telegramId: BigInt(2004), firstName: 'Reviewer', isActive: true, isApproved: true },
    });
    await prisma.userRole.create({ data: { userId: reviewer.id, roleId: 'role-reviewer' } });

    store = await prisma.store.create({ data: { name: 'Малика', address: 'Тошкент' } });
    program = await prisma.financingProgram.create({
      data: { name: 'Бошқа', requiresContinuation: true },
    });

    const att1 = await prisma.attachment.create({
      data: { type: AttachmentType.CONTRACT_SCREENSHOT, fileName: 'c.png', mimeType: 'image/png', fileSize: 10, storagePath: 'p1', createdById: seller.id },
    });
    const att2 = await prisma.attachment.create({
      data: { type: AttachmentType.PASSPORT_PHOTO, fileName: 'p.jpg', mimeType: 'image/jpeg', fileSize: 10, storagePath: 'p2', createdById: seller.id },
    });

    order = await ordersService.submitStage1Order({
      sellerId: seller.id,
      programId: program.id,
      storeId: store.id,
      contractEndDate: '2026-12-31',
      daftarRejected: false,
      customer: {
        fullName: 'Каримов Олим',
        phone1: '+998901230000',
        generalLimit: 30000000,
        withdrawableLimit: 25000000,
      },
      agentPercentage: 5,
      clientPayoutAmount: 20000000,
      attachmentIds: [att1.id, att2.id],
      items: [
        {
          category: 'Телефон',
          brand: 'Apple',
          model: 'iPhone 15',
          quantity: 2,
          unitPrice: 10000000,
          devices: [
            { imei1: '111111111111111' },
            { imei1: '222222222222222' },
          ],
        },
      ],
    });
  });

  // 6. «Надо исправить» сабабсиз сақланмайди.
  it('Scenario 6: «Надо исправить» статуси сабабсиз сақланмайди', async () => {
    await expect(
      daftarService.updateReviewStatus({
        orderId: order.id,
        reviewerId: reviewer.id,
        status: DaftarStatus.NEEDS_CORRECTION,
        comment: '', // Missing reason!
      }),
    ).rejects.toThrow('«Надо исправить» статуси танланганда сабаб (изоҳ) киритилиши шарт');
  });

  // 7. Кутилаётган дафтар тасдиғи ўтказишни блоклайди.
  it('Scenario 7: Кутилаётган дафтар тасдиғи («В ожидании») операторга ўтказишни блоклайди', async () => {
    // Current status is PENDING
    await expect(
      assignmentsService.assignOrder(order.id, operator1.id, seller.id),
    ).rejects.toThrow('Буюртмани ўтказиш мумкин эмас: Дафтар тасдиғи');
  });

  // 8. Икки марта қабул қилиш фақат битта натижа беради.
  it('Scenario 8: Икки марта қабул қилиш фақат битта натижа беради (идемпотентлик / пойга хавфсизлиги)', async () => {
    // Approve order first
    await daftarService.updateReviewStatus({
      orderId: order.id,
      reviewerId: reviewer.id,
      status: DaftarStatus.APPROVED,
    });

    // Assign to operator1
    await assignmentsService.assignOrder(order.id, operator1.id, seller.id);

    // First acceptance succeeds
    const accepted1 = await assignmentsService.acceptAssignment(order.id, operator1.id);
    expect(accepted1.status).toBe(OrderStatus.IN_PROGRESS);

    // Second acceptance on already accepted order throws error without corrupting state
    await expect(
      assignmentsService.acceptAssignment(order.id, operator1.id),
    ).rejects.toThrow('Буюртмани қабул қилиб бўлмайди. Жорий ҳолат: IN_PROGRESS');
  });

  // 9. Оператор бошқа оператор қарзини ID билан очолмайди.
  it('Scenario 9: Оператор бошқа оператор буюртмаси/қарзини ID билан очолмайди', async () => {
    // Approve and assign to operator1
    await daftarService.updateReviewStatus({
      orderId: order.id,
      reviewerId: reviewer.id,
      status: DaftarStatus.APPROVED,
    });
    await assignmentsService.assignOrder(order.id, operator1.id, seller.id);
    await assignmentsService.acceptAssignment(order.id, operator1.id);

    // Get units
    const units = db.inventoryUnits.filter((u: any) => u.orderId === order.id);

    // Operator1 records a sale with debt
    const sale = await salesService.createSale({
      orderId: order.id,
      operatorId: operator1.id,
      buyer: { fullName: 'Харидор 1', phone: '+998909876543' },
      plannedSalePrice: 10000000,
      actualSalePrice: 10000000,
      items: [{ inventoryUnitId: units[0].id, unitPrice: 10000000 }],
      debtDueDate: new Date('2026-11-20'),
    });

    // Operator2 attempts to open operator1's debt by saleId
    await expect(
      debtsService.getDebtDetails(sale.id, operator2.id),
    ).rejects.toThrow('Сизга ушбу операторнинг қарзини кўришга рухсат берилмаган');
  });

  // 10. Бир буюртманинг бир қисми сотилади.
  it('Scenario 10: Бир буюртманинг бир қисми сотилади (қисман сотув)', async () => {
    await daftarService.updateReviewStatus({
      orderId: order.id,
      reviewerId: reviewer.id,
      status: DaftarStatus.APPROVED,
    });
    await assignmentsService.assignOrder(order.id, operator1.id, seller.id);
    await assignmentsService.acceptAssignment(order.id, operator1.id);

    const units = db.inventoryUnits.filter((u: any) => u.orderId === order.id);
    expect(units.length).toBe(2);

    // Sell only the first unit (partial sale)
    const sale1 = await salesService.createSale({
      orderId: order.id,
      operatorId: operator1.id,
      buyer: { fullName: 'Биринчи Харидор', phone: '+998911112233' },
      plannedSalePrice: 10000000,
      actualSalePrice: 10000000,
      items: [{ inventoryUnitId: units[0].id, unitPrice: 10000000 }],
      debtDueDate: new Date('2026-11-25'),
    });

    expect(sale1).toBeDefined();
    // Unit 0 should be SOLD, Unit 1 should remain IN_STOCK
    const refreshedUnit0 = db.inventoryUnits.find((u: any) => u.id === units[0].id);
    const refreshedUnit1 = db.inventoryUnits.find((u: any) => u.id === units[1].id);

    expect(refreshedUnit0.status).toBe(InventoryUnitStatus.SOLD);
    expect(refreshedUnit1.status).toBe(InventoryUnitStatus.IN_STOCK);
  });

  // 11. Бир товар икки марта сотилмайди.
  it('Scenario 11: Бир товар икки марта сотилмайди (аллақачон сотилган товарни сотиш рад этилади)', async () => {
    await daftarService.updateReviewStatus({
      orderId: order.id,
      reviewerId: reviewer.id,
      status: DaftarStatus.APPROVED,
    });
    await assignmentsService.assignOrder(order.id, operator1.id, seller.id);
    await assignmentsService.acceptAssignment(order.id, operator1.id);

    const units = db.inventoryUnits.filter((u: any) => u.orderId === order.id);

    // First sale of unit 0
    await salesService.createSale({
      orderId: order.id,
      operatorId: operator1.id,
      buyer: { fullName: 'Харидор А', phone: '+998901112233' },
      plannedSalePrice: 10000000,
      actualSalePrice: 10000000,
      items: [{ inventoryUnitId: units[0].id, unitPrice: 10000000 }],
      debtDueDate: new Date('2026-11-25'),
    });

    // Attempting to sell unit 0 again must fail
    await expect(
      salesService.createSale({
        orderId: order.id,
        operatorId: operator1.id,
        buyer: { fullName: 'Харидор Б', phone: '+998904445566' },
        plannedSalePrice: 10000000,
        actualSalePrice: 10000000,
        items: [{ inventoryUnitId: units[0].id, unitPrice: 10000000 }],
        debtDueDate: new Date('2026-11-25'),
      }),
    ).rejects.toThrow('Товар аллақачон сотилган! Бир товар икки марта сотилмайди');
  });
});
