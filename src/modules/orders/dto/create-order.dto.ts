import { Decimal } from 'decimal.js';

export interface CreateOrderItemInput {
  category: string;
  brand: string;
  model: string;
  characteristics?: string;
  quantity: number;
  unitPrice: string | number | Decimal;
  devices?: Array<{
    imei1?: string;
    imei2?: string;
    barcode?: string;
    serialNumber?: string;
  }>;
}

export interface SubmitOrderDto {
  sellerId: string;
  programId: string;
  storeId: string;
  contractEndDate: string | Date;
  daftarRejected: boolean;
  customer: {
    fullName: string;
    phone1: string;
    phone2?: string;
    generalLimit: string | number | Decimal;
    withdrawableLimit: string | number | Decimal;
  };
  agentPercentage: string | number | Decimal;
  clientPayoutAmount: string | number | Decimal;
  items: CreateOrderItemInput[];
  attachmentIds: string[]; // must include at least 1 CONTRACT_SCREENSHOT and 1 PASSPORT_PHOTO
  businessDate?: Date;
}
