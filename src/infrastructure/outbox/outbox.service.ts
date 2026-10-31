import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxStatus } from '@prisma/client';

export interface OutboxPayload {
  recipientTelegramId?: string;
  chatId?: string | number;
  message: string;
  replyMarkup?: any;
  metadata?: Record<string, any>;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enqueues an event in the outbox table. Can be passed an existing Prisma transaction client.
   */
  async enqueue(
    topic: string,
    payload: OutboxPayload,
    prismaClient?: any,
  ): Promise<string> {
    const client = prismaClient || this.prisma;
    const event = await client.outboxEvent.create({
      data: {
        topic,
        payload: payload as any,
        status: OutboxStatus.PENDING,
      },
    });
    return event.id;
  }

  async getPendingEvents(limit: number = 20) {
    return this.prisma.outboxEvent.findMany({
      where: {
        status: OutboxStatus.PENDING,
        attempts: { lt: 5 },
      },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });
  }

  async markSent(id: string) {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: OutboxStatus.SENT,
        processedAt: new Date(),
      },
    });
  }

  async markFailed(id: string, error: string) {
    const event = await this.prisma.outboxEvent.findUnique({ where: { id } });
    if (!event) return;

    const nextAttempts = event.attempts + 1;
    await this.prisma.outboxEvent.update({
      where: { id },
      data: {
        attempts: nextAttempts,
        lastError: error,
        status: nextAttempts >= 5 ? OutboxStatus.FAILED : OutboxStatus.PENDING,
      },
    });
  }
}
