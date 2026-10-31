import { Global, Module } from '@nestjs/common';
import { AgenciesService } from './agencies.service';

@Global()
@Module({
  providers: [AgenciesService],
  exports: [AgenciesService],
})
export class AgenciesModule {}
