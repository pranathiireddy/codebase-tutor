import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

let app: Express;
let database: typeof import('../server/db/index.ts');

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = ':memory:';
  process.env.ALLOW_SERVER_KEY = 'false';
  process.env.ALLOWED_ORIGINS = 'http://localhost:3000,http://localhost:5173';
  const [appModule, databaseModule] = await Promise.all([
    import('../server/app.ts'),
    import('../server/db/index.ts'),
  ]);
  app = appModule.createApp();
  database = databaseModule;
  database.initializeDatabase();
});

afterAll(() => {
  database.closeDatabase();
});

describe('GET /api/health', () => {
  it('returns a healthy JSON response', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', service: 'codebase-tutor' });
  });
});

describe('repository API access', () => {
  it('requires authentication before starting an analysis', async () => {
    const response = await request(app)
      .post('/api/repositories/analyze')
      .send({ url: 'https://github.com/example/repo' });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Sign in is required for this feature.');
  });

  it('rejects API requests from unconfigured browser origins', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'https://untrusted.example');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Origin is not allowed.');
  });

  it('creates, validates, and revokes an authenticated session', async () => {
    const signup = await request(app).post('/api/auth/signup').send({
      name: 'Test Student',
      email: 'test-student@example.com',
      password: 'secure-test-password',
      role: 'Student',
    });

    expect(signup.status).toBe(201);
    expect(signup.body.token).toEqual(expect.any(String));

    const headers = { Authorization: `Bearer ${signup.body.token}` };
    const session = await request(app).get('/api/auth/me').set(headers);
    expect(session.status).toBe(200);
    expect(session.body.user.email).toBe('test-student@example.com');

    const logout = await request(app).post('/api/auth/logout').set(headers);
    expect(logout.status).toBe(200);

    const revokedSession = await request(app).get('/api/auth/me').set(headers);
    expect(revokedSession.status).toBe(401);
  });
});

describe('persistent owner and Gemini quota records', () => {
  it('keeps repository ownership separate and enforces the daily cap', () => {
    const firstUser = {
      id: 'test-owner-one',
      name: 'First User',
      email: 'first@example.com',
      role: 'Student',
      salt: 'salt-one',
      passwordHash: 'hash-one',
    };
    const secondUser = {
      ...firstUser,
      id: 'test-owner-two',
      email: 'second@example.com',
    };
    expect(database.insertUser(firstUser)).toBe(true);
    expect(database.insertUser(secondUser)).toBe(true);

    database.setPublicRepositoryOwner('test-owner-one__repo', firstUser.id);
    expect(database.listPublicRepositoryIds(firstUser.id)).toEqual(['test-owner-one__repo']);
    expect(database.listPublicRepositoryIds(secondUser.id)).toEqual([]);

    expect(database.consumeGeminiDailyQuota(firstUser.id, '2026-01-01', 2)).toBe(true);
    expect(database.consumeGeminiDailyQuota(firstUser.id, '2026-01-01', 2)).toBe(true);
    expect(database.consumeGeminiDailyQuota(firstUser.id, '2026-01-01', 2)).toBe(false);
  });
});
