import * as ExcelJS from 'exceljs';
import { DateUtil } from './date.util';
import { DecimalUtil } from './decimal.util';

export interface OrderExportRecord {
  id: string;
  checkNumber?: number | null;
  orderNumber: string;
  omborStatus?: string | null;
  status: string;
  createdAt: Date;
  businessDate?: Date | null;
  contractEndDate?: Date | null;
  agentPercentage?: any;
  clientPayoutAmount?: any;
  totalPrice?: any;
  totalQuantity?: number | null;
  seller?: {
    firstName?: string | null;
    lastName?: string | null;
    telegramId?: bigint | number | null;
  } | null;
  program?: {
    name: string;
  } | null;
  store?: {
    name: string;
    address?: string | null;
  } | null;
  agency?: {
    name: string;
  } | null;
  agencyEmployee?: {
    fullName: string;
  } | null;
  customer?: {
    fullName: string;
    phone1: string;
    phone2?: string | null;
    generalLimit?: any;
    withdrawableLimit?: any;
  } | null;
  items?: Array<{
    category?: string | null;
    brand?: string | null;
    model: string;
    quantity: number;
    unitPrice: any;
    totalPrice: any;
  }>;
  inventoryUnits?: Array<{
    imei1?: string | null;
    barcode?: string | null;
    status: string;
  }>;
  daftarReviews?: Array<{
    status: string;
    comment?: string | null;
  }>;
  sales?: Array<{
    actualSalePrice: any;
    plannedSalePrice: any;
    paidAmount: any;
    remainingAmount: any;
    paymentStatus: string;
    hasDebt: boolean;
    debtDueDate?: Date | null;
    buyer?: {
      fullName: string;
      phone: string;
      address?: string | null;
    } | null;
    operator?: {
      firstName?: string | null;
      lastName?: string | null;
    } | null;
  }>;
}

export class ExcelUtil {
  static async generateOrdersWorkbook(orders: OrderExportRecord[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Hisobchi Bot';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Чеклар рўйхати', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { defaultRowHeight: 22 },
    });

    sheet.columns = [
      { header: '№', key: 'idx', width: 6 },
      { header: 'Чек №', key: 'checkNumber', width: 12 },
      { header: 'Буюртма №', key: 'orderNumber', width: 22 },
      { header: 'Урилган сана ва вақт', key: 'dateTime', width: 20 },
      { header: 'Омбор ҳолати', key: 'omborStatus', width: 24 },
      { header: 'Буюртма ҳолати', key: 'status', width: 18 },
      { header: 'Дафтар ҳолати', key: 'daftarStatus', width: 18 },
      { header: 'Сотувчи (Ф.И.Ш.)', key: 'sellerName', width: 22 },
      { header: 'Сотувчи Telegram ID', key: 'sellerTgId', width: 20 },
      { header: 'Дастур (Илова)', key: 'programName', width: 18 },
      { header: 'Дўкон номи', key: 'storeName', width: 20 },
      { header: 'Дўкон манзили', key: 'storeAddress', width: 26 },
      { header: 'Агент', key: 'agencyName', width: 18 },
      { header: 'Агент ходими', key: 'agencyEmployee', width: 18 },
      { header: 'Мижоз (Ф.И.Ш.)', key: 'customerName', width: 24 },
      { header: 'Мижоз телефони 1', key: 'customerPhone1', width: 18 },
      { header: 'Мижоз телефони 2', key: 'customerPhone2', width: 18 },
      { header: 'Мижоз умумий лимити', key: 'generalLimit', width: 22 },
      { header: 'Ечиладиган лимит', key: 'withdrawableLimit', width: 22 },
      { header: 'Маҳсулот прайс нархи', key: 'productPrice', width: 22 },
      { header: 'Агент %', key: 'agentPercentage', width: 12 },
      { header: 'Клиентга бериладиган сумма', key: 'clientPayoutAmount', width: 24 },
      { header: 'Маҳсулот номи', key: 'productName', width: 26 },
      { header: 'Сони (дона)', key: 'quantity', width: 14 },
      { header: 'IMEI / Баркод', key: 'imeiBarcode', width: 22 },
      { header: 'Шартнома тугаш муддати', key: 'contractEndDate', width: 20 },
      { header: '2-босқич оператори', key: 'operatorName', width: 22 },
      { header: 'Харидор (Ф.И.Ш.)', key: 'buyerName', width: 22 },
      { header: 'Харидор телефони', key: 'buyerPhone', width: 18 },
      { header: 'Харидор манзили', key: 'buyerAddress', width: 26 },
      { header: 'Сотилиш нархи (Режавий)', key: 'plannedPrice', width: 22 },
      { header: 'Сотилган нарх (Ҳақиқий)', key: 'actualPrice', width: 22 },
      { header: 'Тўланган сумма', key: 'paidAmount', width: 20 },
      { header: 'Қолдиқ қарз суммаси', key: 'remainingAmount', width: 22 },
      { header: 'Қарз ёпиш муддати', key: 'debtDueDate', width: 18 },
      { header: 'Тўлов статуси', key: 'paymentStatus', width: 18 },
    ];

    // Style Header Row
    const headerRow = sheet.getRow(1);
    headerRow.height = 30;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1F4E79' }, // Dark professional navy
      };
      cell.font = {
        name: 'Arial',
        size: 11,
        bold: true,
        color: { argb: 'FFFFFFFF' },
      };
      cell.alignment = {
        vertical: 'middle',
        horizontal: 'center',
        wrapText: true,
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        bottom: { style: 'medium', color: { argb: 'FFFFFFFF' } },
        right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
      };
    });

    // Populate Data Rows
    orders.forEach((o, index) => {
      const sellerName = [o.seller?.firstName, o.seller?.lastName].filter(Boolean).join(' ') || '—';
      const sellerTgId = o.seller?.telegramId ? o.seller.telegramId.toString() : '—';
      const customerName = o.customer?.fullName || '—';
      const prodName = o.items?.[0]?.model || `${o.program?.name || '—'} — 1 ta`;
      const prodQty = o.items?.[0]?.quantity || o.totalQuantity || 1;
      const imei = o.inventoryUnits?.[0]?.imei1 || o.inventoryUnits?.[0]?.barcode || '—';
      const latestReview = o.daftarReviews?.[0];
      const daftarStatus = latestReview?.status || 'PENDING';

      const sale = o.sales?.[0];
      const operatorName = [sale?.operator?.firstName, sale?.operator?.lastName].filter(Boolean).join(' ') || '—';
      const buyerName = sale?.buyer?.fullName || '—';
      const buyerPhone = sale?.buyer?.phone || '—';
      const buyerAddress = sale?.buyer?.address || '—';

      const row = sheet.addRow({
        idx: index + 1,
        checkNumber: o.checkNumber ? `#${o.checkNumber}` : '—',
        orderNumber: o.orderNumber,
        dateTime: DateUtil.formatTashkent(o.createdAt, 'DD.MM.YYYY HH:mm:ss'),
        omborStatus: o.omborStatus || 'Tasdiqlash kutilmoqda',
        status: o.status,
        daftarStatus: daftarStatus,
        sellerName,
        sellerTgId,
        programName: o.program?.name || '—',
        storeName: o.store?.name || '—',
        storeAddress: o.store?.address || '—',
        agencyName: o.agency?.name || '—',
        agencyEmployee: o.agencyEmployee?.fullName || '—',
        customerName,
        customerPhone1: o.customer?.phone1 || '—',
        customerPhone2: o.customer?.phone2 || '—',
        generalLimit: o.customer?.generalLimit ? Number(o.customer.generalLimit) : null,
        withdrawableLimit: o.customer?.withdrawableLimit ? Number(o.customer.withdrawableLimit) : null,
        productPrice: o.totalPrice ? Number(o.totalPrice) : null,
        agentPercentage: o.agentPercentage !== undefined ? `${o.agentPercentage}%` : '—',
        clientPayoutAmount: o.clientPayoutAmount ? Number(o.clientPayoutAmount) : null,
        productName: prodName,
        quantity: prodQty,
        imeiBarcode: imei,
        contractEndDate: o.contractEndDate ? DateUtil.formatDateTashkent(o.contractEndDate) : '—',
        operatorName,
        buyerName,
        buyerPhone,
        buyerAddress,
        plannedPrice: sale?.plannedSalePrice ? Number(sale.plannedSalePrice) : null,
        actualPrice: sale?.actualSalePrice ? Number(sale.actualSalePrice) : null,
        paidAmount: sale?.paidAmount ? Number(sale.paidAmount) : null,
        remainingAmount: sale?.remainingAmount ? Number(sale.remainingAmount) : null,
        debtDueDate: sale?.debtDueDate ? DateUtil.formatDateTashkent(sale.debtDueDate) : '—',
        paymentStatus: sale?.paymentStatus || '—',
      });

      row.height = 24;

      const isEven = index % 2 === 1;
      const rowBgColor = isEven ? 'FFF9FAFB' : 'FFFFFFFF'; // Light alternating zebra striping

      row.eachCell((cell, colNumber) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: rowBgColor },
        };
        cell.font = { name: 'Arial', size: 10 };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        };

        // Alignments & Number formats
        // Columns 1, 2, 4, 5, 6, 7, 9, 21, 24, 25, 26, 35, 36: Center
        if ([1, 2, 4, 5, 6, 7, 9, 21, 24, 25, 26, 35, 36].includes(colNumber)) {
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        } else if ([18, 19, 20, 22, 31, 32, 33, 34].includes(colNumber)) {
          // Money columns: Right aligned with proper number formatting
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          cell.numFmt = '#,##0" so\'m"';
        } else {
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        }
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
