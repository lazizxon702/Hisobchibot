import { Global, Module } from '@nestjs/common';
import { AssignmentsService } from './assignments.service';

@Global()
@Module({
  providers: [AssignmentsService],
  exports: [AssignmentsService],
})
export class AssignmentsModule {}
