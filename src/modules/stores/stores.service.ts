import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.store.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async getById(id: string) {
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) {
      throw new NotFoundException(`Магазин топилмади: ${id}`);
    }
    return store;
  }

  async create(name: string, address: string, phone?: string) {
    return this.prisma.store.create({
      data: { name, address, phone },
    });
  }
}
