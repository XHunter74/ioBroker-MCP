import * as crypto from 'crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { AppConfig } from '../config/configuration.js';

interface AuthCodeEntry {
  clientId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  expiresAt: number;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly authCodes = new Map<string, AuthCodeEntry>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  onModuleInit() {
    const oauth = this.config.get('oauth', { infer: true });
    if (!oauth.clientId || !oauth.clientSecret) {
      throw new Error('OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET must be set');
    }
  }

  generateAuthCode(
    clientId: string,
    codeChallenge: string,
    codeChallengeMethod: string,
    redirectUri: string,
  ): string {
    const code = crypto.randomBytes(32).toString('base64url');
    this.authCodes.set(code, {
      clientId,
      codeChallenge,
      codeChallengeMethod,
      redirectUri,
      expiresAt: Date.now() + 60_000,
    });
    return code;
  }

  exchangeAuthCode(code: string, codeVerifier: string, redirectUri: string): string | null {
    const entry = this.authCodes.get(code);
    if (!entry) return null;

    this.authCodes.delete(code);

    if (Date.now() > entry.expiresAt) return null;
    if (entry.redirectUri !== redirectUri) return null;

    const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    if (computed !== entry.codeChallenge) return null;

    return this.issueToken();
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

  isValidClientId(clientId: string): boolean {
    return clientId === this.config.get('oauth', { infer: true }).clientId;
  }
}
