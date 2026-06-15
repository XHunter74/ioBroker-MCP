# ioBroker MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that exposes ioBroker smart home states and objects as tools for AI assistants (Claude, etc.).

## Features

- Read, write, and search ioBroker datapoints from any MCP-compatible AI client
- OAuth 2.0 authentication (Authorization Code + PKCE and Client Credentials flows)
- Designed to run behind a reverse proxy (nginx) with HTTPS termination
- Built with NestJS + TypeScript

## Tools

| Tool | Description |
|---|---|
| `get_state` | Get the current value and metadata of a datapoint by ID |
| `set_state` | Set the value of a datapoint |
| `get_object` | Get object definition (type, common, native, acl) |
| `search_states` | List all states matching a glob pattern |

**Examples:**

```
get_state("zigbee.0.abc123.temperature")
set_state("sonoff.0.device1.POWER1", false)
search_states("hm-rpc.0.*")
get_object("zigbee.0.abc123.link_quality")
```

## Requirements

- Node.js 20+
- ioBroker with [simple-api](https://github.com/ioBroker/ioBroker.simple-api) adapter running (typically via ioBroker.web on port 8088)

## Setup

```bash
npm install
cp .env.example .env
# edit .env with your settings
npm run build
npm run start:prod
```

## Configuration

All configuration is via environment variables (`.env` file):

```env
# ioBroker simple-api connection
IOBROKER_HOST=localhost          # ioBroker host IP or hostname
IOBROKER_PORT=8087               # simple-api port (8087 standalone, 8088 via web adapter)
IOBROKER_USE_AUTH=false          # set true if ioBroker requires login
IOBROKER_USER=admin
IOBROKER_PASSWORD=

# MCP Server
PORT=3000

# OAuth 2.0 — required, server won't start without these
OAUTH_CLIENT_ID=your-client-id
OAUTH_CLIENT_SECRET=your-client-secret
OAUTH_JWT_SECRET=change-me-random-secret-min-32-chars
OAUTH_TOKEN_EXPIRY=3600          # access token lifetime in seconds

# Public base URL — required when running behind a reverse proxy
# Must match the externally reachable URL of this server
OAUTH_ISSUER=https://mcp.example.com
```

> **Note:** `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` are mandatory. The server will refuse to start if they are not set.

## OAuth 2.0

The server implements RFC 6749 + RFC 7636 (PKCE). Two grant types are supported:

- **Authorization Code + PKCE** — used by claude.ai and Claude desktop app
- **Client Credentials** — for programmatic access

### OAuth endpoints

| Endpoint | Description |
|---|---|
| `GET /.well-known/oauth-authorization-server` | OAuth 2.0 metadata discovery (RFC 8414) |
| `GET /authorize` | Authorization endpoint (redirects with auth code) |
| `POST /oauth/token` | Token endpoint |

### Adding to Claude (claude.ai)

1. Go to **Settings → Integrations → Add Integration**
2. Enter the MCP URL: `https://your-domain.com/mcp`
3. Enter **OAuth Client ID** and **OAuth Client Secret** from your `.env`
4. Claude will complete the OAuth flow automatically

### Manual token (Client Credentials)

```bash
# Get a token
curl -X POST https://your-domain.com/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"client_credentials","client_id":"your-id","client_secret":"your-secret"}'

# Use the token
curl -X POST https://your-domain.com/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Nginx reverse proxy

Example nginx config for HTTPS termination:

```nginx
server {
    listen 443 ssl;
    server_name mcp.example.com;

    # SSL certificates (e.g. Let's Encrypt)
    ssl_certificate     /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;

    location /mcp {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /.well-known/oauth-authorization-server {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /authorize {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /oauth/token {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Development

```bash
npm run start:dev     # watch mode
npm run start:debug   # debug + watch
npm run build         # compile TypeScript
```

## Architecture

```
src/
├── app.module.ts
├── main.ts                         # Express + trust proxy
├── config/
│   └── configuration.ts            # Typed config from env vars
├── auth/
│   ├── auth.module.ts
│   ├── auth.service.ts             # PKCE, JWT issuance/validation
│   ├── auth.controller.ts          # OAuth endpoints
│   └── bearer.guard.ts             # NestJS guard for POST /mcp
├── iobroker/
│   ├── iobroker.module.ts
│   ├── iobroker.service.ts         # simple-api HTTP client
│   └── iobroker.types.ts
└── mcp/
    ├── mcp.module.ts
    ├── mcp.controller.ts           # POST /mcp handler
    └── mcp-server.factory.ts       # MCP tool definitions
```

## License

MIT
