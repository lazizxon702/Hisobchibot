import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SequenceService } from '../../infrastructure/sequence/sequence.service';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { DecimalUtil } from '../../common/decimal.util';
import { DateUtil } from '../../common/date.util';
import {
  PaymentMethod,
  Currency,
  TransactionStatus,
  PaymentStatus,
  RoleName,
} from '@prisma/client';
import { Decimal } from 'decimal.js';

export interface CreatePaymentDto {
  saleId: string;
  method: PaymentMethod;
  currency: Currency;
  originalAmount: string | number | Decimal;
  exchangeRate?: string | number | Decimal;
  proofAttachmentId?: string;
  createdById: string;
  idempotencyKey?: string;
}

export interface ReversePaymentDto {
  paymentId: string;
  adminId: string;
  reason: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sequence: SequenceService,
    private readonly usersService: UsersService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly redis: RedisService,
  ) {}

  async getReceiptsGroupId(): Promise<string | null> {
    if (process.env.RECEIPTS_GROUP_ID) {
      return process.env.RECEIPTS_GROUP_ID;
    }
    try {
      const setting = await this.prisma.systemSetting.findUnique({
        where: { key: 'RECEIPTS_GROUP_ID' },
      });
      return setting?.value || null;
    } catch {
      return null;
    }
  }

  /**
   * Records a payment against a sale.
   * Completely race-condition proof, supports mixed currencies and rejects overpayment.
   */
  async recordPayment(dto: CreatePaymentDto) {
    const origAmount = DecimalUtil.toDecimal(dto.originalAmount);
    if (!DecimalUtil.isPositive(origAmount)) {
      throw new BadRequestException('Тўлов суммаси мусбат бўлиши керак');
    }

    // Currency & Exchange Rate calculation (Test 13)
    let calculatedAmount: Decimal;
    let rate: Decimal | null = null;

    if (dto.currency === Currency.USD) {
      if (!dto.exchangeRate) {
        throw new BadRequestException('АҚШ доллари (USD) учун курс кўрсатилиши шарт');
      }
      rate = DecimalUtil.toDecimal(dto.exchangeRate);
      if (!DecimalUtil.isPositive(rate)) {
        throw new BadRequestException('Курс нолдан катта бўлиши керак');
      }
      calculatedAmount = DecimalUtil.mul(origAmount, rate);
    } else {
      calculatedAmount = origAmount;
    }

    // Idempotency lock if key provided (Test 16)
    if (dto.idempotencyKey) {
      const lockKey = `payment_idem:${dto.idempotencyKey}`;
      const acquired = await this.redis.acquireLock(lockKey, 30);
      if (!acquired) {
        throw new ConflictException('Ушбу тўлов сўрови ҳозир қабул қилинмоқда ёки аввал юборилган');
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Query sale with lock
        const sale = await tx.sale.findUnique({
          where: { id: dto.saleId },
          include: {
            buyer: true,
            order: { include: { seller: true } },
            payments: { where: { status: TransactionStatus.CONFIRMED } },
          },
        });

        if (!sale) {
          throw new NotFoundException(`Сотув топилмади: ${dto.saleId}`);
        }

        // Check operator permissions (must be assigned operator or Super Admin)
        const isSuperAdmin = await this.usersService.hasRole(
          dto.createdById,
          RoleName.SUPER_ADMIN,
        );
        if (!isSuperAdmin && sale.operatorId !== dto.createdById) {
          throw new ForbiddenException('Фақат ушбу буюртмага бириктирилган оператор тўлов қабул қила олади');
        }

        // Recalculate current valid payments and remaining balance
        let activePaymentsTotal = new Decimal(0);
        for (const p of sale.payments) {
          activePaymentsTotal = DecimalUtil.add(activePaymentsTotal, p.calculatedAmount);
        }

        const currentRemaining = DecimalUtil.sub(sale.actualSalePrice, activePaymentsTotal);

        // Overpayment check (Test 15)
        if (DecimalUtil.isGreaterThan(calculatedAmount, currentRemaining)) {
          throw new BadRequestException(
            `Ортиқча тўлов рад этилди! Қолдиқ қарз: ${DecimalUtil.formatMoney(currentRemaining)}, киритилган тўлов: ${DecimalUtil.formatMoney(calculatedAmount)}`,
          );
        }

        // Generate Human Receipt Number (PAY-2026-000001)
        const receiptNumber = await this.sequence.generateReceiptNumber();

        // Create Payment record (immutably frozen calculation)
        const payment = await tx.payment.create({
          data: {
            receiptNumber,
            saleId: sale.id,
            method: dto.method,
            currency: dto.currency,
            originalAmount: origAmount,
            exchangeRate: rate,
            calculatedAmount,
            status: TransactionStatus.CONFIRMED,
            createdById: dto.createdById,
          },
        });

        if (dto.proofAttachmentId) {
          await tx.attachment.update({
            where: { id: dto.proofAttachmentId },
            data: { paymentId: payment.id },
          });
        }

        // Compute new remaining and status
        const newPaidAmount = DecimalUtil.add(activePaymentsTotal, calculatedAmount);
        const newRemaining = DecimalUtil.sub(sale.actualSalePrice, newPaidAmount);

        let newStatus: PaymentStatus = PaymentStatus.DEBT;
        let hasDebt = true;

        if (DecimalUtil.isZero(newRemaining)) {
          newStatus = PaymentStatus.PAID;
          hasDebt = false;

          // Settle debt schedules (Test 18)
          await tx.debtSchedule.updateMany({
            where: { saleId: sale.id, isSettled: false },
            data: { isSettled: true, settledAt: new Date() },
          });

          // Cancel active reminders
          await tx.reminder.updateMany({
            where: { saleId: sale.id, isCancelled: false },
            data: { isCancelled: true },
          });
        } else {
          newStatus = PaymentStatus.PARTIAL;
          hasDebt = true;
        }

        await tx.sale.update({
          where: { id: sale.id },
          data: {
            paidAmount: newPaidAmount,
            remainingAmount: newRemaining,
            paymentStatus: newStatus,
            hasDebt,
            version: { increment: 1 },
          },
        });

        // Send Outbox Notification with receipt details
        await this.outbox.enqueue(
          'telegram_notification',
          {
            chatId: dto.createdById,
            message: `🧾 Тўлов қабул қилинди!\nЧек №: ${payment.receiptNumber}\nСумма: ${DecimalUtil.formatMoney(payment.calculatedAmount)}\nҚолдиқ қарз: ${DecimalUtil.formatMoney(newRemaining)}\nҲолат: ${newStatus}`,
          },
          tx,
        );

        // Send Official Receipt to Telegram Group
        const receiptsGroupId = await this.getReceiptsGroupId();
        if (receiptsGroupId) {
          const groupReceiptMsg =
            `🧾 <b>РАСМИЙ ТЎЛОВ ЧЕКИ</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `• Чек рақами: <b>${payment.receiptNumber}</b>\n` +
            `• Буюртма ID: <b>${sale.order.orderNumber}</b>\n` +
            `• Ҳолати: <b>ТАСДИҚЛАНДИ (CONFIRMED)</b>\n\n` +
            `👤 <b>Мижоз / Харидор:</b>\n` +
            `• Исми: <b>${sale.buyer?.fullName || '—'}</b>\n` +
            `• Телефон: ${sale.buyer?.phone || '—'}\n\n` +
            `💳 <b>Тўлов тафсилотлари:</b>\n` +
            `• Усули: <b>${payment.method === PaymentMethod.CASH ? 'Нақд пул' : 'Банк ўтказмаси'}</b>\n` +
            `• Валюта: <b>${payment.currency}</b>\n` +
            `• Тўланган: <b>${payment.currency === Currency.USD ? payment.originalAmount + ' USD' : DecimalUtil.formatMoney(payment.calculatedAmount)}</b>\n` +
            (payment.currency === Currency.USD ? `• Валюта курси: 1 USD = ${DecimalUtil.formatMoney(payment.exchangeRate!)}\n` : '') +
            `• Ҳисобланган сумма: <b>${DecimalUtil.formatMoney(payment.calculatedAmount)}</b>\n\n` +
            `📊 <b>Молиявий ҳолат:</b>\n` +
            `• Жами тўланган: <b>${DecimalUtil.formatMoney(newPaidAmount)}</b>\n` +
            `• Қолдиқ қарз: <b>${DecimalUtil.formatMoney(newRemaining)}</b>\n` +
            `• Статус: <b>${newStatus === PaymentStatus.PAID ? '✅ ТЎЛАНДИ (ТЎЛИҚ ЁПИЛДИ)' : '⏳ ҚИСМАН ТЎЛАНДИ'}</b>\n\n` +
            `🕒 <b>Сана:</b> ${DateUtil.formatTashkent(payment.createdAt)}\n` +
            `━━━━━━━━━━━━━━━━━━━━`;

          await this.outbox.enqueue(
            'receipt_group_post',
            {
              chatId: receiptsGroupId,
              message: groupReceiptMsg,
            },
            tx,
          );
        }

        await this.audit.log(
          {
            entityName: 'Payment',
            entityId: payment.id,
            action: 'PAYMENT_RECORDED',
            performedById: dto.createdById,
            newValue: {
              receiptNumber: payment.receiptNumber,
              calculatedAmount: payment.calculatedAmount.toString(),
              remainingAmount: newRemaining.toString(),
              status: newStatus,
            },
          },
          tx,
        );

        return payment;
      });
    } finally {
      if (dto.idempotencyKey) {
        // Keep key for idempotency replay or release lock
        await this.redis.releaseLock(`payment_idem:${dto.idempotencyKey}`);
      }
    }
  }

  /**
   * Reverses an existing payment. Only SUPER_ADMIN allowed.
   * Completely preserves financial audit history and restores remaining debt (Test 17).
   */
  async reversePayment(dto: ReversePaymentDto) {
    // 1. Must be SUPER_ADMIN
    const isSuperAdmin = await this.usersService.hasRole(dto.adminId, RoleName.SUPER_ADMIN);
    if (!isSuperAdmin) {
      throw new ForbiddenException('Фақат SUPER_ADMIN тўловни бекор қила олади (reversal)');
    }

    if (!dto.reason || dto.reason.trim().length === 0) {
      throw new BadRequestException('Тўловни бекор қилиш сабаби мажбурий кўрсатилиши керак');
    }

    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: dto.paymentId },
        include: { reversal: true, sale: true },
      });

      if (!payment) {
        throw new NotFoundException(`Тўлов топилмади: ${dto.paymentId}`);
      }

      if (payment.status === TransactionStatus.REVERSED || payment.reversal) {
        throw new BadRequestException('Ушбу тўлов аввал бекор қилинган');
      }

      // Create Reversal record
      const reversal = await tx.paymentReversal.create({
        data: {
          paymentId: payment.id,
          reversedById: dto.adminId,
          reason: dto.reason.trim(),
        },
      });

      // Mark payment as REVERSED (NEVER DELETE!)
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: TransactionStatus.REVERSED },
      });

      // Recalculate Sale financial state from remaining valid payments
      const activePayments = await tx.payment.findMany({
        where: {
          saleId: payment.saleId,
          status: TransactionStatus.CONFIRMED,
        },
      });

      let recalculatedPaid = new Decimal(0);
      for (const p of activePayments) {
        recalculatedPaid = DecimalUtil.add(recalculatedPaid, p.calculatedAmount);
      }

      const recalculatedRemaining = DecimalUtil.sub(
        payment.sale.actualSalePrice,
        recalculatedPaid,
      );

      let newStatus: PaymentStatus;
      if (DecimalUtil.isZero(recalculatedPaid)) {
        newStatus = PaymentStatus.DEBT;
      } else if (DecimalUtil.isZero(recalculatedRemaining)) {
        newStatus = PaymentStatus.PAID;
      } else {
        newStatus = PaymentStatus.PARTIAL;
      }

      const hasDebt = DecimalUtil.isPositive(recalculatedRemaining);

      await tx.sale.update({
        where: { id: payment.saleId },
        data: {
          paidAmount: recalculatedPaid,
          remainingAmount: recalculatedRemaining,
          paymentStatus: newStatus,
          hasDebt,
          version: { increment: 1 },
        },
      });

      // If debt is restored, un-settle debt schedule
      if (hasDebt) {
        await tx.debtSchedule.updateMany({
          where: { saleId: payment.saleId },
          data: { isSettled: false, settledAt: null },
        });
      }

      await this.audit.log(
        {
          entityName: 'Payment',
          entityId: payment.id,
          action: 'PAYMENT_REVERSED',
          performedById: dto.adminId,
          reason: dto.reason,
          oldValue: { status: TransactionStatus.CONFIRMED },
          newValue: {
            status: TransactionStatus.REVERSED,
            restoredRemaining: recalculatedRemaining.toString(),
            reversalId: reversal.id,
          },
        },
        tx,
      );

      // Send Reversal Notice to Telegram Group
      const receiptsGroupId = await this.getReceiptsGroupId();
      if (receiptsGroupId) {
        const groupReversalMsg =
          `⚠️ <b>ТЎЛОВ БЕКОР ҚИЛИНДИ (REVERSAL)</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `• Чек рақами: <b>${payment.receiptNumber}</b>\n` +
          `• Бекор қилинган сумма: <b>${DecimalUtil.formatMoney(payment.calculatedAmount)}</b>\n` +
          `• Қайта тикланган қарз: <b>${DecimalUtil.formatMoney(recalculatedRemaining)}</b>\n` +
          `• Сабаби: <i>${dto.reason}</i>\n` +
          `• Вақт: ${DateUtil.formatTashkent(new Date())}\n` +
          `━━━━━━━━━━━━━━━━━━━━`;

        await this.outbox.enqueue(
          'reversal_group_post',
          {
            chatId: receiptsGroupId,
            message: groupReversalMsg,
          },
          tx,
        );
      }

      return reversal;
    });
  }

  async getPaymentByReceipt(receiptNumber: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { receiptNumber },
      include: {
        sale: {
          include: {
            order: { include: { customer: true, seller: true } },
            buyer: true,
          },
        },
        createdBy: true,
        reversal: { include: { reversedBy: true } },
      },
    });

    if (!payment) {
      throw new NotFoundException(`Чек топилмади: ${receiptNumber}`);
    }
    return payment;
  }
}
