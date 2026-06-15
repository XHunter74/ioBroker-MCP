import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AppConfig } from '../config/configuration.js';
import { AuthService } from './auth.service.js';

@Controller()
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private getBaseUrl(req: Request): string {
    const issuer = this.config.get('oauth', { infer: true }).issuer;
    if (issuer) return issuer.replace(/\/$/, '');
    return `${req.protocol}://${req.get('host')}`;
  }

  @Get('.well-known/oauth-authorization-server')
  getMetadata(@Req() req: Request) {
    const baseUrl = this.getBaseUrl(req);
    this.logger.log(`OAuth metadata requested, baseUrl=${baseUrl}`);
    return {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'client_credentials'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
    };
  }

  @Get('authorize')
  authorize(
    @Query('response_type') responseType: string,
    @Query('client_id') clientId: string,
    @Query('redirect_uri') redirectUri: string,
    @Query('code_challenge') codeChallenge: string,
    @Query('code_challenge_method') codeChallengeMethod: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    this.logger.log(
      `Authorize: response_type=${responseType} client_id=${clientId} redirect_uri=${redirectUri}`,
    );

    if (responseType !== 'code') {
      return res.status(400).json({ error: 'unsupported_response_type' });
    }
    if (!this.authService.isValidClientId(clientId)) {
      this.logger.warn(`Invalid client_id: ${clientId}`);
      return res.status(400).json({ error: 'invalid_client' });
    }

    const code = this.authService.generateAuthCode(
      clientId,
      codeChallenge,
      codeChallengeMethod ?? 'S256',
      redirectUri,
    );

    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set('code', code);
    if (state) callbackUrl.searchParams.set('state', state);

    this.logger.log(`Redirecting to: ${callbackUrl.toString().slice(0, 80)}...`);
    return res.redirect(callbackUrl.toString());
  }

  @Post('oauth/token')
  @HttpCode(HttpStatus.OK)
  issueToken(@Body() body: Record<string, string>) {
    this.logger.log(`Token request: grant_type=${body.grant_type} client_id=${body.client_id}`);

    if (body.grant_type === 'authorization_code') {
      const token = this.authService.exchangeAuthCode(
        body.code,
        body.code_verifier,
        body.redirect_uri,
      );
      if (!token) {
        this.logger.warn('Auth code exchange failed (invalid/expired code or PKCE mismatch)');
        throw new UnauthorizedException('Invalid or expired authorization code');
      }
      this.logger.log('Auth code exchanged successfully');
      return {
        access_token: token,
        token_type: 'bearer',
        expires_in: this.authService.getTokenExpiry(),
      };
    }

    if (body.grant_type === 'client_credentials') {
      if (!this.authService.validateClient(body.client_id, body.client_secret)) {
        this.logger.warn(`Invalid client credentials for client_id=${body.client_id}`);
        throw new UnauthorizedException('Invalid client credentials');
      }
      return {
        access_token: this.authService.issueToken(),
        token_type: 'bearer',
        expires_in: this.authService.getTokenExpiry(),
      };
    }

    this.logger.warn(`Unsupported grant_type: ${body.grant_type}`);
    throw new UnauthorizedException('Unsupported grant_type');
  }
}
