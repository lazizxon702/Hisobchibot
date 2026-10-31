import { PrismaClient, RoleName } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding initial data...');

  // 1. Seed Roles
  const roles = [
    RoleName.SUPER_ADMIN,
    RoleName.SELLER,
    RoleName.DAFTAR_REVIEWER,
    RoleName.CONTINUATION_OPERATOR,
  ];

  for (const roleName of roles) {
    await prisma.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName },
    });
  }
  console.log('✓ Roles seeded.');

  // 2. Seed Financing Programs
  const programs = [
    { name: 'Trust 1 (Ishonch)', requiresContinuation: false, code: 'TRUST_1' },
    { name: 'Alif 6 ойлик', requiresContinuation: false, code: 'ALIF_6M' },
    { name: 'Alif Кодирака', requiresContinuation: false, code: 'ALIF_KODIRAKA' },
    { name: 'Бошқа', requiresContinuation: true, code: 'OTHER' },
  ];

  for (const p of programs) {
    await prisma.financingProgram.upsert({
      where: { name: p.name },
      update: { requiresContinuation: p.requiresContinuation },
      create: p,
    });
  }
  console.log('✓ Financing programs seeded.');

  // 3. Seed Sample Stores
  const stores = [
    {
      name: 'Малика Савдо Маркази (Дўкон 12)',
      address: 'Тошкент ш., Шайхонтоҳур т., Кичик Ҳалқа Йўли',
      phone: '+998901234567',
    },
    {
      name: 'Абу Сахий (Блок А-15)',
      address: 'Тошкент ш., Чилонзор т., Бектемир йўли',
      phone: '+998909876543',
    },
  ];

  for (const store of stores) {
    await prisma.store.upsert({
      where: { name: store.name },
      update: {},
      create: store,
    });
  }
  console.log('✓ Sample stores seeded.');

  // 4. Seed Sample Agencies & Employees
  const agencies = [
    {
      name: 'Ishonch Agency',
      ownerName: 'Каримов Сардор',
      phone: '+998931112233',
      employees: ['Алимов Жасур', 'Бозоров Дилшод'],
    },
    {
      name: 'Grand Finance',
      ownerName: 'Тоҳиров Улуғбек',
      phone: '+998973334455',
      employees: ['Раҳимов Бобур'],
    },
  ];

  for (const ag of agencies) {
    const createdAgency = await prisma.agency.upsert({
      where: { name: ag.name },
      update: { ownerName: ag.ownerName, phone: ag.phone },
      create: { name: ag.name, ownerName: ag.ownerName, phone: ag.phone },
    });

    for (const empName of ag.employees) {
      const existing = await prisma.agencyEmployee.findFirst({
        where: { agencyId: createdAgency.id, fullName: empName },
      });
      if (!existing) {
        await prisma.agencyEmployee.create({
          data: {
            agencyId: createdAgency.id,
            fullName: empName,
            phone: '+998900000000',
          },
        });
      }
    }
  }
  console.log('✓ Sample agencies and employees seeded.');

  // 5. System Settings
  const settings = [
    { key: 'requireVideoForDebtlessSales', value: 'false', description: 'Қарзсиз сотувларда видео талаб қилиш' },
    { key: 'autoCalculateCommission', value: 'false', description: 'Агент фоизидан автоматик комиссия ҳисоблаш' },
    { key: 'appTimezone', value: 'Asia/Tashkent', description: 'Тизим вақт минтақаси' },
  ];

  for (const s of settings) {
    await prisma.systemSetting.upsert({
      where: { key: s.key },
      update: { value: s.value },
      create: s,
    });
  }
  console.log('✓ System settings seeded.');

  // 6. Super Admin creation if SUPER_ADMIN_TELEGRAM_ID is configured
  const adminTelegramId = process.env.SUPER_ADMIN_TELEGRAM_ID;
  if (adminTelegramId && adminTelegramId !== '0') {
    const tgId = BigInt(adminTelegramId);
    let adminUser = await prisma.user.findUnique({ where: { telegramId: tgId } });
    const superAdminRole = await prisma.role.findUnique({ where: { name: RoleName.SUPER_ADMIN } });

    if (!adminUser) {
      adminUser = await prisma.user.create({
        data: {
          telegramId: tgId,
          firstName: 'Super',
          lastName: 'Admin',
          isActive: true,
          isApproved: true,
        },
      });
    }

    if (superAdminRole) {
      await prisma.userRole.upsert({
        where: {
          userId_roleId: {
            userId: adminUser.id,
            roleId: superAdminRole.id,
          },
        },
        update: {},
        create: {
          userId: adminUser.id,
          roleId: superAdminRole.id,
        },
      });
    }
    console.log(`✓ Super admin configured for Telegram ID: ${adminTelegramId}`);
  }

  console.log('Seeding finished successfully.');
}

main()
  .catch((e) => {
    console.error('Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
