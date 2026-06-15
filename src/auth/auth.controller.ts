import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service.js';

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('.well-known/oauth-authorization-server')
  getMetadata(@Req() req: Request) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    return {
      issuer: baseUrl,
      token_endpoint: `${baseUrl}/oauth/token`,
      response_types_supported: ['token'],
      grant_types_supported: ['client_credentials'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    };
  }

  @Post('oauth/token')
  @HttpCode(HttpStatus.OK)
  issueToken(@Body() body: Record<string, string>) {
    if (body.grant_type !== 'client_credentials') {
      throw new UnauthorizedException('Unsupported grant_type');
    }

    const clientId = body.client_id;
    const clientSecret = body.client_secret;

    if (!this.authService.validateClient(clientId, clientSecret)) {
      throw new UnauthorizedException('Invalid client credentials');
    }

    return {
      access_token: this.authService.issueToken(),
      token_type: 'bearer',
      expires_in: this.authService.getTokenExpiry(),
    };
  }
}
