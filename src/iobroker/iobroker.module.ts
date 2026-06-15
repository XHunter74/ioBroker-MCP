import { Module } from '@nestjs/common';
import { IoBrokerService } from './iobroker.service.js';

@Module({
  providers: [IoBrokerService],
  exports: [IoBrokerService],
})
export class IoBrokerModule {}
