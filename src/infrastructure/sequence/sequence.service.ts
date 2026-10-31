import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SequenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically increments and gets the next sequence number for a sequence name.
   * Completely race-condition proof without MAX+1.
   */
  async getNextSequence(name: string): Promise<bigint> {
    const result: Array<{ currentValue: bigint }> = await this.prisma.$queryRawUnsafe(
      `INSERT INTO "IdSequence" ("name", "currentValue")
       VALUES ($1, 1)
       ON CONFLICT ("name")
       DO UPDATE SET "currentValue" = "IdSequence"."currentValue" + 1
       RETURNING "currentValue";`,
      name,
    );

    if (result && result.length > 0) {
      return BigInt(result[0].currentValue);
    }
    return BigInt(1);
  }

  async generateOrderNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const seqName = `ORDER_SEQ_${year}`;
    const nextVal = await this.getNextSequence(seqName);
    const padded = nextVal.toString().padStart(6, '0');
    return `ORD-${year}-${padded}`;
  }

  async generateReceiptNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const seqName = `PAYMENT_SEQ_${year}`;
    const nextVal = await this.getNextSequence(seqName);
    const padded = nextVal.toString().padStart(6, '0');
    return `PAY-${year}-${padded}`;
  }

  async generateCheckNumber(): Promise<number> {
    const result: Array<{ currentValue: bigint }> = await this.prisma.$queryRawUnsafe(
      `INSERT INTO "IdSequence" ("name", "currentValue")
       VALUES ('CHECK_SEQ', 3531)
       ON CONFLICT ("name")
       DO UPDATE SET "currentValue" = "IdSequence"."currentValue" + 1
       RETURNING "currentValue";`,
    );
    if (result && result.length > 0) {
      return Number(result[0].currentValue);
    }
    return 3531;
  }
}
