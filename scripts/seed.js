const { PrismaClient, RoleName } = require('@prisma/client');

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
    { name: 'Payme', requiresContinuation: true, code: 'PAYME' },
    { name: 'Trust 1 (Ishonch)', requiresContinuation: false, code: 'ISHONCH' },
    { name: 'Alif 6 ойлик', requiresContinuation: false, code: 'ALIF_6' },
    { name: 'Alif Кодирака', requiresContinuation: false, code: 'ALIF_KODIR' },
    { name: 'Anorbank', requiresContinuation: true, code: 'ANOR' },
    { name: 'Uzum Nasiya', requiresContinuation: true, code: 'UZUM' },
    { name: 'Бошқа дастур', requiresContinuation: true, code: 'OTHER' },
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
      name: 'Planet Phone',
      address: 'Тошкент ш., Малика савдо мажмуаси',
      phone: '+998901234567',
    },
    {
      name: 'Малика Савдо Маркази (12-дўкон)',
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
      name: 'Asadbek',
      ownerName: 'Asadbek',
      phone: '+998901112233',
      employees: ['Ходим 1', 'Ходим 2'],
    },
    {
      name: 'Davlatbek',
      ownerName: 'Davlatbek',
      phone: '+998931112233',
      employees: ['Гўзал', 'Алишер'],
    },
    {
      name: 'Nazirbek',
      ownerName: 'Nazirbek',
      phone: '+998903334455',
      employees: ['Ходим 1'],
    },
    {
      name: 'Ozoda',
      ownerName: 'Ozoda',
      phone: '+998904445566',
      employees: ['Ходим 1'],
    },
    {
      name: 'Apple',
      ownerName: 'Apple',
      phone: '+998905556677',
      employees: ['Ходим 1'],
    },
    {
      name: 'Farida',
      ownerName: 'Farida',
      phone: '+998906667788',
      employees: ['Ходим 1'],
    },
    {
      name: 'Nafisa',
      ownerName: 'Nafisa',
      phone: '+998907778899',
      employees: ['Ходим 1'],
    },
    {
      name: 'Jahongir',
      ownerName: 'Jahongir',
      phone: '+998908889900',
      employees: ['Ходим 1'],
    },
    {
      name: 'Anvar',
      ownerName: 'Anvar',
      phone: '+998909990011',
      employees: ['Ходим 1'],
    },
    {
      name: 'Sardor',
      ownerName: 'Sardor',
      phone: '+998973334455',
      employees: ['Умид', 'Жасур'],
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
    // don't fail startup if seed encounters non-critical conflict
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
