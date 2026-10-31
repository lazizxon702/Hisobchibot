import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { DateUtil } from '../../common/date.util';
import { DecimalUtil } from '../../common/decimal.util';
import { ReminderType } from '@prisma/client';

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Scans sales with active debts and dispatches due/overdue reminders.
   */
  async processDueReminders() {
    const activeDebtSales = await this.prisma.sale.findMany({
      where: {
        hasDebt: true,
        debtDueDate: { not: null },
      },
      include: {
        order: { include: { customer: true, seller: true } },
        buyer: true,
        operator: true,
        reminders: true,
      },
    });

    const now = new Date();

    for (const sale of activeDebtSales) {
      if (!sale.debtDueDate) continue;

      const dueDate = new Date(sale.debtDueDate);
      const diffHours = (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60);

      // 1. One day before reminder (between 12 and 36 hours before)
      if (diffHours > 0 && diffHours <= 26) {
        const alreadySent = sale.reminders.some(
          (r) => r.type === ReminderType.ONE_DAY_BEFORE && !r.isCancelled,
        );
        if (!alreadySent) {
          await this.sendReminder(sale, ReminderType.ONE_DAY_BEFORE, 'Эртага тўлов муддати келади!');
        }
      }

      // 2. Due date reminder (between 0 and 12 hours)
      if (diffHours >= -12 && diffHours <= 12) {
        const alreadySent = sale.reminders.some(
          (r) => r.type === ReminderType.DUE_DATE && !r.isCancelled,
        );
        if (!alreadySent) {
          await this.sendReminder(sale, ReminderType.DUE_DATE, 'Бугун тўловнинг охирги куни!');
        }
      }

      // 3. Overdue reminder (more than 12 hours past)
      if (diffHours < -12) {
        const overdueReminders = sale.reminders.filter(
          (r) => r.type === ReminderType.OVERDUE && !r.isCancelled,
        );
        // Dispatch overdue reminder once every 48h
        const lastSent = overdueReminders[overdueReminders.length - 1];
        const canSend =
          !lastSent ||
          (now.getTime() - new Date(lastSent.createdAt).getTime()) / (1000 * 60 * 60) > 48;

        if (canSend) {
          await this.sendReminder(sale, ReminderType.OVERDUE, '⚠️ Қарздорлик муддати ўтиб кетди!');
        }
      }
    }
  }

  private async sendReminder(sale: any, type: ReminderType, title: string) {
    const formattedDue = DateUtil.formatTashkent(sale.debtDueDate);
    const moneyStr = DecimalUtil.formatMoney(sale.remainingAmount);

    const message = `${title}\n\nБуюртма: ${sale.order.orderNumber}\nХаридор: ${sale.buyer.fullName} (${sale.buyer.phone})\nҚолдиқ қарз: ${moneyStr}\nМуддати: ${formattedDue}`;

    await this.prisma.$transaction(async (tx) => {
      await tx.reminder.create({
        data: {
          saleId: sale.id,
          type,
          scheduledFor: new Date(),
          sentAt: new Date(),
        },
      });

      // Send reminder to responsible Continuation Operator
      if (sale.operator) {
        await this.outbox.enqueue(
          'telegram_notification',
          {
            recipientTelegramId: sale.operator.telegramId.toString(),
            message,
          },
          tx,
        );
      }
    });
  }

  async cancelRemindersForSale(saleId: string) {
    await this.prisma.reminder.updateMany({
      where: { saleId, isCancelled: false },
      data: { isCancelled: true },
    });
  }
}
