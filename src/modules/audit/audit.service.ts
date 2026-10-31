import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface AuditLogParams {
  entityName: string;
  entityId: string;
  action: string;
  performedById?: string;
  oldValue?: any;
  newValue?: any;
  reason?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(params: AuditLogParams, prismaClient?: any): Promise<void> {
    const client = prismaClient || this.prisma;
    try {
      await client.auditEvent.create({
        data: {
          entityName: params.entityName,
          entityId: params.entityId,
          action: params.action,
          performedById: params.performedById,
          oldValue: params.oldValue !== undefined ? params.oldValue : undefined,
          newValue: params.newValue !== undefined ? params.newValue : undefined,
          reason: params.reason,
        },
      });
    } catch (e) {
      this.logger.error(`Failed to record audit event: ${(e as Error).message}`, (e as Error).stack);
    }
  }

  async getAuditHistory(entityName: string, entityId: string) {
    return this.prisma.auditEvent.findMany({
      where: { entityName, entityId },
      orderBy: { timestamp: 'desc' },
      include: {
        performedBy: {
          select: { id: true, firstName: true, lastName: true, telegramId: true },
        },
      },
    });
  }
}
