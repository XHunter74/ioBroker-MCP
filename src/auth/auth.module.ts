import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { BearerGuard } from './bearer.guard.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, BearerGuard],
  exports: [AuthService, BearerGuard],
})
export class AuthModule {}
