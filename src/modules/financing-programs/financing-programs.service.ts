import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class FinancingProgramsService {
  constructor(private readonly prisma: PrismaService) {}

  async listActive() {
    return this.prisma.financingProgram.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
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
}
