import { Global, Module } from '@nestjs/common';
import { StoresService } from './stores.service';

@Global()
@Module({
  providers: [StoresService],
  exports: [StoresService],
})
export class StoresModule {}
