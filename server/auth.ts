import crypto from 'node:crypto';
import argon2 from 'argon2';
import rateLimit from 'express-rate-limit';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.ts';
import {
  findSessionByHash,
  type AuthenticatedSession,
  type NewSession,
} from './db/index.ts';

export const SESSION_COOKIE_NAME = 'codebase_tutor_session';
export const CSRF_COOKIE_NAME = 'codebase_tutor_csrf';
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
export const LOGIN_LOCK_THRESHOLD = 5;
export const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

const COOKIE_OPTIONS = {
  path: '/',
  sameSite: 'lax' as const,
  secure: config.nodeEnv === 'production',
};

const COMMON_PASSWORDS = new Set([
  '123456789012',
  '1234567890123',
  'qwerty123456',
  'password1234',
  'password123!',
  'welcome1234',
  'letmein1234',
  'admin123456',
  'iloveyou1234',
  'monkey123456',
  'dragon123456',
  'football1234',
  'baseball1234',
  'sunshine1234',
  'princess1234',
  'trustno12345',
  'correcthorsebatterystaple',
]);

let dummyPasswordHash: Promise<string> | undefined;

export interface AuthSessionContext extends AuthenticatedSession {}

export function initializeAuth(): Promise<void> {
  if (!dummyPasswordHash) {
    dummyPasswordHash = argon2.hash(crypto.randomBytes(32).toString('hex'), ARGON2_OPTIONS);
  }
  return dummyPasswordHash.then(() => undefined);
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return argon2.verify(passwordHash, password);
}

export async function verifyDummyPassword(password: string): Promise<void> {
  await initializeAuth();
  await argon2.verify(await dummyPasswordHash!, password);
}

export function validatePassword(password: string, email: string, name: string): string | undefined {
  if (password.length < 12) return 'Password must be at least 12 characters.';
  const normalized = password.toLowerCase();
  if (COMMON_PASSWORDS.has(normalized)) return 'Choose a less common password.';
  if (normalized === email.trim().toLowerCase()) return 'Password cannot be your email address.';
  if (normalized === name.trim().toLowerCase()) return 'Password cannot be your name.';
  return undefined;
}

export function loginIpRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again later.' },
  });
}

export function loginAccountRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => typeof req.body?.email !== 'string' || !req.body.email.trim(),
    keyGenerator: (req) => {
      const email = String(req.body.email).trim().toLowerCase();
      return `account:${crypto.createHash('sha256').update(email).digest('hex')}`;
    },
    message: { error: 'Too many sign-in attempts. Try again later.' },
  });
}

export function signupRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many signup attempts. Try again later.' },
  });
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET') {
    const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
    const token = typeof cookieToken === 'string' && cookieToken
      ? cookieToken
      : crypto.randomBytes(32).toString('hex');
    res.locals.csrfToken = token;
    if (!cookieToken) {
      res.cookie(CSRF_COOKIE_NAME, token, {
        ...COOKIE_OPTIONS,
        httpOnly: false,
      });
    }
    next();
    return;
  }
  if (req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }

  const origin = req.get('Origin');
  if (!origin || !config.allowedOrigins.includes(origin)) {
    res.status(403).json({ error: 'Origin is not allowed.' });
    return;
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.get('X-CSRF-Token');
  if (!cookieToken || !headerToken) {
    res.status(403).json({ error: 'CSRF token is required.' });
    return;
  }
  const cookieBuffer = Buffer.from(cookieToken);
  const headerBuffer = Buffer.from(headerToken);
  if (
    cookieBuffer.length !== headerBuffer.length ||
    !crypto.timingSafeEqual(cookieBuffer, headerBuffer)
  ) {
    res.status(403).json({ error: 'CSRF token is invalid.' });
    return;
  }
  next();
}

function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSessionCredentials(
  userId: string,
  req: Request,
  now = Date.now()
): { token: string; session: NewSession } {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    token,
    session: {
      idHash: hashSessionToken(token),
      userId,
      now,
      expiresAt: now + SESSION_ABSOLUTE_TIMEOUT_MS,
      ip: req.ip || null,
      userAgent: req.get('User-Agent') ?? null,
    },
  };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    ...COOKIE_OPTIONS,
    httpOnly: true,
    maxAge: SESSION_ABSOLUTE_TIMEOUT_MS,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { ...COOKIE_OPTIONS, httpOnly: true });
}

export function currentSessionIdHash(req: Request): string | undefined {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  return typeof token === 'string' && token ? hashSessionToken(token) : undefined;
}

function resolveSession(req: Request, res: Response): AuthSessionContext | undefined {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (typeof token !== 'string' || !token) return undefined;
  const session = findSessionByHash(
    hashSessionToken(token),
    Date.now(),
    SESSION_IDLE_TIMEOUT_MS
  );
  if (!session) clearSessionCookie(res);
  return session;
}

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const session = resolveSession(req, res);
  if (session) res.locals.auth = session;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const session = resolveSession(req, res);
  if (!session) {
    res.status(401).json({ error: 'Sign in is required for this feature.' });
    return;
  }
  res.locals.auth = session;
  next();
}

export function getAuthContext(res: Response): AuthSessionContext | undefined {
  return res.locals.auth as AuthSessionContext | undefined;
}
