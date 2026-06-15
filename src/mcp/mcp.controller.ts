import { Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Request, Response } from 'express';
import { BearerGuard } from '../auth/bearer.guard.js';
import { McpServerFactory } from './mcp-server.factory.js';

@Controller('mcp')
export class McpController {
  constructor(private readonly mcpServerFactory: McpServerFactory) {}

  @Post()
  @UseGuards(BearerGuard)
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const server = this.mcpServerFactory.create();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}
