import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InventoryUnitStatus } from '@prisma/client';

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getUnitsByOrder(orderId: string) {
    return this.prisma.inventoryUnit.findMany({
      where: { orderId },
      include: { orderItem: true, saleItem: { include: { sale: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateUnitStatus(
    unitId: string,
    status: InventoryUnitStatus,
    performedById: string,
  ) {
    const unit = await this.prisma.inventoryUnit.findUnique({
      where: { id: unitId },
    });
    if (!unit) {
      throw new NotFoundException(`Товар бирлиги топилмади: ${unitId}`);
    }

    if (unit.status === InventoryUnitStatus.SOLD && status !== InventoryUnitStatus.SOLD) {
      throw new BadRequestException('Сотилган товар статусини ўзгартириб бўлмайди');
    }

    const updated = await this.prisma.inventoryUnit.update({
      where: { id: unitId },
      data: {
        status,
        soldAt: status === InventoryUnitStatus.SOLD ? new Date() : unit.soldAt,
      },
    });

    await this.audit.log({
      entityName: 'InventoryUnit',
      entityId: unitId,
      action: 'INVENTORY_STATUS_CHANGED',
      performedById,
      oldValue: { status: unit.status },
      newValue: { status },
    });

    return updated;
  }

  async searchInventory(query: string) {
    const trimmed = query.trim();
    return this.prisma.inventoryUnit.findMany({
      where: {
        OR: [
          { imei1: { contains: trimmed, mode: 'insensitive' } },
          { imei2: { contains: trimmed, mode: 'insensitive' } },
          { barcode: { contains: trimmed, mode: 'insensitive' } },
          { serialNumber: { contains: trimmed, mode: 'insensitive' } },
        ],
      },
      include: {
        order: { include: { customer: true, seller: true } },
        orderItem: true,
      },
      take: 20,
    });
  }
}
