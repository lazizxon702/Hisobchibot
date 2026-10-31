import { Global, Module } from '@nestjs/common';
import { DaftarService } from './daftar.service';

@Global()
@Module({
  providers: [DaftarService],
  exports: [DaftarService],
})
export class DaftarModule {}
