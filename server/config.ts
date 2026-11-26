import 'dotenv/config';
import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
  z.string().optional()
);

function isValidEncryptionKey(value: string): boolean {
  if (/^[0-9a-f]{64}$/i.test(value)) return true;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  JSON_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
  CHAT_HISTORY_MAX_MESSAGES: z.coerce.number().int().min(1).max(100).default(20),
  CHAT_HISTORY_MAX_CHARS: z.coerce.number().int().min(256).max(100000).default(12000),
  MAX_ARCHIVE_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  MAX_REPOSITORY_FILES: z.coerce.number().int().positive().default(2500),
  MAX_TEXT_FILE_BYTES: z.coerce.number().int().positive().default(350 * 1024),
  GITHUB_AUTH_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  GITHUB_API_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  GITHUB_ARCHIVE_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  ALLOW_SERVER_KEY: booleanFromEnv,
  SERVER_KEY_DAILY_CAP: z.coerce.number().int().positive().default(50),
  APP_ENCRYPTION_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().refine(isValidEncryptionKey, 'must be a 32-byte base64 key').optional()
  ),
  DATABASE_PATH: z.string().trim().min(1).default('.codebase-tutor-cache/codebase-tutor.sqlite'),
  ALLOWED_ORIGINS: z
    .string()
    .trim()
    .default('http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173'),
  GEMINI_API_KEY: z.string().trim().optional(),
  GITHUB_TOKEN: z.string().trim().optional(),
  GITHUB_OAUTH_CLIENT_ID: optionalTrimmedString,
  GITHUB_OAUTH_CLIENT_SECRET: optionalTrimmedString,
  GITHUB_REDIRECT_URI: optionalTrimmedString,
  GITHUB_APP_ID: optionalTrimmedString,
  GITHUB_APP_SLUG: optionalTrimmedString,
  GITHUB_APP_PRIVATE_KEY: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() ? value.replace(/\\n/g, '\n').trim() : undefined),
    z.string().optional()
  ),
  GITHUB_APP_SETUP_URI: optionalTrimmedString,
});

const parsed = configSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;
const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);

for (const origin of allowedOrigins) {
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error('Invalid environment configuration: ALLOWED_ORIGINS must contain valid origins.');
  }
  if (parsedOrigin.origin !== origin) {
    throw new Error('Invalid environment configuration: ALLOWED_ORIGINS entries must be origins without paths.');
  }
}

if (env.NODE_ENV === 'production' && !env.APP_ENCRYPTION_KEY) {
  throw new Error('Invalid environment configuration: APP_ENCRYPTION_KEY is required in production.');
}
if (env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGINS?.trim()) {
  throw new Error('Invalid environment configuration: ALLOWED_ORIGINS is required in production.');
}
if (env.ALLOW_SERVER_KEY && !env.GEMINI_API_KEY) {
  throw new Error('Invalid environment configuration: GEMINI_API_KEY is required when ALLOW_SERVER_KEY=true.');
}

function validateConfiguredUri(name: string, value: string | undefined): void {
  if (!value) return;
  let parsedUri: URL;
  try {
    parsedUri = new URL(value);
  } catch {
    throw new Error(`Invalid environment configuration: ${name} must be an absolute URL.`);
  }
  if (parsedUri.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && parsedUri.hostname === 'localhost')) {
    throw new Error(`Invalid environment configuration: ${name} must use HTTPS outside localhost development.`);
  }
}

validateConfiguredUri('GITHUB_REDIRECT_URI', env.GITHUB_REDIRECT_URI);
validateConfiguredUri('GITHUB_APP_SETUP_URI', env.GITHUB_APP_SETUP_URI);

if (env.GITHUB_REDIRECT_URI) {
  const redirectUri = new URL(env.GITHUB_REDIRECT_URI);
  if (
    redirectUri.pathname !== '/api/auth/github/callback' ||
    redirectUri.search ||
    redirectUri.hash
  ) {
    throw new Error(
      'Invalid environment configuration: GITHUB_REDIRECT_URI must exactly target /api/auth/github/callback without query or fragment.'
    );
  }
}
if (env.GITHUB_APP_SETUP_URI) {
  const setupUri = new URL(env.GITHUB_APP_SETUP_URI);
  if (
    setupUri.pathname !== '/api/auth/github-app/callback' ||
    setupUri.search ||
    setupUri.hash
  ) {
    throw new Error(
      'Invalid environment configuration: GITHUB_APP_SETUP_URI must exactly target /api/auth/github-app/callback without query or fragment.'
    );
  }
}

const githubOAuthConfigured = Boolean(
  env.GITHUB_OAUTH_CLIENT_ID &&
    env.GITHUB_OAUTH_CLIENT_SECRET &&
    env.GITHUB_REDIRECT_URI &&
    env.APP_ENCRYPTION_KEY
);
const githubAppConfigured = Boolean(
  env.GITHUB_APP_ID &&
    env.GITHUB_APP_SLUG &&
    env.GITHUB_APP_PRIVATE_KEY &&
    env.GITHUB_APP_SETUP_URI &&
    env.APP_ENCRYPTION_KEY
);

export const config = Object.freeze({
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  jsonBodyLimitBytes: env.JSON_BODY_LIMIT_BYTES,
  chatHistoryMaxMessages: env.CHAT_HISTORY_MAX_MESSAGES,
  chatHistoryMaxChars: env.CHAT_HISTORY_MAX_CHARS,
  maxArchiveBytes: env.MAX_ARCHIVE_BYTES,
  maxRepositoryFiles: env.MAX_REPOSITORY_FILES,
  maxTextFileBytes: env.MAX_TEXT_FILE_BYTES,
  githubAuthTimeoutMs: env.GITHUB_AUTH_TIMEOUT_MS,
  githubApiTimeoutMs: env.GITHUB_API_TIMEOUT_MS,
  githubArchiveTimeoutMs: env.GITHUB_ARCHIVE_TIMEOUT_MS,
  allowServerKey: env.ALLOW_SERVER_KEY,
  serverKeyDailyCap: env.SERVER_KEY_DAILY_CAP,
  appEncryptionKey: env.APP_ENCRYPTION_KEY,
  databasePath: env.DATABASE_PATH,
  allowedOrigins: Object.freeze(allowedOrigins),
  geminiApiKey: env.GEMINI_API_KEY,
  githubToken: env.GITHUB_TOKEN,
  githubOAuthClientId: env.GITHUB_OAUTH_CLIENT_ID,
  githubOAuthClientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
  githubRedirectUri: env.GITHUB_REDIRECT_URI,
  githubOAuthConfigured,
  githubAppId: env.GITHUB_APP_ID,
  githubAppSlug: env.GITHUB_APP_SLUG,
  githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
  githubAppSetupUri: env.GITHUB_APP_SETUP_URI,
  githubAppConfigured,
});
