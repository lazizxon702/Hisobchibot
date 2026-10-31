import { Global, Module } from '@nestjs/common';
import { OrdersService } from './orders.service';

@Global()
@Module({
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
