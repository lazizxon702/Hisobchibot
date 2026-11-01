import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class FinancingProgramsService {
  constructor(private readonly prisma: PrismaService) {}

  async listActive() {
    let progs = await this.prisma.financingProgram.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });

    if (progs.length === 0) {
      const defaults = [
        { name: 'Trust 1 (Ishonch)', requiresContinuation: false, code: 'TRUST_1', isActive: true },
        { name: 'Alif 6 ойлик', requiresContinuation: false, code: 'ALIF_6M', isActive: true },
        { name: 'Alif Кодирака', requiresContinuation: false, code: 'ALIF_KODIRAKA', isActive: true },
        { name: 'Payme', requiresContinuation: true, code: 'PAYME', isActive: true },
        { name: 'Anorbank', requiresContinuation: true, code: 'ANOR', isActive: true },
        { name: 'Uzum Nasiya', requiresContinuation: true, code: 'UZUM', isActive: true },
        { name: 'Бошқа дастур', requiresContinuation: true, code: 'OTHER', isActive: true },
      ];
      for (const d of defaults) {
        await this.prisma.financingProgram.upsert({
          where: { name: d.name },
          update: { isActive: true },
          create: d,
        });
      }
      progs = await this.prisma.financingProgram.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
      });
    }

    return progs;
  }

  async getById(id: string) {
    const program = await this.prisma.financingProgram.findUnique({ where: { id } });
    if (!program) {
      throw new NotFoundException(`Дастур топилмади: ${id}`);
    }
    return program;
  }

  async create(name: string, requiresContinuation: boolean, code?: string) {
    return this.prisma.financingProgram.create({
      data: {
        name,
        requiresContinuation,
        code,
      },
    });
  }

  async update(id: string, data: { name?: string; requiresContinuation?: boolean; isActive?: boolean }) {
    return this.prisma.financingProgram.update({
      where: { id },
      data,
    });
  }

  async findOrCreateCustom(name: string) {
    const trimmed = name.trim();
    let program = await this.prisma.financingProgram.findUnique({
      where: { name: trimmed },
    });
    if (!program) {
      program = await this.prisma.financingProgram.create({
        data: {
          name: trimmed,
          requiresContinuation: true,
          isActive: false,
        },
      });
    }
    return program;
  }
}

