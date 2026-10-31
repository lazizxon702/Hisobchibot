import { Injectable, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RoleName, User } from '@prisma/client';

export interface TelegramUserData {
  id: number | bigint;
  first_name?: string;
  last_name?: string;
  username?: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findOrCreateTelegramUser(tgUser: TelegramUserData): Promise<User & { roles: { role: { name: RoleName } }[] }> {
    const tgId = BigInt(tgUser.id);
    let user = await this.prisma.user.findUnique({
      where: { telegramId: tgId },
      include: { roles: { include: { role: true } } },
    });

    if (!user) {
      // Auto-assign SUPER_ADMIN if matches env config
      const isSuperAdminEnv =
        process.env.SUPER_ADMIN_TELEGRAM_ID &&
        process.env.SUPER_ADMIN_TELEGRAM_ID !== '0' &&
        BigInt(process.env.SUPER_ADMIN_TELEGRAM_ID) === tgId;

      user = await this.prisma.user.create({
        data: {
          telegramId: tgId,
          firstName: tgUser.first_name,
          lastName: tgUser.last_name,
          username: tgUser.username,
          isActive: true,
          isApproved: isSuperAdminEnv ? true : false,
        },
        include: { roles: { include: { role: true } } },
      });

      if (isSuperAdminEnv) {
        const adminRole = await this.prisma.role.upsert({
          where: { name: RoleName.SUPER_ADMIN },
          update: {},
          create: { name: RoleName.SUPER_ADMIN },
        });
        await this.prisma.userRole.create({
          data: { userId: user.id, roleId: adminRole.id },
        });

        user = (await this.prisma.user.findUnique({
          where: { id: user.id },
          include: { roles: { include: { role: true } } },
        }))!;
      }

      await this.audit.log({
        entityName: 'User',
        entityId: user.id,
        action: 'USER_REGISTERED',
        newValue: { telegramId: user.telegramId.toString(), isApproved: user.isApproved },
      });
    } else {
      const isSuperAdminEnv =
        process.env.SUPER_ADMIN_TELEGRAM_ID &&
        process.env.SUPER_ADMIN_TELEGRAM_ID !== '0' &&
        BigInt(process.env.SUPER_ADMIN_TELEGRAM_ID) === tgId;

      const hasAdminRole = user.roles.some((r) => r.role.name === RoleName.SUPER_ADMIN);

      if (isSuperAdminEnv && (!user.isApproved || !hasAdminRole)) {
        const adminRole = await this.prisma.role.upsert({
          where: { name: RoleName.SUPER_ADMIN },
          update: {},
          create: { name: RoleName.SUPER_ADMIN },
        });

        await this.prisma.user.update({
          where: { id: user.id },
          data: { isApproved: true, isActive: true },
        });

        await this.prisma.userRole.upsert({
          where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
          update: {},
          create: { userId: user.id, roleId: adminRole.id },
        });

        user = (await this.prisma.user.findUnique({
          where: { id: user.id },
          include: { roles: { include: { role: true } } },
        }))!;
      }
    }

    return user;
  }

  async getUserById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { roles: { include: { role: true } } },
    });
    if (!user) {
      throw new NotFoundException(`Фойдаланувчи топилмади: ${id}`);
    }
    return user;
  }

  async getUserByTelegramId(telegramId: bigint | number) {
    return this.prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      include: { roles: { include: { role: true } } },
    });
  }

  async hasRole(userId: string, roleName: RoleName): Promise<boolean> {
    const user = await this.getUserById(userId);
    if (!user.isActive || !user.isApproved) return false;
    const isSuperAdmin = user.roles.some((r) => r.role.name === RoleName.SUPER_ADMIN);
    if (isSuperAdmin) return true; // Super Admin has management override
    return user.roles.some((r) => r.role.name === roleName);
  }

  async hasExactRole(userId: string, roleName: RoleName): Promise<boolean> {
    const user = await this.getUserById(userId);
    return user.roles.some((r) => r.role.name === roleName);
  }

  async approveUser(adminId: string, targetUserId: string, roleNames: RoleName[]): Promise<User> {
    const isAdmin = await this.hasRole(adminId, RoleName.SUPER_ADMIN);
    if (!isAdmin) {
      throw new ForbiddenException('Фақат SUPER_ADMIN фойдаланувчини тасдиқлай олади');
    }

    const targetUser = await this.getUserById(targetUserId);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: targetUserId },
        data: { isApproved: true, isActive: true },
      });

      // Clear existing roles
      await tx.userRole.deleteMany({ where: { userId: targetUserId } });

      // Assign new roles
      for (const roleName of roleNames) {
        const role = await tx.role.findUnique({ where: { name: roleName } });
        if (role) {
          await tx.userRole.create({
            data: { userId: targetUserId, roleId: role.id },
          });
        }
      }

      await this.audit.log(
        {
          entityName: 'User',
          entityId: targetUserId,
          action: 'USER_APPROVED',
          performedById: adminId,
          oldValue: { isApproved: targetUser.isApproved },
          newValue: { isApproved: true, roles: roleNames },
        },
        tx,
      );

      return updated;
    });
  }

  async listPendingUsers() {
    return this.prisma.user.findMany({
      where: { isApproved: false },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listStaffUsers() {
    return this.prisma.user.findMany({
      where: { isApproved: true, isActive: true },
      include: { roles: { include: { role: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getContinuationOperators() {
    return this.prisma.user.findMany({
      where: {
        isApproved: true,
        isActive: true,
        roles: {
          some: {
            role: {
              name: {
                in: [RoleName.CONTINUATION_OPERATOR, RoleName.SUPER_ADMIN],
              },
            },
          },
        },
      },
      select: {
        id: true,
        telegramId: true,
        firstName: true,
        lastName: true,
        username: true,
      },
    });
  }

  async addAdminByTelegramId(adminId: string, telegramId: string | bigint | number): Promise<User> {
    const isAdmin = await this.hasRole(adminId, RoleName.SUPER_ADMIN);
    if (!isAdmin) {
      throw new ForbiddenException('Фақат SUPER_ADMIN янги админ қўша олади');
    }

    const tgId = BigInt(telegramId);
    const adminRole = await this.prisma.role.upsert({
      where: { name: RoleName.SUPER_ADMIN },
      update: {},
      create: { name: RoleName.SUPER_ADMIN },
    });

    let targetUser = await this.prisma.user.findUnique({
      where: { telegramId: tgId },
    });

    if (!targetUser) {
      targetUser = await this.prisma.user.create({
        data: {
          telegramId: tgId,
          firstName: 'Admin',
          isActive: true,
          isApproved: true,
        },
      });
    } else {
      targetUser = await this.prisma.user.update({
        where: { id: targetUser.id },
        data: { isActive: true, isApproved: true },
      });
    }

    await this.prisma.userRole.upsert({
      where: {
        userId_roleId: { userId: targetUser.id, roleId: adminRole.id },
      },
      update: {},
      create: { userId: targetUser.id, roleId: adminRole.id },
    });

    await this.audit.log({
      entityName: 'User',
      entityId: targetUser.id,
      action: 'ADMIN_PROMOTED',
      performedById: adminId,
      newValue: { telegramId: tgId.toString(), role: RoleName.SUPER_ADMIN },
    });

    return targetUser;
  }

  async listAdmins() {
    return this.prisma.user.findMany({
      where: {
        roles: {
          some: {
            role: { name: RoleName.SUPER_ADMIN },
          },
        },
      },
      include: {
        roles: { include: { role: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }
}
