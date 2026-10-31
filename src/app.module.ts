import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { SequenceModule } from './infrastructure/sequence/sequence.module';
import { OutboxModule } from './infrastructure/outbox/outbox.module';
import { HealthModule } from './infrastructure/health/health.module';

import { AuditModule } from './modules/audit/audit.module';
import { UsersModule } from './modules/users/users.module';
import { FinancingProgramsModule } from './modules/financing-programs/financing-programs.module';
import { StoresModule } from './modules/stores/stores.module';
import { AgenciesModule } from './modules/agencies/agencies.module';
import { CustomersModule } from './modules/customers/customers.module';
import { OrdersModule } from './modules/orders/orders.module';
import { DaftarModule } from './modules/daftar/daftar.module';
import { AssignmentsModule } from './modules/assignments/assignments.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { SalesModule } from './modules/sales/sales.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { DebtsModule } from './modules/debts/debts.module';
import { RemindersModule } from './modules/reminders/reminders.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { ReportsModule } from './modules/reports/reports.module';

import { BotModule } from './bot/bot.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    StorageModule,
    SequenceModule,
    OutboxModule,
    HealthModule,
    AuditModule,
    UsersModule,
    FinancingProgramsModule,
    StoresModule,
    AgenciesModule,
    CustomersModule,
    OrdersModule,
    DaftarModule,
    AssignmentsModule,
    InventoryModule,
    SalesModule,
    PaymentsModule,
    DebtsModule,
    RemindersModule,
    AttachmentsModule,
    ReportsModule,
    BotModule,
  ],
})
export class AppModule {}
