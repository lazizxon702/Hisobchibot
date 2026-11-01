import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SequenceService } from '../../infrastructure/sequence/sequence.service';
import { CustomersService } from '../customers/customers.service';
import { FinancingProgramsService } from '../financing-programs/financing-programs.service';
import { StoresService } from '../stores/stores.service';
import { AuditService } from '../audit/audit.service';
import { DecimalUtil } from '../../common/decimal.util';
import { DateUtil } from '../../common/date.util';
import { SubmitOrderDto } from './dto/create-order.dto';
import {
  OrderStatus,
  DaftarStatus,
  InventoryUnitStatus,
  RoleName,
  AttachmentType,
} from '@prisma/client';
import { Decimal } from 'decimal.js';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sequence: SequenceService,
    private readonly customersService: CustomersService,
    private readonly programsService: FinancingProgramsService,
    private readonly storesService: StoresService,
    private readonly audit: AuditService,
  ) {}

  // ===================== DRAFTS (PostgreSQL Persisted) =====================

  async saveDraft(userId: string, step: string, formData: any) {
    return this.prisma.orderDraft.upsert({
      where: { userId },
      update: { step, formData, updatedAt: new Date() },
      create: { userId, step, formData },
    });
  }

  async getDraft(userId: string) {
    return this.prisma.orderDraft.findUnique({
      where: { userId },
    });
  }

  async clearDraft(userId: string) {
    await this.prisma.orderDraft.deleteMany({ where: { userId } });
  }

  // ===================== ORDER CREATION (Stage 1) =====================

  async submitStage1Order(dto: SubmitOrderDto) {
    // 1. Validate mandatory items
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('Камида 1 та маҳсулот қўшилиши шарт');
    }

    // 2. Validate mandatory attachments (Test 2)
    const attachments = await this.prisma.attachment.findMany({
      where: { id: { in: dto.attachmentIds } },
    });

    const hasContractScreenshot = attachments.some(
      (a) => a.type === AttachmentType.CONTRACT_SCREENSHOT,
    );
    const hasPassportPhoto = attachments.some(
      (a) => a.type === AttachmentType.PASSPORT_PHOTO,
    );

    if (!hasContractScreenshot) {
      throw new BadRequestException('Шартнома скриншоти мажбурий (камида 1 та)');
    }
    if (!hasPassportPhoto) {
      throw new BadRequestException('Клиентнинг паспорт билан тушган фотоси мажбурий');
    }

    // 3. Validate Program & Store
    const program = await this.programsService.getById(dto.programId);
    await this.storesService.getById(dto.storeId);

    // 4. Validate Contract End Date
    const endDate =
      dto.contractEndDate instanceof Date
        ? dto.contractEndDate
        : DateUtil.parseToUtcDate(dto.contractEndDate);
    if (!endDate) {
      throw new BadRequestException('Шартнома тугаш санаси нотўғри кўрсатилган');
    }

    // 5. Customer Limits Validation (Test 3)
    const customer = await this.customersService.createOrUpdateCustomer(dto.customer);

    // 6. Calculate total price and total quantity automatically
    let calculatedTotalPrice = new Decimal(0);
    let calculatedTotalQty = 0;

    for (const item of dto.items) {
      if (item.quantity <= 0) {
        throw new BadRequestException(`Маҳсулот сони нолдан катта бўлиши керак (${item.model})`);
      }
      const uPrice = DecimalUtil.toDecimal(item.unitPrice);
      if (!DecimalUtil.isPositive(uPrice)) {
        throw new BadRequestException(`Прайс нархи нолдан катта бўлиши керак (${item.model})`);
      }
      const itemRowTotal = DecimalUtil.mul(uPrice, item.quantity);
      calculatedTotalPrice = DecimalUtil.add(calculatedTotalPrice, itemRowTotal);
      calculatedTotalQty += item.quantity;
    }

    // 7. Validate Agent Percentage & Client Payout
    const agentPct = DecimalUtil.toDecimal(dto.agentPercentage);
    if (DecimalUtil.isLessThan(agentPct, 0) || DecimalUtil.isGreaterThan(agentPct, 100)) {
      throw new BadRequestException('Агент фоизи 0 ва 100 оралиғида бўлиши керак');
    }
    const clientPayout = DecimalUtil.toDecimal(dto.clientPayoutAmount);
    if (DecimalUtil.isLessThan(clientPayout, 0)) {
      throw new BadRequestException('Клиентга бериладиган сумма манфий бўлиши мумкин эмас');
    }

    // 8. Generate unique human-readable Order Number (no MAX+1 race condition)
    const orderNumber = await this.sequence.generateOrderNumber();

    // 9. Initial order status based on requiresContinuation (Section 6)
    const initialStatus = program.requiresContinuation
      ? OrderStatus.AWAITING_DAFTAR
      : OrderStatus.FIRST_STAGE_COMPLETED;

    // 10. Execute Transaction
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          orderNumber,
          version: 1,
          status: initialStatus,
          sellerId: dto.sellerId,
          programId: dto.programId,
          storeId: dto.storeId,
          customerId: customer.id,
          contractEndDate: endDate,
          daftarRejected: dto.daftarRejected ?? false,
          agentPercentage: agentPct,
          clientPayoutAmount: clientPayout,
          totalPrice: calculatedTotalPrice,
          totalQuantity: calculatedTotalQty,
          businessDate: dto.businessDate || new Date(),
        },
      });

      // Link attachments to this order
      await tx.attachment.updateMany({
        where: { id: { in: dto.attachmentIds } },
        data: { orderId: order.id },
      });

      // Create Order Items and physical Inventory Units
      for (const item of dto.items) {
        const itemUnitPrice = DecimalUtil.toDecimal(item.unitPrice);
        const itemRowTotal = DecimalUtil.mul(itemUnitPrice, item.quantity);

        const createdItem = await tx.orderItem.create({
          data: {
            orderId: order.id,
            category: item.category,
            brand: item.brand,
            model: item.model,
            characteristics: item.characteristics,
            quantity: item.quantity,
            unitPrice: itemUnitPrice,
            totalPrice: itemRowTotal,
          },
        });

        // Create individual physical inventory units
        const deviceList = item.devices || [];
        for (let i = 0; i < item.quantity; i++) {
          const dev = deviceList[i] || {};

          // If phone, check IMEI format (15 digits)
          if (item.category.toLowerCase().includes('телефон') && dev.imei1) {
            const cleanImei = dev.imei1.replace(/\s+/g, '');
            if (!/^\d{15}$/.test(cleanImei)) {
              throw new BadRequestException(`IMEI рақами 15 та рақамдан иборат бўлиши керак: ${dev.imei1}`);
            }
          }

          // Check unique IMEI / serial
          if (dev.imei1) {
            const existingImei = await tx.inventoryUnit.findFirst({
              where: { imei1: dev.imei1 },
            });
            if (existingImei) {
              throw new BadRequestException(`Ушбу IMEI тизимда аввал рўйхатга олинган: ${dev.imei1}`);
            }
          }

          await tx.inventoryUnit.create({
            data: {
              orderId: order.id,
              orderItemId: createdItem.id,
              category: item.category,
              imei1: dev.imei1,
              imei2: dev.imei2,
              barcode: dev.barcode,
              serialNumber: dev.serialNumber,
              status: InventoryUnitStatus.IN_STOCK,
            },
          });
        }
      }

      // Create initial Daftar review record
      await tx.daftarReview.create({
        data: {
          orderId: order.id,
          status: DaftarStatus.PENDING,
        },
      });

      // Clear user's draft upon successful submission
      await tx.orderDraft.deleteMany({ where: { userId: dto.sellerId } });

      await this.audit.log(
        {
          entityName: 'Order',
          entityId: order.id,
          action: 'ORDER_STAGE_1_CREATED',
          performedById: dto.sellerId,
          newValue: {
            orderNumber: order.orderNumber,
            status: order.status,
            totalPrice: order.totalPrice.toString(),
            totalQuantity: order.totalQuantity,
          },
        },
        tx,
      );

      return order;
    });
  }

  // ===================== QUICK CHECK WIZARD ORDER =====================

  async createQuickCheckOrder(dto: {
    sellerId: string;
    programId: string;
    storeId: string;
    agencyId?: string | null;
    agencyEmployeeId?: string | null;
    limitAmount: string | number | Decimal;
    foiz: number;
    productName?: string | null;
  }) {
    const limit = DecimalUtil.toDecimal(dto.limitAmount);
    const foiz = new Decimal(dto.foiz);
    const feeAmount = DecimalUtil.mul(limit, DecimalUtil.div(foiz, 100));
    const calculatedAmount = DecimalUtil.sub(limit, feeAmount);

    const orderNumber = await this.sequence.generateOrderNumber();
    const checkNumber = await this.sequence.generateCheckNumber();

    return this.prisma.$transaction(async (tx) => {
      const seller = await tx.user.findUnique({
        where: { id: dto.sellerId },
      });
      if (!seller) {
        throw new NotFoundException(`Сотувчи топилмади: ${dto.sellerId}`);
      }

      const program = await tx.financingProgram.findUnique({
        where: { id: dto.programId },
      });
      if (!program) {
        throw new NotFoundException(`Дастур топилмади: ${dto.programId}`);
      }

      const store = await tx.store.findUnique({
        where: { id: dto.storeId },
      });
      if (!store) {
        throw new NotFoundException(`Дўкон топилмади: ${dto.storeId}`);
      }

      // Customer associated with this check
      const customerPhone = seller.phone || `+998${seller.telegramId}`;
      const sellerFullName = [seller.firstName, seller.lastName].filter(Boolean).join(' ') || 'Савдочи';
      let customer = await tx.customer.findFirst({
        where: { phone1: customerPhone },
      });

      if (!customer) {
        customer = await tx.customer.create({
          data: {
            fullName: sellerFullName,
            phone1: customerPhone,
            generalLimit: limit,
            withdrawableLimit: limit,
          },
        });
      } else {
        customer = await tx.customer.update({
          where: { id: customer.id },
          data: {
            generalLimit: limit,
            withdrawableLimit: limit,
          },
        });
      }

      const prodName = dto.productName || `${program.name} — 1 та`;

      const order = await tx.order.create({
        data: {
          orderNumber,
          checkNumber,
          omborStatus: 'Tasdiqlash kutilmoqda',
          productName: prodName,
          sellerId: dto.sellerId,
          programId: dto.programId,
          storeId: dto.storeId,
          customerId: customer.id,
          agencyId: dto.agencyId || null,
          agencyEmployeeId: dto.agencyEmployeeId || null,
          contractEndDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          daftarRejected: false,
          agentPercentage: foiz,
          clientPayoutAmount: calculatedAmount,
          totalPrice: limit,
          totalQuantity: 1,
          businessDate: new Date(),
          status: OrderStatus.READY_FOR_HANDOFF,
        },
      });

      const item = await tx.orderItem.create({
        data: {
          orderId: order.id,
          category: program.name,
          brand: program.name,
          model: prodName,
          quantity: 1,
          unitPrice: limit,
          totalPrice: limit,
        },
      });

      await tx.inventoryUnit.create({
        data: {
          orderId: order.id,
          orderItemId: item.id,
          category: program.name,
          status: InventoryUnitStatus.IN_STOCK,
        },
      });

      await tx.daftarReview.create({
        data: {
          orderId: order.id,
          status: DaftarStatus.APPROVED,
          comment: 'Автоматик чек орқали тасдиқланди',
          reviewedAt: new Date(),
        },
      });

      await tx.orderDraft.deleteMany({ where: { userId: dto.sellerId } });

      await this.audit.log(
        {
          entityName: 'Order',
          entityId: order.id,
          action: 'QUICK_CHECK_CREATED',
          performedById: dto.sellerId,
          newValue: {
            checkNumber,
            orderNumber,
            totalPrice: limit.toString(),
            calculatedAmount: calculatedAmount.toString(),
          },
        },
        tx,
      );

      return tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: {
          seller: true,
          program: true,
          store: true,
          agency: true,
          agencyEmployee: true,
          customer: true,
          items: true,
        },
      });
    });
  }

  // ===================== FULL STAGE 1 (1–20 POINTS) WIZARD ORDER =====================

  async createStage1Order36(dto: {
    sellerId: string;
    programId: string;
    storeId: string;
    agencyId?: string | null;
    agencyEmployeeId?: string | null;
    contractEndDate: Date;
    daftarRejected: boolean;
    customer: {
      fullName: string;
      phone1: string;
      phone2?: string | null;
      generalLimit: string | number | Decimal;
      withdrawableLimit: string | number | Decimal;
    };
    productPrice: string | number | Decimal;
    agentPercentage: number;
    clientPayoutAmount: string | number | Decimal;
    productName: string;
    imeiOrBarcode?: string | null;
    quantity: number;
    daftarStatus: DaftarStatus;
    attachmentIds?: string[];
  }) {
    const totalPrice = DecimalUtil.toDecimal(dto.productPrice);
    const foiz = new Decimal(dto.agentPercentage);
    const clientPayout = DecimalUtil.toDecimal(dto.clientPayoutAmount);
    const generalLimit = DecimalUtil.toDecimal(dto.customer.generalLimit);
    const withdrawableLimit = DecimalUtil.toDecimal(dto.customer.withdrawableLimit);

    const orderNumber = await this.sequence.generateOrderNumber();
    const checkNumber = await this.sequence.generateCheckNumber();

    return this.prisma.$transaction(async (tx) => {
      const seller = await tx.user.findUnique({
        where: { id: dto.sellerId },
      });
      if (!seller) {
        throw new NotFoundException(`Сотувчи топилмади: ${dto.sellerId}`);
      }

      const program = await tx.financingProgram.findUnique({
        where: { id: dto.programId },
      });
      if (!program) {
        throw new NotFoundException(`Дастур топилмади: ${dto.programId}`);
      }

      const store = await tx.store.findUnique({
        where: { id: dto.storeId },
      });
      if (!store) {
        throw new NotFoundException(`Дўкон топилмади: ${dto.storeId}`);
      }

      let customer = await tx.customer.findFirst({
        where: { phone1: dto.customer.phone1 },
      });

      if (!customer) {
        customer = await tx.customer.create({
          data: {
            fullName: dto.customer.fullName,
            phone1: dto.customer.phone1,
            phone2: dto.customer.phone2 || null,
            generalLimit,
            withdrawableLimit,
          },
        });
      } else {
        customer = await tx.customer.update({
          where: { id: customer.id },
          data: {
            fullName: dto.customer.fullName,
            phone2: dto.customer.phone2 || customer.phone2,
            generalLimit,
            withdrawableLimit,
          },
        });
      }

      const isNoContinuationProgram =
        program.name.includes('Trust 1') ||
        program.name.includes('Alif 6') ||
        program.name.includes('Alif Кодирака');

      const initialStatus = isNoContinuationProgram
        ? OrderStatus.FIRST_STAGE_COMPLETED
        : OrderStatus.READY_FOR_HANDOFF;

      const order = await tx.order.create({
        data: {
          orderNumber,
          checkNumber,
          omborStatus: 'Tasdiqlash kutilmoqda',
          productName: dto.productName,
          sellerId: dto.sellerId,
          programId: dto.programId,
          storeId: dto.storeId,
          customerId: customer.id,
          agencyId: dto.agencyId || null,
          agencyEmployeeId: dto.agencyEmployeeId || null,
          contractEndDate: dto.contractEndDate,
          daftarRejected: dto.daftarRejected,
          agentPercentage: foiz,
          clientPayoutAmount: clientPayout,
          totalPrice,
          totalQuantity: dto.quantity || 1,
          businessDate: new Date(),
          status: initialStatus,
        },
      });

      if (dto.attachmentIds && dto.attachmentIds.length > 0) {
        await tx.attachment.updateMany({
          where: { id: { in: dto.attachmentIds } },
          data: { orderId: order.id },
        });
      }

      const item = await tx.orderItem.create({
        data: {
          orderId: order.id,
          category: program.name,
          brand: program.name,
          model: dto.productName,
          characteristics: dto.imeiOrBarcode || null,
          quantity: dto.quantity || 1,
          unitPrice: totalPrice,
          totalPrice: DecimalUtil.mul(totalPrice, dto.quantity || 1),
        },
      });

      const isImei =
        dto.imeiOrBarcode && /^\d{15}$/.test(dto.imeiOrBarcode.replace(/\s+/g, ''));
      const qty = dto.quantity || 1;
      for (let i = 0; i < qty; i++) {
        await tx.inventoryUnit.create({
          data: {
            orderId: order.id,
            orderItemId: item.id,
            category: program.name,
            imei1: isImei ? dto.imeiOrBarcode : null,
            barcode: !isImei ? dto.imeiOrBarcode : null,
            status: InventoryUnitStatus.IN_STOCK,
          },
        });
      }

      await tx.daftarReview.create({
        data: {
          orderId: order.id,
          status: dto.daftarStatus,
          comment: '20-банд бўйича сотувчи томонидан кўрсатилган ҳолат',
          reviewedAt: new Date(),
        },
      });

      await tx.orderDraft.deleteMany({ where: { userId: dto.sellerId } });

      await this.audit.log(
        {
          entityName: 'Order',
          entityId: order.id,
          action: 'ORDER_STAGE_1_FULL_36_CREATED',
          performedById: dto.sellerId,
          newValue: {
            checkNumber,
            orderNumber,
            totalPrice: totalPrice.toString(),
            clientPayoutAmount: clientPayout.toString(),
            program: program.name,
          },
        },
        tx,
      );

      return tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: {
          seller: true,
          program: true,
          store: true,
          agency: true,
          agencyEmployee: true,
          customer: true,
          items: true,
          attachments: true,
        },
      });
    });
  }

  async confirmOmborStatus(orderId: string, confirmedByName: string) {
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        omborStatus: `Tasdiqlandi (${confirmedByName})`,
        status: OrderStatus.COMPLETED,
      },
      include: {
        seller: true,
        program: true,
        store: true,
        agency: true,
        agencyEmployee: true,
        customer: true,
      },
    });

    await this.prisma.inventoryUnit.updateMany({
      where: { orderId },
      data: { status: InventoryUnitStatus.SOLD, soldAt: new Date() },
    });

    return updated;
  }

  async cancelOrder(orderId: string, cancelledByName: string) {
    return this.prisma.order.update({
      where: { id: orderId },
      data: {
        omborStatus: `Bekor qilindi (${cancelledByName})`,
        status: OrderStatus.CANCELLED,
        cancelledReason: `Бекор қилувчи: ${cancelledByName}`,
      },
      include: {
        seller: true,
        program: true,
        store: true,
        agency: true,
        agencyEmployee: true,
        customer: true,
      },
    });
  }

  // ===================== SCOPED RETRIEVAL & PERMISSIONS =====================

  async getOrderById(orderId: string, requestingUserId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        seller: true,
        program: true,
        store: true,
        customer: true,
        items: true,
        inventoryUnits: true,
        assignments: { include: { operator: true, assigner: true } },
        daftarReviews: { include: { reviewer: true }, orderBy: { createdAt: 'desc' } },
        sales: {
          include: {
            buyer: true,
            payments: { include: { reversal: true } },
            items: true,
            debtSchedules: true,
          },
        },
        attachments: true,
      },
    });

    if (!order) {
      throw new NotFoundException(`Буюртма топилмади: ${orderId}`);
    }

    // RBAC Scope Check (Section 3)
    const user = await this.prisma.user.findUnique({
      where: { id: requestingUserId },
      include: { roles: { include: { role: true } } },
    });

    if (!user) {
      throw new ForbiddenException('Фойдаланувчи топилмади');
    }

    const isSuperAdmin = user.roles.some((r) => r.role.name === RoleName.SUPER_ADMIN);
    if (isSuperAdmin) return order;

    const isDaftarReviewer = user.roles.some((r) => r.role.name === RoleName.DAFTAR_REVIEWER);
    if (isDaftarReviewer) return order;

    const isSeller = user.roles.some((r) => r.role.name === RoleName.SELLER);
    if (isSeller && order.sellerId === requestingUserId) {
      return order;
    }

    const isOperator = user.roles.some((r) => r.role.name === RoleName.CONTINUATION_OPERATOR);
    if (isOperator) {
      const isAssigned = order.assignments.some(
        (a) => a.operatorId === requestingUserId,
      );
      if (isAssigned) return order;
    }

    throw new ForbiddenException('Сизга ушбу буюртмани кўришга рухсат берилмаган');
  }

  async getOrderByNumber(orderNumber: string, requestingUserId: string) {
    const order = await this.prisma.order.findUnique({
      where: { orderNumber },
    });
    if (!order) {
      throw new NotFoundException(`Буюртма топилмади: ${orderNumber}`);
    }
    return this.getOrderById(order.id, requestingUserId);
  }

  async listMyOrders(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    if (!user) return [];

    const isSuperAdmin = user.roles?.some(
      (r: any) => (r.role?.name || r.role || r) === RoleName.SUPER_ADMIN,
    );
    if (isSuperAdmin) {
      return this.prisma.order.findMany({
        orderBy: { createdAt: 'desc' },
        include: { customer: true, program: true },
        take: 30,
      });
    }

    return this.prisma.order.findMany({
      where: {
        OR: [
          { sellerId: userId },
          { assignments: { some: { operatorId: userId } } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: { customer: true, program: true },
      take: 30,
    });
  }

  async getAllOrdersForExport(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    if (!user) return [];

    const isSuperAdmin = user.roles?.some(
      (r: any) => (r.role?.name || r.role || r) === RoleName.SUPER_ADMIN,
    );
    const whereClause = isSuperAdmin
      ? {}
      : {
          OR: [
            { sellerId: userId },
            { assignments: { some: { operatorId: userId } } },
          ],
        };

    return this.prisma.order.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      include: {
        seller: true,
        program: true,
        store: true,
        agency: true,
        agencyEmployee: true,
        customer: true,
        items: true,
        inventoryUnits: true,
        daftarReviews: { orderBy: { createdAt: 'desc' }, take: 1 },
        sales: {
          include: {
            buyer: true,
            operator: true,
            debtSchedules: true,
          },
        },
      },
    });
  }
}
