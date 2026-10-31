import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DecimalUtil } from '../../common/decimal.util';
import { Decimal } from 'decimal.js';

export interface CreateCustomerDto {
  fullName: string;
  phone1: string;
  phone2?: string;
  generalLimit: string | number | Decimal;
  withdrawableLimit: string | number | Decimal;
}

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  normalizePhone(phone: string): string {
    const digits = phone.replace(/[^\d+]/g, '');
    if (digits.startsWith('+')) return digits;
    if (digits.length === 9) return `+998${digits}`;
    if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
    return digits;
  }

  async createOrUpdateCustomer(dto: CreateCustomerDto) {
    const generalLimit = DecimalUtil.toDecimal(dto.generalLimit);
    const withdrawableLimit = DecimalUtil.toDecimal(dto.withdrawableLimit);

    if (!DecimalUtil.isPositive(generalLimit)) {
      throw new BadRequestException('Умумий лимит мусбат сумма бўлиши керак');
    }

    if (!DecimalUtil.isPositive(withdrawableLimit)) {
      throw new BadRequestException('Ечиладиган лимит мусбат сумма бўлиши керак');
    }

    // Business rule (Section 5.13): withdrawableLimit <= generalLimit
    if (DecimalUtil.isGreaterThan(withdrawableLimit, generalLimit)) {
      throw new BadRequestException('Ечиладиган лимит суммаси умумий лимитдан ошмаслиги керак');
    }

    const normPhone1 = this.normalizePhone(dto.phone1);
    const normPhone2 = dto.phone2 ? this.normalizePhone(dto.phone2) : null;

    let customer = await this.prisma.customer.findFirst({
      where: { phone1: normPhone1 },
    });

    if (customer) {
      customer = await this.prisma.customer.update({
        where: { id: customer.id },
        data: {
          fullName: dto.fullName.trim(),
          phone2: normPhone2,
          generalLimit,
          withdrawableLimit,
        },
      });
    } else {
      customer = await this.prisma.customer.create({
        data: {
          fullName: dto.fullName.trim(),
          phone1: normPhone1,
          phone2: normPhone2,
          generalLimit,
          withdrawableLimit,
        },
      });
    }

    return customer;
  }

  async findOrCreateBuyer(data: {
    fullName: string;
    phone: string;
    address?: string;
    shopNumber?: string;
    latitude?: number;
    longitude?: number;
  }) {
    const normPhone = this.normalizePhone(data.phone);
    let buyer = await this.prisma.buyer.findFirst({
      where: { phone: normPhone },
    });

    if (buyer) {
      buyer = await this.prisma.buyer.update({
        where: { id: buyer.id },
        data: {
          fullName: data.fullName.trim(),
          address: data.address || buyer.address,
          shopNumber: data.shopNumber || buyer.shopNumber,
          latitude: data.latitude ?? buyer.latitude,
          longitude: data.longitude ?? buyer.longitude,
        },
      });
    } else {
      buyer = await this.prisma.buyer.create({
        data: {
          fullName: data.fullName.trim(),
          phone: normPhone,
          address: data.address,
          shopNumber: data.shopNumber,
          latitude: data.latitude,
          longitude: data.longitude,
        },
      });
    }

    return buyer;
  }
}
