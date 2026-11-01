const { PrismaClient } = require('@prisma/client');
const { execSync } = require('child_process');

async function cleanFailedMigrations() {
  console.log('Running prestart migration resolver...');
  try {
    const prisma = new PrismaClient();
    await prisma.$connect();
    try {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "_prisma_migrations" CASCADE;`);
      console.log('✓ Cleaned _prisma_migrations table successfully.');
    } catch (e) {
      console.log('Note on migrations table cleanup:', e.message);
    } finally {
      await prisma.$disconnect();
    }
  } catch (err) {
    console.log('Prestart DB connect note:', err.message);
  }

  // Push latest schema to database
  try {
    console.log('Syncing database schema with prisma db push...');
    execSync('npx prisma db push --accept-data-loss', { stdio: 'inherit' });
    console.log('✓ Database schema synced.');
  } catch (err) {
    console.error('db push error:', err.message);
  }

  // Seed initial data
  try {
    console.log('Running seed script...');
    execSync('node scripts/seed.js', { stdio: 'inherit' });
    console.log('✓ Seed completed.');
  } catch (err) {
    console.error('seed error:', err.message);
  }

  // Start the application
  console.log('Starting NestJS application...');
  execSync('node dist/src/main.js', { stdio: 'inherit' });
}

cleanFailedMigrations();
