import { Global, Module } from '@nestjs/common';
import { FinancingProgramsService } from './financing-programs.service';

@Global()
@Module({
  providers: [FinancingProgramsService],
  exports: [FinancingProgramsService],
})
export class FinancingProgramsModule {}   