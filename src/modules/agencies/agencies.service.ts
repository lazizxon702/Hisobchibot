import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class AgenciesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.agency.findMany({
      include: { employees: true },
      orderBy: { name: 'asc' },
    });
  }

  async getById(id: string) {
    const agency = await this.prisma.agency.findUnique({
      where: { id },
      include: { employees: true },
    });
    if (!agency) {
      throw new NotFoundException(`Агентлик топилмади: ${id}`);
    }
    return agency;
  }

  async createAgency(name: string, ownerName: string, phone?: string) {
    return this.prisma.agency.create({
      data: { name, ownerName, phone },
    });
  }

  async addEmployee(agencyId: string, fullName: string, phone?: string) {
    await this.getById(agencyId);
    return this.prisma.agencyEmployee.create({
      data: { agencyId, fullName, phone },
    });
  }

  async getEmployeesByAgency(agencyId: string) {
    return this.prisma.agencyEmployee.findMany({
      where: { agencyId },
      orderBy: { fullName: 'asc' },
    });
  }
}
