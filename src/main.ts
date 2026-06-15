import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from './config/configuration.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();

  const configService = app.get(ConfigService<AppConfig>);
  const port = configService.get('port', { infer: true });

  await app.listen(port);
  console.log(`ioBroker MCP server listening on port ${port} (HTTP)`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
}

bootstrap();
