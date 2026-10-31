import { Global, Module } from '@nestjs/common';
import { DebtsService } from './debts.service';

@Global()
@Module({
  providers: [DebtsService],
  exports: [DebtsService],
})
export class DebtsModule {}
