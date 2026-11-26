import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

const origin = 'http://localhost:5173';
const databasePath = path.join(os.tmpdir(), `codebase-tutor-test-${crypto.randomUUID()}.sqlite`);

let app: Express;
let database: typeof import('../server/db/index.ts');
let auth: typeof import('../server/auth.ts');

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = databasePath;
  process.env.ALLOW_SERVER_KEY = 'false';
  process.env.ALLOWED_ORIGINS = 'http://localhost:3000,http://localhost:5173';
  const [appModule, databaseModule, authModule] = await Promise.all([
    import('../server/app.ts'),
    import('../server/db/index.ts'),
    import('../server/auth.ts'),
  ]);
  app = appModule.createApp();
  database = databaseModule;
  auth = authModule;
  database.initializeDatabase();
});

afterAll(() => {
  database.closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = `${databasePath}${suffix}`;
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

async function csrfToken(agent: ReturnType<typeof request.agent>): Promise<string> {
  const response = await agent.get('/api/auth/csrf').set('Origin', origin);
  expect(response.status).toBe(200);
  return response.body.csrfToken as string;
}

async function postWithCsrf(
  agent: ReturnType<typeof request.agent>,
  route: string,
  body?: Record<string, unknown>
) {
  const token = await csrfToken(agent);
  const response = await agent
    .post(route)
    .set('Origin', origin)
    .set('X-CSRF-Token', token)
    .send(body ?? {});
  return response;
}

async function insertTestUser(email: string, password = 'Test-Account-Password-27!') {
  const user = {
    id: crypto.randomUUID(),
    email,
    name: 'Test Student',
    role: 'Student',
    passwordHash: await auth.hashPassword(password),
  };
  expect(database.insertUser(user)).toBe(true);
  return { ...user, password };
}

function createStoredSession(userId: string, token: string, overrides: { now?: number; expiresAt?: number } = {}) {
  const now = overrides.now ?? Date.now();
  database.createSession({
    idHash: crypto.createHash('sha256').update(token).digest('hex'),
    userId,
    now,
    expiresAt: overrides.expiresAt ?? now + 60 * 60 * 1000,
    ip: null,
    userAgent: null,
  });
  return crypto.createHash('sha256').update(token).digest('hex');
}

describe('GET /api/health', () => {
  it('returns a healthy JSON response', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', service: 'codebase-tutor' });
  });

  it('rejects API requests from unconfigured browser origins', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'https://untrusted.example');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Origin is not allowed.');
  });
});

describe('cookie authentication', () => {
  it('requires authentication before starting an analysis', async () => {
    const response = await postWithCsrf(request.agent(app), '/api/repositories/analyze', {
      url: 'https://github.com/example/repo',
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Sign in is required for this feature.');
  });

  it('rejects state-changing requests without a CSRF token', async () => {
    const response = await request(app)
      .post('/api/auth/signup')
      .set('Origin', origin)
      .send({
        name: 'Test Student',
        email: 'csrf-test@example.com',
        password: 'Test-Account-Password-27!',
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('CSRF token is required.');
  });

  it('creates a cookie session and does not return a bearer token', async () => {
    const agent = request.agent(app);
    const response = await postWithCsrf(agent, '/api/auth/signup', {
      name: 'Test Student',
      email: 'signup-test@example.com',
      password: 'Test-Account-Password-27!',
      role: 'Student',
    });

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe('signup-test@example.com');
    expect(response.body.token).toBeUndefined();
    expect(String(response.headers['set-cookie'])).toContain('codebase_tutor_session=');
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly');
    expect((await agent.get('/api/auth/me')).status).toBe(200);
  });

  it('rejects expired and revoked sessions', async () => {
    const user = await insertTestUser('session-check@example.com');
    const expiredToken = crypto.randomBytes(32).toString('hex');
    createStoredSession(user.id, expiredToken, { expiresAt: Date.now() - 1 });
    const expired = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `codebase_tutor_session=${expiredToken}`);
    expect(expired.status).toBe(401);

    const revokedToken = crypto.randomBytes(32).toString('hex');
    const revokedHash = createStoredSession(user.id, revokedToken);
    expect(database.revokeSession(revokedHash, user.id, Date.now())).toBe(true);
    const revoked = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `codebase_tutor_session=${revokedToken}`);
    expect(revoked.status).toBe(401);
  });

  it('uses the same login failure for unknown emails and incorrect passwords, then locks the account', async () => {
    const user = await insertTestUser('lockout-test@example.com');
    const unknownAgent = request.agent(app);
    const unknown = await postWithCsrf(unknownAgent, '/api/auth/login', {
      email: 'missing-account@example.com',
      password: 'Incorrect-Account-Password-99!',
    });
    const agent = request.agent(app);
    const wrongPassword = await postWithCsrf(agent, '/api/auth/login', {
      email: user.email,
      password: 'Incorrect-Account-Password-99!',
    });

    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(unknown.body).toEqual(wrongPassword.body);

    for (let attempt = 1; attempt < 5; attempt += 1) {
      const response = await postWithCsrf(agent, '/api/auth/login', {
        email: user.email,
        password: 'Incorrect-Account-Password-99!',
      });
      expect(response.status).toBe(401);
    }

    const lockedLogin = await postWithCsrf(agent, '/api/auth/login', {
      email: user.email,
      password: user.password,
    });
    expect(lockedLogin.status).toBe(401);
    expect(lockedLogin.body).toEqual(unknown.body);
  });

  it('rotates the current session on password change and revokes other sessions', async () => {
    const user = await insertTestUser('password-change@example.com');
    const agent = request.agent(app);
    const login = await postWithCsrf(agent, '/api/auth/login', {
      email: user.email,
      password: user.password,
    });
    expect(login.status).toBe(200);

    const otherToken = crypto.randomBytes(32).toString('hex');
    createStoredSession(user.id, otherToken);
    expect(
      (await request(app).get('/api/auth/me').set('Cookie', `codebase_tutor_session=${otherToken}`)).status
    ).toBe(200);

    const changed = await postWithCsrf(agent, '/api/auth/change-password', {
      currentPassword: user.password,
      newPassword: 'Another-Account-Password-48!',
    });
    expect(changed.status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    expect(
      (await request(app).get('/api/auth/me').set('Cookie', `codebase_tutor_session=${otherToken}`)).status
    ).toBe(401);
  });

  it('keeps a session valid after the database connection is reopened', async () => {
    const agent = request.agent(app);
    const signup = await postWithCsrf(agent, '/api/auth/signup', {
      name: 'Restart Student',
      email: 'restart-test@example.com',
      password: 'Restart-Account-Password-62!',
    });
    expect(signup.status).toBe(201);

    database.closeDatabase();
    database.initializeDatabase();

    const restored = await agent.get('/api/auth/me');
    expect(restored.status).toBe(200);
    expect(restored.body.user.email).toBe('restart-test@example.com');
  });
});

describe('persistent owner and Gemini quota records', () => {
  it('keeps repository ownership separate and enforces the daily cap', async () => {
    const firstUser = await insertTestUser('first-owner@example.com');
    const secondUser = await insertTestUser('second-owner@example.com');

    database.setPublicRepositoryOwner('test-owner-one__repo', firstUser.id);
    expect(database.listPublicRepositoryIds(firstUser.id)).toEqual(['test-owner-one__repo']);
    expect(database.listPublicRepositoryIds(secondUser.id)).toEqual([]);

    expect(database.consumeGeminiDailyQuota(firstUser.id, '2026-01-01', 2)).toBe(true);
    expect(database.consumeGeminiDailyQuota(firstUser.id, '2026-01-01', 2)).toBe(true);
    expect(database.consumeGeminiDailyQuota(firstUser.id, '2026-01-01', 2)).toBe(false);
  });
});
