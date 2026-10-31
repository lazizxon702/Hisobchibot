import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { DaftarService } from '../daftar/daftar.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import {
  OrderStatus,
  AssignmentStatus,
  RoleName,
  DaftarStatus,
} from '@prisma/client';

@Injectable()
export class AssignmentsService {
  private readonly logger = new Logger(AssignmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly daftarService: DaftarService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Assigns an order to a continuation operator (Step 1 -> Step 2 handoff).
   */
  async assignOrder(
    orderId: string,
    operatorId: string,
    assignedById: string,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        program: true,
        customer: true,
        daftarReviews: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!order) {
      throw new NotFoundException(`Буюртма топилмади: ${orderId}`);
    }

    // 1. Check if program requires continuation (Test 4)
    if (!order.program.requiresContinuation) {
      throw new BadRequestException(
        `«${order.program.name}» дастурида 2-босқичга ўтказиш кўзда тутилмаган (requiresContinuation=false)`,
      );
    }

    // 2. Check Daftar review status (Test 7)
    const latestReview = order.daftarReviews[0];
    const daftarStatus = latestReview?.status || DaftarStatus.PENDING;
    if (!this.daftarService.canProceedToHandoff(daftarStatus)) {
      throw new BadRequestException(
        `Буюртмани ўтказиш мумкин эмас: Дафтар тасдиғи «${daftarStatus}» ҳолатида. Фақат «Подтверждено» ёки «Не требуется» бўлганда мумкин`,
      );
    }

    // 3. Check operator validity
    const operator = await this.prisma.user.findUnique({
      where: { id: operatorId },
      include: { roles: { include: { role: true } } },
    });
    if (!operator || !operator.isActive || !operator.isApproved) {
      throw new BadRequestException('Танланган ходим фаол эмас ёки тасдиқланмаган');
    }
    const isOperator = operator.roles.some(
      (r) =>
        r.role.name === RoleName.CONTINUATION_OPERATOR ||
        r.role.name === RoleName.SUPER_ADMIN,
    );
    if (!isOperator) {
      throw new BadRequestException('Танланган ходимда CONTINUATION_OPERATOR роли мавжуд эмас');
    }

    // 4. Check permissions of assigner (Seller who owns the order or Super Admin)
    const isSuperAdmin = await this.usersService.hasRole(assignedById, RoleName.SUPER_ADMIN);
    if (!isSuperAdmin && order.sellerId !== assignedById) {
      throw new ForbiddenException('Сиз фақат ўзингизга тегишли буюртмани ўтказа оласиз');
    }

    // 5. Atomic Assignment Transaction
    return this.prisma.$transaction(async (tx) => {
      // Check if existing pending assignment exists
      await tx.orderAssignment.deleteMany({
        where: { orderId: order.id, status: AssignmentStatus.PENDING },
      });

      const assignment = await tx.orderAssignment.create({
        data: {
          orderId: order.id,
          operatorId: operator.id,
          assignedBy: assignedById,
          status: AssignmentStatus.PENDING,
        },
      });

      await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.ASSIGNED,
          version: { increment: 1 },
        },
      });

      // Send Outbox notification to operator with Acceptance prompt
      await this.outbox.enqueue(
        'telegram_notification',
        {
          recipientTelegramId: operator.telegramId.toString(),
          message: `📥 Сизга янги буюртма бириктирилди!\nБуюртма: ${order.orderNumber}\nМижоз: ${order.customer.fullName}\nСумма: ${order.totalPrice} сўм\n\nИлтимос, қабул қилиш учун «Қабул қилиш» тугмасини босинг.`,
          replyMarkup: {
            inline_keyboard: [
              [{ text: '✅ Қабул қилиш', callback_data: `accept_order:${order.id}` }],
            ],
          },
        },
        tx,
      );

      await this.audit.log(
        {
          entityName: 'Order',
          entityId: order.id,
          action: 'ORDER_ASSIGNED',
          performedById: assignedById,
          newValue: { operatorId: operator.id, assignmentId: assignment.id },
        },
        tx,
      );

      return assignment;
    });
  }

  /**
   * Continuation Operator accepts the assigned order.
   * Completely safe against race conditions / double acceptance (Test 8).
   */
  async acceptAssignment(orderId: string, operatorId: string) {
    const lockKey = `accept_assignment:${orderId}`;
    const acquired = await this.redis.acquireLock(lockKey, 5);
    if (!acquired) {
      throw new ConflictException('Ушбу буюртма ҳозир бошқа жараён томонидан қабул қилинмоқда');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Query order with row version check
        const order = await tx.order.findUnique({
          where: { id: orderId },
        });

        if (!order) {
          throw new NotFoundException(`Буюртма топилмади: ${orderId}`);
        }

        // If already IN_PROGRESS or COMPLETED, throw idempotent conflict
        if (order.status !== OrderStatus.ASSIGNED) {
          throw new BadRequestException(
            `Буюртмани қабул қилиб бўлмайди. Жорий ҳолат: ${order.status}`,
          );
        }

        // Find pending assignment for this operator
        const assignment = await tx.orderAssignment.findFirst({
          where: {
            orderId,
            operatorId,
            status: AssignmentStatus.PENDING,
          },
        });

        const isSuperAdmin = await this.usersService.hasRole(operatorId, RoleName.SUPER_ADMIN);
        if (!assignment && !isSuperAdmin) {
          throw new ForbiddenException('Сизга ушбу буюртмани қабул қилишга рухсат йўқ');
        }

        if (assignment) {
          await tx.orderAssignment.update({
            where: { id: assignment.id },
            data: {
              status: AssignmentStatus.ACCEPTED,
              acceptedAt: new Date(),
            },
          });
        }

        const updatedOrder = await tx.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.IN_PROGRESS,
            version: { increment: 1 },
          },
        });

        await this.audit.log(
          {
            entityName: 'Order',
            entityId: order.id,
            action: 'ASSIGNMENT_ACCEPTED',
            performedById: operatorId,
            newValue: { status: OrderStatus.IN_PROGRESS },
          },
          tx,
        );

        return updatedOrder;
      });
    } finally {
      await this.redis.releaseLock(lockKey);
    }
  }

  async listIncomingQueue(operatorId: string) {
    const isSuperAdmin = await this.usersService.hasRole(operatorId, RoleName.SUPER_ADMIN);
    if (isSuperAdmin) {
      return this.prisma.order.findMany({
        where: { status: OrderStatus.ASSIGNED },
        include: { customer: true, seller: true, program: true },
        orderBy: { createdAt: 'desc' },
      });
    }

    return this.prisma.order.findMany({
      where: {
        status: OrderStatus.ASSIGNED,
        assignments: {
          some: {
            operatorId,
            status: AssignmentStatus.PENDING,
          },
        },
      },
      include: { customer: true, seller: true, program: true },
      orderBy: { createdAt: 'desc' },
    });
  }
}
