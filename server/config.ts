import 'dotenv/config';
import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  JSON_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
  MAX_ARCHIVE_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  MAX_REPOSITORY_FILES: z.coerce.number().int().positive().default(2500),
  MAX_TEXT_FILE_BYTES: z.coerce.number().int().positive().default(350 * 1024),
  GITHUB_AUTH_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  GITHUB_API_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  GITHUB_ARCHIVE_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  SESSION_TTL_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
  SESSION_TOKEN_BYTES: z.coerce.number().int().min(32).max(128).default(32),
  ALLOW_SERVER_KEY: booleanFromEnv,
  SERVER_KEY_DAILY_CAP: z.coerce.number().int().positive().default(50),
  APP_ENCRYPTION_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().regex(/^[0-9a-f]{64}$/i, 'must be a 32-byte hexadecimal key').optional()
  ),
  DATABASE_PATH: z.string().trim().min(1).default('.codebase-tutor-cache/codebase-tutor.sqlite'),
  ALLOWED_ORIGINS: z.string().trim().default('http://localhost:3000,http://localhost:5173'),
  GEMINI_API_KEY: z.string().trim().optional(),
  GITHUB_TOKEN: z.string().trim().optional(),
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

export const config = Object.freeze({
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  jsonBodyLimitBytes: env.JSON_BODY_LIMIT_BYTES,
  maxArchiveBytes: env.MAX_ARCHIVE_BYTES,
  maxRepositoryFiles: env.MAX_REPOSITORY_FILES,
  maxTextFileBytes: env.MAX_TEXT_FILE_BYTES,
  githubAuthTimeoutMs: env.GITHUB_AUTH_TIMEOUT_MS,
  githubApiTimeoutMs: env.GITHUB_API_TIMEOUT_MS,
  githubArchiveTimeoutMs: env.GITHUB_ARCHIVE_TIMEOUT_MS,
  sessionTtlMs: env.SESSION_TTL_MS,
  sessionTokenBytes: env.SESSION_TOKEN_BYTES,
  allowServerKey: env.ALLOW_SERVER_KEY,
  serverKeyDailyCap: env.SERVER_KEY_DAILY_CAP,
  appEncryptionKey: env.APP_ENCRYPTION_KEY,
  databasePath: env.DATABASE_PATH,
  allowedOrigins: Object.freeze(allowedOrigins),
  geminiApiKey: env.GEMINI_API_KEY,
  githubToken: env.GITHUB_TOKEN,
});
