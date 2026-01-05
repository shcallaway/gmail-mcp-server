import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

// Load .env file
loadEnv();

const configSchema = z.object({
  // Server
  port: z.coerce.number().int().positive().default(3000),
  baseUrl: z.string().url(),

  // Google OAuth
  googleClientId: z.string().min(1),
  googleClientSecret: z.string().min(1),
  oauthRedirectUri: z.string().url(),

  // Security
  tokenEncryptionKey: z.string().min(32, 'TOKEN_ENCRYPTION_KEY must be at least 32 characters'),
  jwtSecret: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),

  // Database
  dbUrl: z.string().default('./data/gmail-mcp.db'),

  // CORS
  allowedOrigins: z.string().optional().transform((val) =>
    val ? val.split(',').map(s => s.trim()).filter(Boolean) : []
  ),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const env = {
    port: process.env['PORT'],
    baseUrl: process.env['BASE_URL'],
    googleClientId: process.env['GOOGLE_CLIENT_ID'],
    googleClientSecret: process.env['GOOGLE_CLIENT_SECRET'],
    oauthRedirectUri: process.env['OAUTH_REDIRECT_URI'],
    tokenEncryptionKey: process.env['TOKEN_ENCRYPTION_KEY'],
    jwtSecret: process.env['JWT_SECRET'],
    dbUrl: process.env['DB_URL'],
    allowedOrigins: process.env['ALLOWED_ORIGINS'],
  };

  const result = configSchema.safeParse(env);

  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `  ${issue.path.join('.')}: ${issue.message}`
    );
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }

  return result.data;
}

// Lazy initialization - config is loaded on first access
let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

// For testing - allows resetting config
export function resetConfig(): void {
  _config = null;
}
