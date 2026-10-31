import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DecimalUtil } from '../../common/decimal.util';
import { Currency, TransactionStatus, InventoryUnitStatus } from '@prisma/client';
import { Decimal } from 'decimal.js';

export interface ReportFilterDto {
  startDate?: Date;
  endDate?: Date;
  sellerId?: string;
  operatorId?: string;
  programId?: string;
  storeId?: string;
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async generateFinancialReport(filters: ReportFilterDto = {}) {
    const dateFilter: any = {};
    if (filters.startDate) dateFilter.gte = filters.startDate;
    if (filters.endDate) dateFilter.lte = filters.endDate;

    const orderWhere: any = {};
    if (Object.keys(dateFilter).length > 0) orderWhere.createdAt = dateFilter;
    if (filters.sellerId) orderWhere.sellerId = filters.sellerId;
    if (filters.programId) orderWhere.programId = filters.programId;
    if (filters.storeId) orderWhere.storeId = filters.storeId;

    // 1. Orders count & totals
    const orders = await this.prisma.order.findMany({
      where: orderWhere,
      include: { program: true, seller: true, store: true },
    });

    let totalOrderPrice = new Decimal(0);
    let totalItemsCount = 0;
    for (const o of orders) {
      totalOrderPrice = DecimalUtil.add(totalOrderPrice, o.totalPrice);
      totalItemsCount += o.totalQuantity;
    }

    // 2. Sales totals
    const saleWhere: any = {};
    if (Object.keys(dateFilter).length > 0) saleWhere.createdAt = dateFilter;
    if (filters.operatorId) saleWhere.operatorId = filters.operatorId;

    const sales = await this.prisma.sale.findMany({
      where: saleWhere,
      include: {
        payments: true,
      },
    });

    let plannedSalesTotal = new Decimal(0);
    let actualSalesTotal = new Decimal(0);
    let totalPaidInSales = new Decimal(0);
    let totalOpenDebt = new Decimal(0);

    for (const s of sales) {
      plannedSalesTotal = DecimalUtil.add(plannedSalesTotal, s.plannedSalePrice);
      actualSalesTotal = DecimalUtil.add(actualSalesTotal, s.actualSalePrice);
      totalPaidInSales = DecimalUtil.add(totalPaidInSales, s.paidAmount);
      if (s.hasDebt) {
        totalOpenDebt = DecimalUtil.add(totalOpenDebt, s.remainingAmount);
      }
    }

    // 3. Payments received (Split cleanly into UZS and USD)
    const paymentWhere: any = {
      status: TransactionStatus.CONFIRMED,
    };
    if (Object.keys(dateFilter).length > 0) paymentWhere.createdAt = dateFilter;

    const payments = await this.prisma.payment.findMany({
      where: paymentWhere,
    });

    let totalUzsPayments = new Decimal(0);
    let totalUsdPayments = new Decimal(0);
    let totalCalculatedUzsPayments = new Decimal(0);

    for (const p of payments) {
      if (p.currency === Currency.USD) {
        totalUsdPayments = DecimalUtil.add(totalUsdPayments, p.originalAmount);
      } else {
        totalUzsPayments = DecimalUtil.add(totalUzsPayments, p.originalAmount);
      }
      totalCalculatedUzsPayments = DecimalUtil.add(
        totalCalculatedUzsPayments,
        p.calculatedAmount,
      );
    }

    // 4. Reversals
    const reversals = await this.prisma.paymentReversal.findMany({
      where: Object.keys(dateFilter).length > 0 ? { reversedAt: dateFilter } : {},
      include: { payment: true },
    });

    let totalReversedAmount = new Decimal(0);
    for (const r of reversals) {
      totalReversedAmount = DecimalUtil.add(
        totalReversedAmount,
        r.payment.calculatedAmount,
      );
    }

    // 5. Overdue debts
    const now = new Date();
    const overdueSales = await this.prisma.sale.findMany({
      where: {
        hasDebt: true,
        debtDueDate: { lt: now },
      },
    });

    let totalOverdueDebt = new Decimal(0);
    for (const os of overdueSales) {
      totalOverdueDebt = DecimalUtil.add(totalOverdueDebt, os.remainingAmount);
    }

    // 6. Inventory breakdown
    const inventoryGroup = await this.prisma.inventoryUnit.groupBy({
      by: ['status'],
      _count: { id: true },
    });

    const inventoryStats: Record<string, number> = {
      [InventoryUnitStatus.IN_STOCK]: 0,
      [InventoryUnitStatus.SOLD]: 0,
      [InventoryUnitStatus.IN_TRANSIT]: 0,
      [InventoryUnitStatus.EXPECTED]: 0,
    };
    for (const g of inventoryGroup) {
      inventoryStats[g.status] = g._count.id;
    }

    return {
      period: {
        startDate: filters.startDate || 'Барча давр',
        endDate: filters.endDate || 'Ҳозиргача',
      },
      orders: {
        totalOrders: orders.length,
        totalOrderPrice: DecimalUtil.formatMoney(totalOrderPrice),
        totalItemsCount,
      },
      sales: {
        totalSales: sales.length,
        plannedSalesTotal: DecimalUtil.formatMoney(plannedSalesTotal),
        actualSalesTotal: DecimalUtil.formatMoney(actualSalesTotal),
        totalOpenDebt: DecimalUtil.formatMoney(totalOpenDebt),
        totalOverdueDebt: DecimalUtil.formatMoney(totalOverdueDebt),
      },
      payments: {
        totalPaymentsCount: payments.length,
        uzsCashBank: DecimalUtil.formatMoney(totalUzsPayments, 'UZS'),
        usdTotal: DecimalUtil.formatMoney(totalUsdPayments, 'USD'),
        totalCalculatedUzs: DecimalUtil.formatMoney(totalCalculatedUzsPayments, 'UZS'),
      },
      reversals: {
        count: reversals.length,
        totalReversedAmount: DecimalUtil.formatMoney(totalReversedAmount),
      },
      inventory: inventoryStats,
    };
  }
}
