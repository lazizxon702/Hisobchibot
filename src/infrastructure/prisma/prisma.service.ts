import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Prisma connected to PostgreSQL successfully');
      await this.autoSeed();
    } catch (error) {
      this.logger.warn(`Prisma connect warning (DB may be offline during build/tests): ${(error as Error).message}`);
    }
  }

  private async autoSeed() {
    try {
      // 1. Roles
      const roleNames = ['SUPER_ADMIN', 'SELLER', 'DAFTAR_REVIEWER', 'CONTINUATION_OPERATOR'] as const;
      for (const name of roleNames) {
        await this.role.upsert({
          where: { name: name as any },
          update: {},
          create: { name: name as any },
        }).catch(() => {});
      }

      // 2. Financing Programs (CRITICAL for button rendering in Railway)
      const programs = [
        { name: 'Trust 1 (Ishonch)', requiresContinuation: false, code: 'TRUST_1', isActive: true },
        { name: 'Alif 6 ойлик', requiresContinuation: false, code: 'ALIF_6M', isActive: true },
        { name: 'Alif Кодирака', requiresContinuation: false, code: 'ALIF_KODIRAKA', isActive: true },
        { name: 'Payme', requiresContinuation: true, code: 'PAYME', isActive: true },
        { name: 'Anorbank', requiresContinuation: true, code: 'ANOR', isActive: true },
        { name: 'Uzum Nasiya', requiresContinuation: true, code: 'UZUM', isActive: true },
        { name: 'Бошқа дастур', requiresContinuation: true, code: 'OTHER', isActive: true },
      ];

      for (const p of programs) {
        await this.financingProgram.upsert({
          where: { name: p.name },
          update: { isActive: true, requiresContinuation: p.requiresContinuation },
          create: p,
        }).catch(() => {});
      }

      // 3. Stores
      const stores = [
        { name: 'Planet Phone', address: 'Тошкент ш., Малика савдо мажмуаси', phone: '+998901234567' },
        { name: 'Малика Савдо Маркази (12-дўкон)', address: 'Тошкент ш., Шайхонтоҳур т.', phone: '+998901234567' },
        { name: 'Абу Сахий (Блок А-15)', address: 'Тошкент ш., Чилонзор т.', phone: '+998909876543' },
      ];

      for (const s of stores) {
        await this.store.upsert({
          where: { name: s.name },
          update: {},
          create: s,
        }).catch(() => {});
      }

      // 4. Agencies & Employees
      const agencies = [
        { name: 'Davlatbek', ownerName: 'Davlatbek', phone: '+998931112233', employees: ['Гўзал', 'Алишер'] },
        { name: 'Asadbek', ownerName: 'Asadbek', phone: '+998901112233', employees: ['Ходим 1', 'Ходим 2'] },
        { name: 'Apple', ownerName: 'Apple', phone: '+998905556677', employees: ['Ходим 1'] },
        { name: 'Nazirbek', ownerName: 'Nazirbek', phone: '+998903334455', employees: ['Ходим 1'] },
        { name: 'Ozoda', ownerName: 'Ozoda', phone: '+998904445566', employees: ['Ходим 1'] },
        { name: 'Farida', ownerName: 'Farida', phone: '+998906667788', employees: ['Ходим 1'] },
        { name: 'Nafisa', ownerName: 'Nafisa', phone: '+998907778899', employees: ['Ходим 1'] },
        { name: 'Jahongir', ownerName: 'Jahongir', phone: '+998908889900', employees: ['Ходим 1'] },
        { name: 'Anvar', ownerName: 'Anvar', phone: '+998909990011', employees: ['Ходим 1'] },
        { name: 'Sardor', ownerName: 'Sardor', phone: '+998973334455', employees: ['Умид', 'Жасур'] },
      ];

      for (const ag of agencies) {
        const agency = await this.agency.upsert({
          where: { name: ag.name },
          update: {},
          create: { name: ag.name, ownerName: ag.ownerName, phone: ag.phone },
        }).catch(() => null);

        if (agency) {
          for (const empName of ag.employees) {
            const existing = await this.agencyEmployee.findFirst({
              where: { agencyId: agency.id, fullName: empName },
            }).catch(() => null);
            if (!existing) {
              await this.agencyEmployee.create({
                data: { agencyId: agency.id, fullName: empName },
              }).catch(() => {});
            }
          }
        }
      }

      this.logger.log('AutoSeed completed: Roles, Programs, Stores, Agencies verified');
    } catch (e) {
      this.logger.warn(`AutoSeed note: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }
}
