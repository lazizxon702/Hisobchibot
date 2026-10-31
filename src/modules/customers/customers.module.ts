import { Global, Module } from '@nestjs/common';
import { CustomersService } from './customers.service';

@Global()
@Module({
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
