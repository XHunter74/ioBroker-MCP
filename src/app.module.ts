import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration.js';
import { AuthModule } from './auth/auth.module.js';
import { IoBrokerModule } from './iobroker/iobroker.module.js';
import { McpModule } from './mcp/mcp.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    AuthModule,
    IoBrokerModule,
    McpModule,
  ],
})
export class AppModule {}
