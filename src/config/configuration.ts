export interface AppConfig {
  port: number;
  iobroker: {
    host: string;
    port: number;
    adminHost: string;
    adminPort: number;
    useAuth: boolean;
    user: string;
    password: string;
  };
  oauth: {
    clientId: string;
    clientSecret: string;
    jwtSecret: string;
    tokenExpiry: number;
    issuer: string;
  };
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  iobroker: {
    host: process.env.IOBROKER_HOST ?? 'localhost',
    port: parseInt(process.env.IOBROKER_PORT ?? '8087', 10),
    adminHost: process.env.IOBROKER_ADMIN_HOST ?? process.env.IOBROKER_HOST ?? 'localhost',
    adminPort: parseInt(process.env.IOBROKER_ADMIN_PORT ?? '8100', 10),
    useAuth: process.env.IOBROKER_USE_AUTH === 'true',
    user: process.env.IOBROKER_USER ?? '',
    password: process.env.IOBROKER_PASSWORD ?? '',
  },
  oauth: {
    clientId: process.env.OAUTH_CLIENT_ID ?? '',
    clientSecret: process.env.OAUTH_CLIENT_SECRET ?? '',
    jwtSecret: process.env.OAUTH_JWT_SECRET ?? 'change-me-jwt-secret',
    tokenExpiry: parseInt(process.env.OAUTH_TOKEN_EXPIRY ?? '2592000', 10),
    issuer: process.env.OAUTH_ISSUER ?? '',
  },
});
