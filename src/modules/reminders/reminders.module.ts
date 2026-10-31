import { Global, Module } from '@nestjs/common';
import { RemindersService } from './reminders.service';

@Global()
@Module({
  providers: [RemindersService],
  exports: [RemindersService],
})
export class RemindersModule {}
