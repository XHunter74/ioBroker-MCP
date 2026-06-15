import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { AppConfig } from '../config/configuration.js';

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  onModuleInit() {
    const oauth = this.config.get('oauth', { infer: true });
    if (!oauth.clientId || !oauth.clientSecret) {
      throw new Error('OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET must be set');
    }
  }

  validateClient(clientId: string, clientSecret: string): boolean {
    const oauth = this.config.get('oauth', { infer: true });
    return clientId === oauth.clientId && clientSecret === oauth.clientSecret;
  }

  issueToken(): string {
    const oauth = this.config.get('oauth', { infer: true });
    return jwt.sign({ sub: oauth.clientId }, oauth.jwtSecret, {
      expiresIn: oauth.tokenExpiry,
    });
  }

  validateToken(token: string): boolean {
    const oauth = this.config.get('oauth', { infer: true });
    try {
      jwt.verify(token, oauth.jwtSecret);
      return true;
    } catch {
      return false;
    }
  }

  getTokenExpiry(): number {
    return this.config.get('oauth', { infer: true }).tokenExpiry;
  }
}
