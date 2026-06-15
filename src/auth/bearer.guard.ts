import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service.js';

@Injectable()
export class BearerGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="mcp"');
      throw new UnauthorizedException('Missing Bearer token');
    }

    const token = authHeader.slice(7);
    if (!this.authService.validateToken(token)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="mcp", error="invalid_token"');
      throw new UnauthorizedException('Invalid or expired token');
    }

    return true;
  }
}
