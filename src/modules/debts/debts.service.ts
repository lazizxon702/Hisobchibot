import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { DateUtil } from '../../common/date.util';
import { RoleName } from '@prisma/client';

export interface RescheduleDebtDto {
  saleId: string;
  newDueDate: Date | string;
  reason: string;
  rescheduledById: string;
}

@Injectable()
export class DebtsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Retrieves debt details for a sale with strict operator ownership verification (Test 9).
   */
  async getDebtDetails(saleId: string, requestingUserId: string) {
    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      include: {
        order: {
          include: {
            customer: true,
            seller: true,
            assignments: true,
          },
        },
        buyer: true,
        operator: true,
        payments: {
          include: { reversal: true },
          orderBy: { createdAt: 'desc' },
        },
        debtSchedules: { orderBy: { currentDueDate: 'desc' } },
      },
    });

    if (!sale) {
      throw new NotFoundException(`Қарздорлик ёзуви топилмади: ${saleId}`);
    }

    // Role verification (Section 3 & Item 35)
    const isSuperAdmin = await this.usersService.hasRole(
      requestingUserId,
      RoleName.SUPER_ADMIN,
    );

    if (!isSuperAdmin) {
      const isAssigned = sale.order?.assignments?.some(
        (a: any) => a.operatorId === requestingUserId,
      );
      if (!isAssigned && sale.operatorId !== requestingUserId) {
        throw new ForbiddenException('Сизга ушбу операторнинг қарзини кўришга рухсат берилмаган');
      }
    }

    return sale;
  }

  async listActiveDebts(requestingUserId: string) {
    const isSuperAdmin = await this.usersService.hasRole(
      requestingUserId,
      RoleName.SUPER_ADMIN,
    );

    const whereClause: any = {
      hasDebt: true,
    };

    if (!isSuperAdmin) {
      whereClause.order = {
        assignments: {
          some: { operatorId: requestingUserId },
        },
      };
    }

    return this.prisma.sale.findMany({
      where: whereClause,
      include: {
        order: { include: { customer: true } },
        buyer: true,
        debtSchedules: { where: { isSettled: false } },
      },
      orderBy: { debtDueDate: 'asc' },
    });
  }

  async listOverdueDebts(requestingUserId: string) {
    const isSuperAdmin = await this.usersService.hasRole(
      requestingUserId,
      RoleName.SUPER_ADMIN,
    );

    const now = new Date();
    const whereClause: any = {
      hasDebt: true,
      debtDueDate: { lt: now },
    };

    if (!isSuperAdmin) {
      whereClause.order = {
        assignments: {
          some: { operatorId: requestingUserId },
        },
      };
    }

    return this.prisma.sale.findMany({
      where: whereClause,
      include: {
        order: { include: { customer: true } },
        buyer: true,
      },
      orderBy: { debtDueDate: 'asc' },
    });
  }

  async listSettledDebts(requestingUserId: string) {
    const isSuperAdmin = await this.usersService.hasRole(
      requestingUserId,
      RoleName.SUPER_ADMIN,
    );

    const whereClause: any = {
      hasDebt: false,
      paidAmount: { gt: 0 },
    };

    if (!isSuperAdmin) {
      whereClause.order = {
        assignments: {
          some: { operatorId: requestingUserId },
        },
      };
    }

    return this.prisma.sale.findMany({
      where: whereClause,
      include: {
        order: { include: { customer: true } },
        buyer: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
  }

  async rescheduleDebt(dto: RescheduleDebtDto) {
    if (!dto.reason || dto.reason.trim().length === 0) {
      throw new BadRequestException('Муддатни ўзгартириш сабаби мажбурий кўрсатилиши шарт');
    }

    const newDate =
      dto.newDueDate instanceof Date
        ? dto.newDueDate
        : DateUtil.parseToUtcDate(dto.newDueDate);

    if (!newDate) {
      throw new BadRequestException('Янги муддат санаси нотўғри кўрсатилган');
    }

    const sale = await this.getDebtDetails(dto.saleId, dto.rescheduledById);
    const oldDueDate = sale.debtDueDate;

    return this.prisma.$transaction(async (tx) => {
      await tx.sale.update({
        where: { id: sale.id },
        data: {
          debtDueDate: newDate,
          version: { increment: 1 },
        },
      });

      // Update current schedule or create new one
      const existingSchedule = await tx.debtSchedule.findFirst({
        where: { saleId: sale.id, isSettled: false },
        orderBy: { createdAt: 'desc' },
      });

      if (existingSchedule) {
        await tx.debtSchedule.update({
          where: { id: existingSchedule.id },
          data: {
            currentDueDate: newDate,
            rescheduleReason: dto.reason.trim(),
            rescheduledById: dto.rescheduledById,
          },
        });
      } else {
        await tx.debtSchedule.create({
          data: {
            saleId: sale.id,
            originalDueDate: oldDueDate || newDate,
            currentDueDate: newDate,
            rescheduleReason: dto.reason.trim(),
            rescheduledById: dto.rescheduledById,
          },
        });
      }

      await this.audit.log(
        {
          entityName: 'Sale',
          entityId: sale.id,
          action: 'DEBT_RESCHEDULED',
          performedById: dto.rescheduledById,
          reason: dto.reason,
          oldValue: { debtDueDate: oldDueDate },
          newValue: { debtDueDate: newDate },
        },
        tx,
      );

      return { success: true, newDueDate: newDate };
    });
  }
}
