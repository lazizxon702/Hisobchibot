import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { DaftarStatus, OrderStatus, RoleName } from '@prisma/client';

export interface UpdateDaftarStatusDto {
  orderId: string;
  reviewerId: string;
  status: DaftarStatus;
  comment?: string;
}

@Injectable()
export class DaftarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async listPendingReviews() {
    return this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.AWAITING_DAFTAR, OrderStatus.NEEDS_CORRECTION] },
      },
      include: {
        customer: true,
        program: true,
        seller: true,
        daftarReviews: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateReviewStatus(dto: UpdateDaftarStatusDto) {
    // 1. Role validation: Must have DAFTAR_REVIEWER or SUPER_ADMIN role
    const hasPermission = await this.usersService.hasRole(
      dto.reviewerId,
      RoleName.DAFTAR_REVIEWER,
    );
    if (!hasPermission) {
      throw new ForbiddenException('Фақат DAFTAR_REVIEWER ёки SUPER_ADMIN дафтар тасдиғини ўзгартира олади');
    }

    // 2. Business rule (Test 6): If NEEDS_CORRECTION, reason is mandatory!
    if (dto.status === DaftarStatus.NEEDS_CORRECTION) {
      if (!dto.comment || dto.comment.trim().length === 0) {
        throw new BadRequestException('«Надо исправить» статуси танланганда сабаб (изоҳ) киритилиши шарт');
      }
    }

    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      include: { seller: true, program: true },
    });

    if (!order) {
      throw new NotFoundException(`Буюртма топилмади: ${dto.orderId}`);
    }

    return this.prisma.$transaction(async (tx) => {
      // Create new review history record
      const review = await tx.daftarReview.create({
        data: {
          orderId: order.id,
          reviewerId: dto.reviewerId,
          status: dto.status,
          comment: dto.comment?.trim(),
          reviewedAt: new Date(),
        },
      });

      // Update Order Status accordingly
      let nextOrderStatus = order.status;
      if (dto.status === DaftarStatus.APPROVED || dto.status === DaftarStatus.NOT_REQUIRED) {
        if (order.program.requiresContinuation) {
          nextOrderStatus = OrderStatus.READY_FOR_HANDOFF;
        } else {
          nextOrderStatus = OrderStatus.FIRST_STAGE_COMPLETED;
        }
      } else if (dto.status === DaftarStatus.NEEDS_CORRECTION) {
        nextOrderStatus = OrderStatus.NEEDS_CORRECTION;
      } else if (dto.status === DaftarStatus.PENDING) {
        nextOrderStatus = OrderStatus.AWAITING_DAFTAR;
      }

      await tx.order.update({
        where: { id: order.id },
        data: { status: nextOrderStatus },
      });

      // If NEEDS_CORRECTION, notify seller via Outbox
      if (dto.status === DaftarStatus.NEEDS_CORRECTION && order.seller) {
        await this.outbox.enqueue(
          'telegram_notification',
          {
            recipientTelegramId: order.seller.telegramId.toString(),
            message: `⚠️ Буюртмангиз (${order.orderNumber}) Дафтар тасдиғидан қайтарилди!\nСабаб: ${dto.comment}`,
          },
          tx,
        );
      }

      await this.audit.log(
        {
          entityName: 'Order',
          entityId: order.id,
          action: 'DAFTAR_REVIEW_UPDATED',
          performedById: dto.reviewerId,
          newValue: {
            daftarStatus: dto.status,
            comment: dto.comment,
            nextOrderStatus,
          },
        },
        tx,
      );

      return review;
    });
  }

  canProceedToHandoff(status: DaftarStatus): boolean {
    return status === DaftarStatus.APPROVED || status === DaftarStatus.NOT_REQUIRED;
  }
}
