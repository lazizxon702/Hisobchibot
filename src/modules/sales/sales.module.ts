import { Global, Module } from '@nestjs/common';
import { SalesService } from './sales.service';

@Global()
@Module({
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
