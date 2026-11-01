const { PrismaClient } = require('@prisma/client');
const { execSync } = require('child_process');

async function main() {
  console.log('--- PRESTART STARTING ---');
  try {
    const prisma = new PrismaClient();
    await prisma.$connect();
    try {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "_prisma_migrations" CASCADE;`);
      console.log('✓ Cleaned _prisma_migrations table.');
    } catch (e) {
      console.log('Cleanup note:', e.message);
    } finally {
      await prisma.$disconnect();
    }
  } catch (err) {
    console.log('Prestart DB connect note:', err.message);
  }

  try {
    console.log('Running prisma db push...');
    execSync('npx prisma db push --accept-data-loss', { stdio: 'inherit' });
  } catch (err) {
    console.error('db push error:', err.message);
  }

  try {
    console.log('Running seed...');
    execSync('node scripts/seed.js', { stdio: 'inherit' });
  } catch (err) {
    console.error('seed error:', err.message);
  }

  console.log('--- STARTING NESTJS MAIN APPLICATION ---');
  require('../dist/src/main.js');
}

main().catch((err) => {
  console.error('Fatal prestart error:', err);
  process.exit(1);
});
