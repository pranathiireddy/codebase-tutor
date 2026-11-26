import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import nock from 'nock';

const origin = 'http://localhost:5173';
const databasePath = path.join(os.tmpdir(), `codebase-tutor-test-${crypto.randomUUID()}.sqlite`);
const appPrivateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ type: 'pkcs8', format: 'pem' }).toString();

let app: Express;
let database: typeof import('../server/db/index.ts');
let auth: typeof import('../server/auth.ts');

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = databasePath;
  process.env.ALLOW_SERVER_KEY = 'false';
  process.env.ALLOWED_ORIGINS = 'http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173';
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString('base64');
  process.env.GITHUB_OAUTH_CLIENT_ID = 'oauth-client-id-for-tests';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'oauth-client-secret-for-tests';
  process.env.GITHUB_REDIRECT_URI = 'http://localhost:3000/api/auth/github/callback';
  process.env.GITHUB_APP_ID = '123456';
  process.env.GITHUB_APP_SLUG = 'codebase-tutor-test';
  process.env.GITHUB_APP_PRIVATE_KEY = appPrivateKey;
  process.env.GITHUB_APP_SETUP_URI = 'http://localhost:3000/api/auth/github-app/callback';
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

afterEach(() => {
  nock.cleanAll();
  vi.restoreAllMocks();
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

function mockGitHubIdentity(options: {
  providerUserId: number;
  login: string;
  email: string;
  accessToken?: string;
  verified?: boolean;
}) {
  const accessToken = options.accessToken ?? `gho-test-access-${options.providerUserId}`;
  const oauth = nock('https://github.com')
    .post('/login/oauth/access_token', (body) =>
      body.client_id === 'oauth-client-id-for-tests' &&
      body.client_secret === 'oauth-client-secret-for-tests' &&
      typeof body.code_verifier === 'string' &&
      body.redirect_uri === 'http://localhost:3000/api/auth/github/callback'
    )
    .reply(200, { access_token: accessToken, token_type: 'bearer' });
  const api = nock('https://api.github.com')
    .get('/user')
    .matchHeader('authorization', `Bearer ${accessToken}`)
    .reply(200, {
      id: options.providerUserId,
      login: options.login,
      name: options.login,
      avatar_url: `https://avatars.githubusercontent.com/u/${options.providerUserId}`,
    })
    .get('/user/emails')
    .matchHeader('authorization', `Bearer ${accessToken}`)
    .reply(200, [{
      email: options.email,
      primary: true,
      verified: options.verified ?? true,
    }]);
  return { accessToken, scopes: [oauth, api] };
}

async function startGitHubOAuth(
  agent: ReturnType<typeof request.agent>,
  redirectAfter = '/workspace',
  purpose: 'login' | 'link' = 'login'
): Promise<string> {
  const response = purpose === 'link'
    ? await postWithCsrf(agent, '/api/auth/github/link/start', { redirectAfter })
    : await agent
        .get(`/api/auth/github/start?redirect_after=${encodeURIComponent(redirectAfter)}`)
        .set('Origin', origin);
  expect(response.status).toBe(purpose === 'link' ? 200 : 302);
  const authorizationUrl = new URL(
    purpose === 'link' ? response.body.authorizationUrl as string : response.headers.location as string
  );
  expect(authorizationUrl.origin).toBe('https://github.com');
  expect(authorizationUrl.searchParams.get('scope')).toBe('read:user user:email');
  expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
  return authorizationUrl.searchParams.get('state') as string;
}

async function completeGitHubOAuth(
  agent: ReturnType<typeof request.agent>,
  state: string,
  code = 'oauth-code-for-test'
) {
  return agent.get('/api/auth/github/callback').query({ state, code });
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

  it('allows signup from the configured 127.0.0.1 development origin', async () => {
    const loopbackOrigin = 'http://127.0.0.1:5173';
    const agent = request.agent(app);
    const csrf = await agent.get('/api/auth/csrf').set('Origin', loopbackOrigin);
    expect(csrf.status).toBe(200);

    const response = await agent
      .post('/api/auth/signup')
      .set('Origin', loopbackOrigin)
      .set('X-CSRF-Token', csrf.body.csrfToken as string)
      .send({
        name: 'Loopback Student',
        email: 'loopback-origin@example.com',
        password: 'Loopback-Account-Password-27!',
        role: 'Student',
      });

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe('loopback-origin@example.com');
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

describe('server-side user API keys', () => {
  it('encrypts API key values and rejects tampered ciphertext', async () => {
    const cryptoHelpers = await import('../server/secretCrypto.ts');
    const { redactErrorFields, redactSecrets } = await import('../server/redaction.ts');
    const plaintext = `AIzaSy${'A'.repeat(32)}`;
    const githubToken = `ghp_${'s'.repeat(36)}`;
    const encrypted = cryptoHelpers.encryptUserApiKey(plaintext);

    expect(encrypted.ciphertext).not.toContain(plaintext);
    expect(cryptoHelpers.decryptUserApiKey(encrypted)).toBe(plaintext);
    const tamperedTag = Buffer.from(encrypted.authTag, 'base64');
    tamperedTag[0] ^= 1;
    expect(() =>
      cryptoHelpers.decryptUserApiKey({
        ...encrypted,
        authTag: tamperedTag.toString('base64'),
      })
    ).toThrow();

    expect(cryptoHelpers.parseEncryptionKey('02'.repeat(32))).toEqual(Buffer.alloc(32, 2));
    expect(redactSecrets(`${plaintext} ${githubToken}`)).not.toContain(plaintext);
    expect(redactSecrets(`${plaintext} ${githubToken}`)).not.toContain(githubToken);
    expect(redactErrorFields({ nested: { error: githubToken } })).toEqual({
      nested: { error: '[REDACTED]' },
    });
  });

  it('keeps saved keys encrypted, returns metadata only, and scopes use and deletion to each user', async () => {
    const firstUser = await insertTestUser('api-key-owner@example.com');
    const secondUser = await insertTestUser('api-key-other@example.com');
    const firstAgent = request.agent(app);
    const secondAgent = request.agent(app);
    expect((await postWithCsrf(firstAgent, '/api/auth/login', {
      email: firstUser.email,
      password: firstUser.password,
    })).status).toBe(200);
    expect((await postWithCsrf(secondAgent, '/api/auth/login', {
      email: secondUser.email,
      password: secondUser.password,
    })).status).toBe(200);

    const secret = `ghp_${'s'.repeat(36)}`;
    const csrf = await csrfToken(firstAgent);
    const saved = await firstAgent
      .put('/api/settings/keys/github')
      .set('Origin', origin)
      .set('X-CSRF-Token', csrf)
      .send({ value: secret });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(secret);

    const firstKeys = await firstAgent.get('/api/settings/keys');
    expect(firstKeys.status).toBe(200);
    expect(firstKeys.body.keys).toEqual([
      expect.objectContaining({ provider: 'github', last4: 'ssss' }),
    ]);
    expect(JSON.stringify(firstKeys.body)).not.toContain(secret);
    expect(JSON.stringify(firstKeys.body)).not.toContain('ciphertext');
    expect(database.getUserApiKey(secondUser.id, 'github')).toBeUndefined();

    const secondKeys = await secondAgent.get('/api/settings/keys');
    expect(secondKeys.body.keys).toEqual([]);
    const secondCsrf = await csrfToken(secondAgent);
    const otherDelete = await secondAgent
      .delete('/api/settings/keys/github')
      .set('Origin', origin)
      .set('X-CSRF-Token', secondCsrf);
    expect(otherDelete.status).toBe(200);
    expect(otherDelete.body.deleted).toBe(false);
    expect(database.getUserApiKey(firstUser.id, 'github')?.ciphertext).not.toContain(secret);
  });
});

describe('persistent chats and learning progress', () => {
  it('persists messages across a database reopen and scopes them to the chat owner', async () => {
    const user = await insertTestUser('chat-persistence@example.com');
    const otherUser = await insertTestUser('chat-other-owner@example.com');
    const chatId = crypto.randomUUID();
    const now = Date.now();
    database.createChat({ id: chatId, userId: user.id, repositoryId: 'owner__repo', title: 'New chat', now });
    database.saveChatMessage(user.id, chatId, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'Explain this file.',
      contextLabel: 'src/index.ts',
      createdAt: now + 1,
    });
    database.saveChatMessage(user.id, chatId, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'This is the entry point.',
      citations: [{ file_path: 'src/index.ts', start_line: 1, end_line: 8, label: 'Entry point' }],
      confidence: 'verified',
      createdAt: now + 2,
    });

    expect(database.getChatMessages(user.id, chatId, 50).messages).toHaveLength(2);
    expect(database.getChat(otherUser.id, chatId)).toBeUndefined();
    expect(database.getChatMessages(otherUser.id, chatId, 50).messages).toHaveLength(0);

    database.closeDatabase();
    database.initializeDatabase();

    const restored = database.getChatMessages(user.id, chatId, 50).messages;
    expect(restored.map((message) => message.content)).toEqual([
      'Explain this file.',
      'This is the entry point.',
    ]);
  });

  it('exports a chat and deletes its messages with the chat', async () => {
    const user = await insertTestUser('chat-export@example.com');
    const agent = request.agent(app);
    const login = await postWithCsrf(agent, '/api/auth/login', {
      email: user.email,
      password: user.password,
    });
    expect(login.status).toBe(200);

    const chatId = crypto.randomUUID();
    const now = Date.now();
    database.createChat({ id: chatId, userId: user.id, repositoryId: 'owner__repo', title: 'Export test', now });
    database.saveChatMessage(user.id, chatId, {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'Show the entry point.',
      contextLabel: 'src/index.ts',
      createdAt: now + 1,
    });
    database.saveChatMessage(user.id, chatId, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'The entry point is here.',
      citations: [{ file_path: 'src/index.ts', start_line: 1, end_line: 8, label: 'Entry point' }],
      createdAt: now + 2,
    });

    const exported = await agent.get(`/api/chats/${chatId}/export?format=markdown`);
    expect(exported.status).toBe(200);
    expect(exported.body.fileName).toBe('Export-test.md');
    expect(exported.body.content).toContain('The entry point is here.');

    const token = await csrfToken(agent);
    const deleted = await agent
      .delete(`/api/chats/${chatId}`)
      .set('Origin', origin)
      .set('X-CSRF-Token', token);
    expect(deleted.status).toBe(200);
    expect(database.getChat(user.id, chatId)).toBeUndefined();
    expect(database.getAllChatMessages(user.id, chatId)).toBeUndefined();
  });

  it('keeps server prompt history within message and character budgets', async () => {
    const user = await insertTestUser('chat-budget@example.com');
    const chatId = crypto.randomUUID();
    const now = Date.now();
    database.createChat({ id: chatId, userId: user.id, repositoryId: 'owner__repo', title: 'Budget test', now });
    for (let index = 0; index < 6; index += 1) {
      database.saveChatMessage(user.id, chatId, {
        id: crypto.randomUUID(),
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index}`,
        createdAt: now + index + 1,
      });
    }

    const history = database.getChatPromptHistory(user.id, chatId, 4, 18);
    expect(history.length).toBeLessThanOrEqual(4);
    expect(history.reduce((total, message) => total + message.content.length, 0)).toBeLessThanOrEqual(18);
    expect(history[history.length - 1].content).toBe('message-5');
  });

  it('stores explored files and tour steps separately per user', async () => {
    const user = await insertTestUser('progress-owner@example.com');
    const otherUser = await insertTestUser('progress-other@example.com');
    database.markExploredItem(user.id, 'owner__repo', 'file:src/index.ts', Date.now());
    database.completeTourStep(user.id, 'owner__repo', 'overview', 2, Date.now());

    expect(database.listExploredItems(user.id, 'owner__repo')).toEqual(['file:src/index.ts']);
    expect(database.listTourProgress(user.id, 'owner__repo').map((step) => step.stepIndex)).toEqual([2]);
    expect(database.listExploredItems(otherUser.id, 'owner__repo')).toEqual([]);
    expect(database.listTourProgress(otherUser.id, 'owner__repo')).toEqual([]);
  });

  it('deletes chats only when their owner has an enabled retention period', async () => {
    const user = await insertTestUser('chat-retention@example.com');
    const keepUser = await insertTestUser('chat-retention-keep@example.com');
    const now = Date.now();
    database.saveUserPreferences(user.id, {
      editorFontSize: 13,
      defaultDiagramType: 'system_architecture',
      showMinimap: true,
      chatRetentionDays: 1,
    }, now);
    const expiredId = crypto.randomUUID();
    const retainedId = crypto.randomUUID();
    database.createChat({
      id: expiredId,
      userId: user.id,
      repositoryId: 'owner__repo',
      title: 'Expired',
      now: now - 2 * 24 * 60 * 60 * 1000,
    });
    database.createChat({
      id: retainedId,
      userId: keepUser.id,
      repositoryId: 'owner__repo',
      title: 'Keep forever',
      now: now - 2 * 24 * 60 * 60 * 1000,
    });

    expect(database.deleteExpiredChats(now)).toBe(1);
    expect(database.getChat(user.id, expiredId)).toBeUndefined();
    expect(database.getChat(keepUser.id, retainedId)).toBeDefined();
  });
});

describe('GitHub OAuth sign-in and linking', () => {
  it('requires an authenticated CSRF-protected POST to start account linking', async () => {
    const agent = request.agent(app);
    const signup = await postWithCsrf(agent, '/api/auth/signup', {
      name: 'Link Start Student',
      email: 'link-start@example.com',
      password: 'Link-Start-Account-Password-27!',
    });
    expect(signup.status).toBe(201);

    const unsafeGet = await agent
      .get('/api/auth/github/start?purpose=link&redirect_after=%2Fsettings')
      .set('Origin', origin);
    expect(unsafeGet.status).toBe(400);

    const started = await postWithCsrf(agent, '/api/auth/github/link/start', {
      redirectAfter: '/settings',
    });
    expect(started.status).toBe(200);
    expect(started.body.authorizationUrl).toContain('https://github.com/login/oauth/authorize');
  });

  it('creates an account on first login and reuses it on later logins without exposing credentials', async () => {
    const agent = request.agent(app);
    const accessToken = 'gho-sensitive-access-token-for-test';
    const firstMock = mockGitHubIdentity({
      providerUserId: 78001,
      login: 'oauth-student',
      email: 'oauth-student@example.com',
      accessToken,
    });
    const logSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];

    const firstState = await startGitHubOAuth(agent);
    const first = await completeGitHubOAuth(agent, firstState);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('/workspace');
    expect(first.text).not.toContain(accessToken);
    expect(String(first.headers['set-cookie'])).not.toContain(accessToken);
    expect(firstMock.scopes.every((scope) => scope.isDone())).toBe(true);

    const created = database.findOAuthAccount('78001');
    expect(created?.user.email).toBe('oauth-student@example.com');
    expect(created?.user.emailVerifiedAt).not.toBeNull();
    expect(created?.user.passwordHash).toBeNull();
    expect((await agent.get('/api/auth/me')).body.user.id).toBe(created?.user.id);

    const secondMock = mockGitHubIdentity({
      providerUserId: 78001,
      login: 'oauth-student',
      email: 'oauth-student@example.com',
      accessToken: 'gho-second-sensitive-access-token',
    });
    const secondState = await startGitHubOAuth(agent);
    const second = await completeGitHubOAuth(agent, secondState, 'second-oauth-code');
    expect(second.status).toBe(302);
    expect(database.findOAuthAccount('78001')?.user.id).toBe(created?.user.id);
    expect(secondMock.scopes.every((scope) => scope.isDone())).toBe(true);

    const loggedOutput = logSpies.flatMap((spy) => spy.mock.calls.flat()).join(' ');
    expect(loggedOutput).not.toContain(accessToken);
    expect(loggedOutput).not.toContain('oauth-client-secret-for-tests');
    expect(loggedOutput).not.toContain(appPrivateKey);
  });

  it('rejects mismatched, reused, and expired state values', async () => {
    const agent = request.agent(app);
    const mismatchedState = await startGitHubOAuth(agent);
    const mismatch = await agent
      .get('/api/auth/github/callback')
      .query({ state: `${mismatchedState}x`, error: 'access_denied' });
    expect(mismatch.status).toBe(302);
    expect(mismatch.headers.location).toContain('github_error=expired_attempt');

    const reusedState = await startGitHubOAuth(agent);
    const firstAttempt = await agent
      .get('/api/auth/github/callback')
      .query({ state: reusedState, error: 'access_denied' });
    expect(firstAttempt.headers.location).toContain('github_error=access_denied');
    const reusedAttempt = await agent
      .get('/api/auth/github/callback')
      .query({ state: reusedState, error: 'access_denied' });
    expect(reusedAttempt.headers.location).toContain('github_error=expired_attempt');

    const expiredState = crypto.randomBytes(32).toString('base64url');
    database.createOAuthState({
      stateHash: crypto.createHash('sha256').update(expiredState).digest('hex'),
      codeVerifierEnc: null,
      purpose: 'login',
      userId: null,
      redirectAfter: '/login',
      createdAt: Date.now() - 20 * 60 * 1000,
      expiresAt: Date.now() - 1,
      usedAt: null,
    });
    const expired = await request(app)
      .get('/api/auth/github/callback')
      .query({ state: expiredState })
      .set('Cookie', `codebase_tutor_github_oauth_state=${expiredState}`);
    expect(expired.status).toBe(302);
    expect(expired.headers.location).toContain('github_error=expired_attempt');
  });

  it('refuses sign-in without a primary verified email', async () => {
    const agent = request.agent(app);
    const mock = mockGitHubIdentity({
      providerUserId: 78002,
      login: 'unverified-student',
      email: 'unverified@example.com',
      verified: false,
    });
    const state = await startGitHubOAuth(agent);
    const response = await completeGitHubOAuth(agent, state);

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('github_error=unverified_email');
    expect(database.findOAuthAccount('78002')).toBeUndefined();
    expect(mock.scopes.every((scope) => scope.isDone())).toBe(true);
  });

  it('reports PKCE rejection after validating and consuming the OAuth state', async () => {
    const agent = request.agent(app);
    const provider = nock('https://github.com')
      .post('/login/oauth/access_token')
      .reply(200, {
        error: 'incorrect_client_credentials',
        error_description: 'The code_verifier did not match the code_challenge.',
      });
    const state = await startGitHubOAuth(agent);
    const response = await completeGitHubOAuth(agent, state);

    expect(response.headers.location).toContain('github_error=pkce_rejected');
    expect(provider.isDone()).toBe(true);
  });

  it('does not auto-link a GitHub identity to an existing account by email', async () => {
    await insertTestUser('already-registered@example.com');
    const agent = request.agent(app);
    const mock = mockGitHubIdentity({
      providerUserId: 78003,
      login: 'already-registered',
      email: 'already-registered@example.com',
    });
    const state = await startGitHubOAuth(agent);
    const response = await completeGitHubOAuth(agent, state);

    expect(response.headers.location).toContain('github_error=existing_email');
    expect(database.findOAuthAccount('78003')).toBeUndefined();
    expect(mock.scopes.every((scope) => scope.isDone())).toBe(true);
  });

  it('refuses to link a GitHub identity already owned by another user', async () => {
    const owner = await insertTestUser('github-link-owner@example.com');
    const currentAgent = request.agent(app);
    const signup = await postWithCsrf(currentAgent, '/api/auth/signup', {
      name: 'Linking Student',
      email: 'github-link-current@example.com',
      password: 'Linking-Account-Password-27!',
    });
    expect(signup.status).toBe(201);
    expect(database.linkOAuthAccount({
      id: crypto.randomUUID(),
      userId: owner.id,
      providerUserId: '78004',
      providerLogin: 'owned-elsewhere',
      avatarUrl: null,
      now: Date.now(),
    })).toBe(true);

    const mock = mockGitHubIdentity({
      providerUserId: 78004,
      login: 'owned-elsewhere',
      email: 'github-link-owner@example.com',
    });
    const state = await startGitHubOAuth(currentAgent, '/settings', 'link');
    const response = await completeGitHubOAuth(currentAgent, state);

    expect(response.headers.location).toContain('github_error=github_account_linked');
    expect(database.getOAuthAccountForUser(signup.body.user.id)).toBeUndefined();
    expect(mock.scopes.every((scope) => scope.isDone())).toBe(true);
  });

  it('blocks disconnecting the only login method until a password is set', async () => {
    const agent = request.agent(app);
    const mock = mockGitHubIdentity({
      providerUserId: 78005,
      login: 'password-later',
      email: 'password-later@example.com',
    });
    const state = await startGitHubOAuth(agent);
    expect((await completeGitHubOAuth(agent, state)).status).toBe(302);
    expect(mock.scopes.every((scope) => scope.isDone())).toBe(true);

    const blocked = await postWithCsrf(agent, '/api/auth/github/disconnect');
    expect(blocked.status).toBe(409);

    const passwordSet = await postWithCsrf(agent, '/api/auth/change-password', {
      newPassword: 'OAuth-Only-Account-Password-38!',
    });
    expect(passwordSet.status).toBe(200);
    const disconnected = await postWithCsrf(agent, '/api/auth/github/disconnect');
    expect(disconnected.status).toBe(200);
    expect(database.findOAuthAccount('78005')).toBeUndefined();
  });

  it('removes OAuth account rows when the user is deleted', async () => {
    const user = await insertTestUser('oauth-delete@example.com');
    expect(database.linkOAuthAccount({
      id: crypto.randomUUID(),
      userId: user.id,
      providerUserId: '78006',
      providerLogin: 'delete-me',
      avatarUrl: null,
      now: Date.now(),
    })).toBe(true);

    expect(database.deleteUserAccount(user.id)).toBe(true);
    expect(database.findOAuthAccount('78006')).toBeUndefined();
  });
});

describe('GitHub App private access', () => {
  it('encrypts the installation token, hides it from the client, and revokes the installation', async () => {
    const user = await insertTestUser('github-app-user@example.com');
    const appAccessToken = 'ghs-sensitive-installation-token';
    const api = nock('https://api.github.com')
      .get('/app/installations/99001')
      .reply(200, {
        id: 99001,
        account: { login: 'private-owner' },
        permissions: { contents: 'read' },
      })
      .post('/app/installations/99001/access_tokens', (body) =>
        body.permissions?.contents === 'read'
      )
      .reply(201, {
        token: appAccessToken,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        permissions: { contents: 'read' },
      })
      .delete('/app/installations/99001')
      .reply(204);

    const githubApp = await import('../server/githubApp.ts');
    await githubApp.storeGitHubAppInstallation(user.id, '99001');
    const stored = database.getGithubAppInstallation(user.id, '99001');
    expect(stored?.accessTokenEnc).toBeTruthy();
    expect(stored?.accessTokenEnc).not.toContain(appAccessToken);
    const secretCrypto = await import('../server/secretCrypto.ts');
    expect(secretCrypto.decryptSecret(stored!.accessTokenEnc)).toBe(appAccessToken);

    const agent = request.agent(app);
    const login = await postWithCsrf(agent, '/api/auth/login', {
      email: user.email,
      password: user.password,
    });
    expect(login.status).toBe(200);
    const settings = await agent.get('/api/settings/github');
    expect(settings.status).toBe(200);
    expect(JSON.stringify(settings.body)).not.toContain(appAccessToken);
    expect(JSON.stringify(settings.body)).not.toContain(stored?.accessTokenEnc);
    expect(settings.body.installations).toEqual([
      { installationId: '99001', accountLogin: 'private-owner' },
    ]);

    const csrf = await csrfToken(agent);
    const revoked = await agent
      .delete('/api/settings/github-app/installations/99001')
      .set('Origin', origin)
      .set('X-CSRF-Token', csrf);
    expect(revoked.status).toBe(200);
    expect(JSON.stringify(revoked.body)).not.toContain(appAccessToken);
    expect(database.getGithubAppInstallation(user.id, '99001')).toBeUndefined();
    expect(api.isDone()).toBe(true);
  });
});
