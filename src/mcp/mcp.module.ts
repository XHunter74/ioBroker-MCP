import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IoBrokerModule } from '../iobroker/iobroker.module.js';
import { McpController } from './mcp.controller.js';
import { McpServerFactory } from './mcp-server.factory.js';

@Module({
  imports: [AuthModule, IoBrokerModule],
  controllers: [McpController],
  providers: [McpServerFactory],
})
export class McpModule {}
