import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { CustomersService } from '../customers/customers.service';
import { AuditService } from '../audit/audit.service';
import { DecimalUtil } from '../../common/decimal.util';
import { SequenceService } from '../../infrastructure/sequence/sequence.service';
import {
  OrderStatus,
  InventoryUnitStatus,
  PaymentStatus,
  RoleName,
  PaymentMethod,
  Currency,
  TransactionStatus,
} from '@prisma/client';
import { Decimal } from 'decimal.js';

export interface CreateSaleItemInput {
  inventoryUnitId: string;
  unitPrice: string | number | Decimal;
}

export interface CreateSaleDto {
  orderId: string;
  operatorId: string;
  buyer: {
    fullName: string;
    phone: string;
    address?: string;
    shopNumber?: string;
    latitude?: number;
    longitude?: number;
  };
  agencyId?: string;
  agencyEmployeeId?: string;
  plannedSalePrice: string | number | Decimal;
  actualSalePrice: string | number | Decimal;
  items: CreateSaleItemInput[];
  debtDueDate?: Date;
  videoNoteAttachmentId?: string;
  videoVerified?: boolean;
}

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly customersService: CustomersService,
    private readonly audit: AuditService,
    private readonly sequence: SequenceService,
  ) {}

  async createSale(dto: CreateSaleDto) {
    // 1. Order validation
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      include: {
        assignments: true,
        inventoryUnits: true,
      },
    });

    if (!order) {
      throw new NotFoundException(`Буюртма топилмади: ${dto.orderId}`);
    }

    // 2. Check operator assignment & permissions (Section 3)
    const isSuperAdmin = await this.usersService.hasRole(dto.operatorId, RoleName.SUPER_ADMIN);
    const isAssigned = order.assignments.some(
      (a) => a.operatorId === dto.operatorId,
    );

    if (!isSuperAdmin && !isAssigned) {
      throw new ForbiddenException('Сиз фақат ўзингизга бириктирилган буюртмага сотув кирита оласиз');
    }

    // 3. Validate items (Test 10 & Test 11)
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('Сотув учун камида 1 та товар танланиши шарт');
    }

    const unitIds = dto.items.map((i) => i.inventoryUnitId);
    // Check duplicate in same request
    if (new Set(unitIds).size !== unitIds.length) {
      throw new BadRequestException('Бир товарни бир сотувда икки марта кўрсатиб бўлмайди');
    }

    // 4. Validate planned and actual prices
    const plannedPrice = DecimalUtil.toDecimal(dto.plannedSalePrice);
    const actualPrice = DecimalUtil.toDecimal(dto.actualSalePrice);
    if (!DecimalUtil.isPositive(actualPrice)) {
      throw new BadRequestException('Ҳақиқий сотув нархи нолдан катта бўлиши шарт');
    }

    // 5. Buyer creation / update
    const buyer = await this.customersService.findOrCreateBuyer(dto.buyer);

    // 6. Execute Transaction
    return this.prisma.$transaction(async (tx) => {
      // Check units in DB with lock & status check (Test 11: cannot sell sold unit)
      const units = await tx.inventoryUnit.findMany({
        where: { id: { in: unitIds } },
      });

      if (units.length !== unitIds.length) {
        throw new NotFoundException('Бир ёки бир нечта товар бирлиги топилмади');
      }

      for (const u of units) {
        if (u.orderId !== order.id) {
          throw new BadRequestException(`Товар ушбу буюртмага тегишли эмас: ${u.id}`);
        }
        if (u.status === InventoryUnitStatus.SOLD) {
          throw new BadRequestException(
            `Товар аллақачон сотилган! Бир товар икки марта сотилмайди (IMEI: ${u.imei1 || u.barcode || u.id})`,
          );
        }
      }

      // Initial remaining amount equals actual sale price (before any payments)
      const remainingAmount = actualPrice;
      const hasDebt = DecimalUtil.isPositive(remainingAmount);

      // If has debt, validate debt due date
      if (hasDebt && !dto.debtDueDate) {
        throw new BadRequestException('Қарздорлик мавжуд бўлганда қолдиқни ёпиш вақти (муддат) мажбурийдир');
      }

      // Create Sale record
      const sale = await tx.sale.create({
        data: {
          orderId: order.id,
          version: 1,
          buyerId: buyer.id,
          operatorId: dto.operatorId,
          agencyId: dto.agencyId,
          agencyEmployeeId: dto.agencyEmployeeId,
          plannedSalePrice: plannedPrice,
          actualSalePrice: actualPrice,
          paidAmount: new Decimal(0),
          remainingAmount,
          paymentStatus: PaymentStatus.DEBT,
          hasDebt,
          debtDueDate: hasDebt ? dto.debtDueDate : null,
          videoVerifiedBy: dto.videoVerified ? dto.operatorId : null,
          videoVerifiedAt: dto.videoVerified ? new Date() : null,
        },
      });

      // Create Sale Items & mark physical units as SOLD
      for (const item of dto.items) {
        await tx.saleItem.create({
          data: {
            saleId: sale.id,
            inventoryUnitId: item.inventoryUnitId,
            quantity: 1,
            unitPrice: DecimalUtil.toDecimal(item.unitPrice),
          },
        });

        await tx.inventoryUnit.update({
          where: { id: item.inventoryUnitId },
          data: {
            status: InventoryUnitStatus.SOLD,
            soldAt: new Date(),
          },
        });
      }

      // If has debt, create initial DebtSchedule
      if (hasDebt && dto.debtDueDate) {
        await tx.debtSchedule.create({
          data: {
            saleId: sale.id,
            originalDueDate: dto.debtDueDate,
            currentDueDate: dto.debtDueDate,
            isSettled: false,
          },
        });
      }

      await this.audit.log(
        {
          entityName: 'Sale',
          entityId: sale.id,
          action: 'SALE_CREATED',
          performedById: dto.operatorId,
          newValue: {
            actualSalePrice: sale.actualSalePrice.toString(),
            hasDebt: sale.hasDebt,
            itemCount: dto.items.length,
          },
        },
        tx,
      );

      return sale;
    });
  }

  // ===================== FULL STAGE 2 (21–34 POINTS) SALE CREATION =====================

  async createFullSale36(dto: {
    orderId: string;
    operatorId: string;
    inventoryStatus: InventoryUnitStatus;
    agencyId?: string | null;
    agencyEmployeeId?: string | null;
    buyer: {
      fullName: string;
      phone: string;
      address?: string;
      shopNumber?: string;
    };
    plannedSalePrice: string | number | Decimal;
    actualSalePrice: string | number | Decimal;
    paidAmount?: string | number | Decimal;
    paymentMethod?: PaymentMethod | string;
    hasDebt: boolean;
    remainingAmount: string | number | Decimal;
    debtDueDate?: Date | null;
    videoAttachmentId?: string | null;
    paymentStatus: PaymentStatus;
  }) {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      include: {
        inventoryUnits: true,
      },
    });

    if (!order) {
      throw new NotFoundException(`Буюртма топилмади: ${dto.orderId}`);
    }

    const plannedPrice = DecimalUtil.toDecimal(dto.plannedSalePrice);
    const actualPrice = DecimalUtil.toDecimal(dto.actualSalePrice);
    const remaining = dto.hasDebt ? DecimalUtil.toDecimal(dto.remainingAmount) : new Decimal(0);
    const paid = dto.paidAmount !== undefined
      ? DecimalUtil.toDecimal(dto.paidAmount)
      : DecimalUtil.sub(actualPrice, remaining);

    const buyer = await this.customersService.findOrCreateBuyer(dto.buyer);

    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.create({
        data: {
          orderId: order.id,
          version: 1,
          buyerId: buyer.id,
          operatorId: dto.operatorId,
          agencyId: dto.agencyId || null,
          agencyEmployeeId: dto.agencyEmployeeId || null,
          plannedSalePrice: plannedPrice,
          actualSalePrice: actualPrice,
          paidAmount: paid,
          remainingAmount: remaining,
          paymentStatus: dto.paymentStatus,
          hasDebt: dto.hasDebt,
          debtDueDate: dto.hasDebt ? dto.debtDueDate : null,
          videoVerifiedBy: dto.videoAttachmentId ? dto.operatorId : null,
          videoVerifiedAt: dto.videoAttachmentId ? new Date() : null,
        },
      });

      if (DecimalUtil.isPositive(paid)) {
        const receiptNumber = await this.sequence.generateReceiptNumber();
        const pMethod = (dto.paymentMethod as PaymentMethod) || PaymentMethod.CASH;
        await tx.payment.create({
          data: {
            saleId: sale.id,
            receiptNumber,
            method: pMethod,
            currency: Currency.UZS,
            originalAmount: paid,
            calculatedAmount: paid,
            status: TransactionStatus.CONFIRMED,
            createdById: dto.operatorId,
          },
        });
      }

      for (const u of order.inventoryUnits) {
        await tx.inventoryUnit.update({
          where: { id: u.id },
          data: {
            status: dto.inventoryStatus,
            soldAt: dto.inventoryStatus === InventoryUnitStatus.SOLD ? new Date() : null,
          },
        });

        await tx.saleItem.create({
          data: {
            saleId: sale.id,
            inventoryUnitId: u.id,
            quantity: 1,
            unitPrice: actualPrice,
          },
        });
      }

      if (dto.hasDebt && dto.debtDueDate) {
        await tx.debtSchedule.create({
          data: {
            saleId: sale.id,
            originalDueDate: dto.debtDueDate,
            currentDueDate: dto.debtDueDate,
            isSettled: false,
          },
        });
      }

      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.COMPLETED },
      });

      if (dto.videoAttachmentId) {
        await tx.attachment.update({
          where: { id: dto.videoAttachmentId },
          data: { saleId: sale.id },
        });
      }

      await this.audit.log(
        {
          entityName: 'Sale',
          entityId: sale.id,
          action: 'SALE_FULL_36_CREATED',
          performedById: dto.operatorId,
          newValue: {
            actualSalePrice: actualPrice.toString(),
            hasDebt: dto.hasDebt,
            paymentStatus: dto.paymentStatus,
          },
        },
        tx,
      );

      return tx.sale.findUniqueOrThrow({
        where: { id: sale.id },
        include: {
          order: { include: { customer: true, seller: true, program: true, store: true } },
          buyer: true,
          operator: true,
          agency: true,
          agencyEmployee: true,
          items: { include: { inventoryUnit: true } },
          debtSchedules: true,
        },
      });
    });
  }

  async getSaleById(saleId: string) {
    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      include: {
        order: { include: { customer: true, seller: true } },
        buyer: true,
        operator: true,
        agency: true,
        agencyEmployee: true,
        items: { include: { inventoryUnit: true } },
        payments: { include: { reversal: true } },
        debtSchedules: true,
      },
    });
    if (!sale) {
      throw new NotFoundException(`Сотув топилмади: ${saleId}`);
    }
    return sale;
  }
}
