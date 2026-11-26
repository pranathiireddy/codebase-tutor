import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  clearRepositoryCache,
  getAnalyzedRepo,
  getRepositoryRecord,
  listRepositories,
  PONYTAIL_REPO_URL,
  startRepositoryAnalysis,
} from './repoStore.ts';
import { verifyGitHubToken } from './github.ts';
import {
  generateGroundedExplanation,
  generateSpeechAudio,
  isServerGeminiKeyRejected,
  verifyGeminiApiKey,
} from './gemini.ts';
import { config } from './config.ts';
import {
  consumeGeminiDailyQuota,
  createSession,
  changePasswordAndRotateSession,
  clearFailedLogins,
  clearChats,
  completeTourStep,
  createChat,
  createOAuthState,
  createOAuthUser,
  consumeOAuthState,
  deleteChat,
  findOAuthAccount,
  getOAuthAccountForUser,
  getAllChatMessages,
  getChat,
  getChatMessages,
  getChatPromptHistory,
  getUserPreferences,
  findUserByEmail,
  findUserById,
  getUserApiKey,
  listUserApiKeys,
  saveUserApiKey,
  markUserApiKeyUsed,
  updateUserApiKeyModel,
  deleteUserApiKey,
  insertUser,
  listChatsForRepository,
  listExploredItems,
  listTourProgress,
  listActiveSessions,
  listGithubAppInstallations,
  markExploredItem,
  recordAuditEvent,
  recordFailedLogin,
  refreshOAuthAccount,
  linkOAuthAccount,
  unlinkOAuthAccount,
  renameChat,
  revokeAllSessions,
  revokeSession,
  saveChatMessage,
  saveUserPreferences,
  type UserApiKeyProvider,
  type ChatMessageRecord,
} from './db/index.ts';
import {
  clearSessionCookie,
  clearGitHubAppStateCookie,
  clearGitHubOAuthStateCookie,
  createSessionCredentials,
  csrfProtection,
  currentSessionIdHash,
  getAuthContext,
  hashPassword,
  LOGIN_LOCK_DURATION_MS,
  LOGIN_LOCK_THRESHOLD,
  loginAccountRateLimiter,
  loginIpRateLimiter,
  optionalAuth,
  requireAuth,
  setSessionCookie,
  setGitHubAppStateCookie,
  setGitHubOAuthStateCookie,
  GITHUB_APP_STATE_COOKIE_NAME,
  GITHUB_OAUTH_STATE_COOKIE_NAME,
  GITHUB_OAUTH_STATE_TTL_MS,
  SESSION_IDLE_TIMEOUT_MS,
  signupRateLimiter,
  validatePassword,
  verifyDummyPassword,
  verifyPassword,
} from './auth.ts';
import type { ChatCitation, ChatContext, DiagramType, UserProfile } from '../src/types/codebase.ts';
import { getGitHubAuthorizationUrl, fetchGitHubIdentity, GitHubOAuthError } from './githubOAuth.ts';
import { decryptSecret, decryptUserApiKey, encryptSecret, encryptUserApiKey } from './secretCrypto.ts';
import { redactErrorFields, redactSecrets } from './redaction.ts';
import {
  getGitHubAppInstallUrl,
  getGitHubAppTokenForRepository,
  GitHubAppError,
  removeGitHubAppInstallation,
  storeGitHubAppInstallation,
} from './githubApp.ts';
import { parseGitHubUrl } from './github.ts';

const DIAGRAM_TYPES = [
  'system_architecture',
  'data_flow',
  'sequence',
  'cicd_pipeline',
  'deployment',
  'class_diagram',
] as const;

const chatContextSchema = z
  .object({
    selectedFilePath: z.string().max(512).optional(),
    selectedSymbolId: z.string().max(256).optional(),
    selectedSymbolName: z.string().max(256).optional(),
    selectedCodeRange: z
      .object({
        start_line: z.number().int().positive(),
        end_line: z.number().int().positive(),
      })
      .optional(),
    selectedDiagramType: z.enum(DIAGRAM_TYPES).optional(),
    selectedNodeId: z.string().max(256).optional(),
    selectedNodeName: z.string().max(256).optional(),
    selectedEdgeId: z.string().max(256).optional(),
    attachedCode: z
      .object({
        file_path: z.string().max(512),
        start_line: z.number().int().positive(),
        end_line: z.number().int().positive(),
        code: z.string().max(400_000),
        symbol_name: z.string().max(256).optional(),
      })
      .optional(),
  })
  .strict();

const userPreferencesSchema = z.object({
  editorFontSize: z.union([z.literal(12), z.literal(13), z.literal(14), z.literal(15)]),
  defaultDiagramType: z.enum(DIAGRAM_TYPES),
  showMinimap: z.boolean(),
  chatRetentionDays: z.number().int().min(0).max(3650),
});

function serializeChatMessage(message: ChatMessageRecord) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    contextLabel: message.contextLabel ?? undefined,
    citations: message.citationsJson ? (JSON.parse(message.citationsJson) as ChatCitation[]) : undefined,
    confidenceSummary: message.confidenceJson
      ? (JSON.parse(message.confidenceJson) as 'verified' | 'partial' | 'unknown')
      : undefined,
    timestamp: new Date(message.createdAt).toISOString(),
  };
}

export function createApp(): express.Express {
  const app = express();
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const sendJson = res.json.bind(res);
    res.json = ((body: unknown) => sendJson(redactErrorFields(body))) as Response['json'];
    next();
  });
  app.use(express.json({ limit: config.jsonBodyLimitBytes }));
  app.use(cookieParser());
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('Origin');
    if (!origin) {
      next();
      return;
    }
    if (!config.allowedOrigins.includes(origin)) {
      if (req.path === '/api' || req.path.startsWith('/api/')) {
        res.status(403).json({ error: 'Origin is not allowed.' });
        return;
      }
      next();
      return;
    }

    res.vary('Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-Csrf-Token'
    );
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(csrfProtection);

  function getRequestUser(res: Response): UserProfile | undefined {
    return getAuthContext(res)?.user;
  }

  function audit(
    req: Request,
    event: string,
    userId?: string | null,
    detail?: Record<string, unknown>
  ): void {
    recordAuditEvent({
      id: crypto.randomUUID(),
      userId,
      event,
      ip: req.ip || null,
      userAgent: req.get('User-Agent') ?? null,
      createdAt: Date.now(),
      detail,
    });
  }

  function reserveServerKeyRequest(userId: string, hasUserKey: boolean): boolean {
    if (hasUserKey || !config.allowServerKey) return true;
    const today = new Date().toISOString().slice(0, 10);
    return consumeGeminiDailyQuota(userId, today, config.serverKeyDailyCap);
  }

  function getUserKey(userId: string, provider: UserApiKeyProvider): string | undefined {
    const record = getUserApiKey(userId, provider);
    if (!record) return undefined;
    markUserApiKeyUsed(userId, provider, Date.now());
    return decryptUserApiKey(record);
  }

  const githubStartLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many GitHub sign-in attempts. Try again later.' },
  });
  const githubCallbackLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many GitHub sign-in attempts. Try again later.' },
  });

  function parseRelativeRedirect(value: unknown, fallback: string): string | undefined {
    if (value === undefined) return fallback;
    if (
      typeof value !== 'string' ||
      value.length > 2048 ||
      !value.startsWith('/') ||
      value.startsWith('//') ||
      value.includes('\\') ||
      /[\u0000-\u001f]/.test(value)
    ) {
      return undefined;
    }
    try {
      const url = new URL(value, 'https://codebase-tutor.invalid');
      if (url.origin !== 'https://codebase-tutor.invalid') return undefined;
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return undefined;
    }
  }

  function addRedirectResult(path: string, name: string, value: string): string {
    const url = new URL(path, 'https://codebase-tutor.invalid');
    url.searchParams.set(name, value);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function compareStateValues(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  function hashOAuthState(state: string): string {
    return crypto.createHash('sha256').update(state).digest('hex');
  }

  function completeGitHubLogin(
    req: Request,
    res: Response,
    user: { id: string; email: string; name: string; role: string },
    redirectAfter: string
  ): void {
    const { token, session } = createSessionCredentials(user.id, req);
    createSession(session);
    setSessionCookie(res, token);
    clearFailedLogins(user.id, session.now);
    audit(req, 'github_login_success', user.id);
    res.redirect(redirectAfter);
  }

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'codebase-tutor' });
});

// Auth routes
app.get('/api/auth/csrf', (req: Request, res: Response) => {
  res.json({ csrfToken: res.locals.csrfToken ?? req.cookies?.codebase_tutor_csrf });
});

app.get('/api/auth/github/config', (_req: Request, res: Response) => {
  res.json({ enabled: config.githubOAuthConfigured });
});

app.get('/api/auth/github/start', githubStartLimiter, optionalAuth, (req: Request, res: Response) => {
  const rawPurpose = req.query.purpose;
  if (rawPurpose !== undefined && rawPurpose !== 'login') {
    res.status(400).json({ error: 'GitHub account linking must be started by an authenticated request.' });
    return;
  }
  const auth = getAuthContext(res);
  if (!config.githubOAuthConfigured) {
    res.status(503).json({ error: 'GitHub sign-in is not configured.' });
    return;
  }
  const redirectAfter = parseRelativeRedirect(
    req.query.redirect_after,
    '/workspace'
  );
  if (!redirectAfter) {
    res.status(400).json({ error: 'The redirect must be a relative path.' });
    return;
  }

  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const now = Date.now();
  const authorizationUrl = getGitHubAuthorizationUrl(state, challenge);
  createOAuthState({
    stateHash: hashOAuthState(state),
    codeVerifierEnc: encryptSecret(verifier),
    purpose: 'login',
    userId: null,
    redirectAfter,
    createdAt: now,
    expiresAt: now + GITHUB_OAUTH_STATE_TTL_MS,
    usedAt: null,
  });
  setGitHubOAuthStateCookie(res, state);
  audit(req, 'github_login_start', auth?.user.id ?? null);
  res.redirect(authorizationUrl);
});

app.post(
  '/api/auth/github/link/start',
  githubStartLimiter,
  requireAuth,
  (req: Request, res: Response) => {
    const auth = getAuthContext(res)!;
    if (!config.githubOAuthConfigured) {
      res.status(503).json({ error: 'GitHub sign-in is not configured.' });
      return;
    }
    const redirectAfter = parseRelativeRedirect(
      (req.body as { redirectAfter?: unknown })?.redirectAfter,
      '/settings'
    );
    if (!redirectAfter) {
      res.status(400).json({ error: 'The redirect must be a relative path.' });
      return;
    }

    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const now = Date.now();
    const authorizationUrl = getGitHubAuthorizationUrl(state, challenge);
    createOAuthState({
      stateHash: hashOAuthState(state),
      codeVerifierEnc: encryptSecret(verifier),
      purpose: 'link',
      userId: auth.user.id,
      redirectAfter,
      createdAt: now,
      expiresAt: now + GITHUB_OAUTH_STATE_TTL_MS,
      usedAt: null,
    });
    setGitHubOAuthStateCookie(res, state);
    audit(req, 'github_link_start', auth.user.id);
    res.json({ authorizationUrl });
  }
);

app.get(
  '/api/auth/github/callback',
  githubCallbackLimiter,
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    const stateValue = req.query.state;
    const cookieState = req.cookies?.[GITHUB_OAUTH_STATE_COOKIE_NAME];
    if (
      typeof stateValue !== 'string' ||
      typeof cookieState !== 'string' ||
      !compareStateValues(stateValue, cookieState)
    ) {
      clearGitHubOAuthStateCookie(res);
      audit(req, 'github_login_failure', null, { reason: 'state_mismatch' });
      res.redirect('/login?github_error=expired_attempt');
      return;
    }

    const state = consumeOAuthState(hashOAuthState(stateValue), Date.now());
    clearGitHubOAuthStateCookie(res);
    if (!state || (state.purpose !== 'login' && state.purpose !== 'link')) {
      audit(req, 'github_login_failure', null, { reason: 'expired_attempt' });
      res.redirect('/login?github_error=expired_attempt');
      return;
    }
    const isLink = state.purpose === 'link';
    const failureEvent = isLink ? 'github_link_failure' : 'github_login_failure';
    const failureRedirect = (reason: string) => {
      audit(req, failureEvent, state.userId, { reason });
      res.redirect(addRedirectResult(
        isLink ? state.redirectAfter : state.redirectAfter === '/signup' ? '/signup' : '/login',
        'github_error',
        reason
      ));
    };
    const auth = getAuthContext(res);
    if (isLink && (!auth || auth.user.id !== state.userId)) {
      failureRedirect('session_changed');
      return;
    }
    if (typeof req.query.error === 'string') {
      failureRedirect(req.query.error === 'access_denied' ? 'access_denied' : 'provider_error');
      return;
    }
    const code = req.query.code;
    if (typeof code !== 'string' || !code || !state.codeVerifierEnc) {
      failureRedirect('invalid_code');
      return;
    }

    let identity: Awaited<ReturnType<typeof fetchGitHubIdentity>>;
    try {
      identity = await fetchGitHubIdentity(code, decryptSecret(state.codeVerifierEnc));
    } catch (error) {
      const reason = error instanceof GitHubOAuthError ? error.code : 'provider_error';
      failureRedirect(reason);
      return;
    }

    try {
      if (isLink) {
        const currentUserId = auth!.user.id;
        const linkedIdentity = findOAuthAccount(identity.providerUserId);
        if (linkedIdentity && linkedIdentity.user.id !== currentUserId) {
          failureRedirect('github_account_linked');
          return;
        }
        const currentLink = getOAuthAccountForUser(currentUserId);
        if (currentLink && currentLink.providerUserId !== identity.providerUserId) {
          failureRedirect('github_already_linked');
          return;
        }
        if (linkedIdentity) {
          refreshOAuthAccount(
            identity.providerUserId,
            identity.providerLogin,
            identity.avatarUrl,
            Date.now()
          );
        } else if (!linkOAuthAccount({
          id: crypto.randomUUID(),
          userId: currentUserId,
          providerUserId: identity.providerUserId,
          providerLogin: identity.providerLogin,
          avatarUrl: identity.avatarUrl,
          now: Date.now(),
        })) {
          failureRedirect('github_account_linked');
          return;
        }
        audit(req, 'github_account_linked', currentUserId);
        res.redirect(addRedirectResult(state.redirectAfter, 'github', 'connected'));
        return;
      }

      const linked = findOAuthAccount(identity.providerUserId);
      if (linked) {
        refreshOAuthAccount(
          identity.providerUserId,
          identity.providerLogin,
          identity.avatarUrl,
          Date.now()
        );
        const successRedirect = ['/login', '/signup'].includes(state.redirectAfter)
          ? '/workspace'
          : state.redirectAfter;
        completeGitHubLogin(req, res, linked.user, successRedirect);
        return;
      }

      const now = Date.now();
      const outcome = createOAuthUser(
        {
          id: crypto.randomUUID(),
          email: identity.verifiedEmail,
          name: identity.name,
          role: 'Student / Developer',
          emailVerifiedAt: now,
        },
        {
          id: crypto.randomUUID(),
          providerUserId: identity.providerUserId,
          providerLogin: identity.providerLogin,
          avatarUrl: identity.avatarUrl,
          now,
        }
      );
      const concurrentLogin = findOAuthAccount(identity.providerUserId);
      if (concurrentLogin) {
        const successRedirect = ['/login', '/signup'].includes(state.redirectAfter)
          ? '/workspace'
          : state.redirectAfter;
        completeGitHubLogin(req, res, concurrentLogin.user, successRedirect);
        return;
      }
      if (outcome === 'email_exists') {
        failureRedirect('existing_email');
        return;
      }
      failureRedirect('github_account_linked');
    } catch (error) {
      next(error);
    }
  }
);

app.post('/api/auth/signup', signupRateLimiter(), async (req: Request, res: Response) => {
  const { name, email, password, role } = (req.body ?? {}) as {
    name?: unknown;
    email?: unknown;
    password?: unknown;
    role?: unknown;
  };
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (
    !cleanName ||
    cleanName.length > 120 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) ||
    typeof password !== 'string'
  ) {
    res.status(400).json({ error: 'Enter a name and a valid email address.' });
    return;
  }
  const passwordError = validatePassword(password, cleanEmail, cleanName);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  const user: UserProfile & { passwordHash: string } = {
    id: crypto.randomUUID(),
    name: cleanName,
    email: cleanEmail,
    role: typeof role === 'string' && role.trim() ? role.trim() : 'Student / Developer',
    passwordHash: await hashPassword(password),
  };
  if (!insertUser(user)) {
    res.status(409).json({ error: 'An account with that email already exists.' });
    return;
  }

  const { token, session } = createSessionCredentials(user.id, req);
  createSession(session);
  setSessionCookie(res, token);
  audit(req, 'signup', user.id);
  const { passwordHash: _passwordHash, ...profile } = user;
  res.status(201).json({ user: profile });
});

const loginIpLimiter = loginIpRateLimiter();
const loginAccountLimiter = loginAccountRateLimiter();
app.post(
  '/api/auth/login',
  loginIpLimiter,
  loginAccountLimiter,
  async (req: Request, res: Response) => {
    const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || typeof password !== 'string' || !password) {
      res.status(400).json({ error: 'Enter a valid email address and password.' });
      return;
    }

    const now = Date.now();
    const user = findUserByEmail(cleanEmail);
    if (!user) {
      await verifyDummyPassword(password);
      audit(req, 'login_failure', null, { reason: 'invalid_credentials' });
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
    if (user.lockedUntil !== null && user.lockedUntil > now) {
      await verifyDummyPassword(password);
      audit(req, 'login_failure', user.id, { reason: 'invalid_credentials' });
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const passwordMatches = user.passwordHash
      ? await verifyPassword(user.passwordHash, password)
      : (await verifyDummyPassword(password), false);
    if (!passwordMatches) {
      const failure = recordFailedLogin(user.id, now, LOGIN_LOCK_THRESHOLD, LOGIN_LOCK_DURATION_MS);
      audit(req, 'login_failure', user.id, { reason: 'invalid_credentials' });
      if (failure.lockedUntil !== null && failure.failedLogins === LOGIN_LOCK_THRESHOLD) {
        audit(req, 'lockout', user.id, { durationMs: LOGIN_LOCK_DURATION_MS });
      }
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    clearFailedLogins(user.id, now);
    const { token, session } = createSessionCredentials(user.id, req, now);
    createSession(session);
    setSessionCookie(res, token);
    audit(req, 'login_success', user.id);
    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  }
);

app.get('/api/auth/me', requireAuth, (_req: Request, res: Response) => {
  res.json({ user: getRequestUser(res) });
});

app.post('/api/auth/change-password', requireAuth, async (req: Request, res: Response) => {
  const auth = getAuthContext(res)!;
  const body = (req.body ?? {}) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  };
  if (typeof body.newPassword !== 'string') {
    res.status(400).json({ error: 'Enter a new password.' });
    return;
  }
  const user = findUserById(auth.user.id);
  if (!user) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }
  if (user.passwordHash && (
    typeof body.currentPassword !== 'string' ||
    !(await verifyPassword(user.passwordHash, body.currentPassword))
  )) {
    res.status(400).json({ error: 'Current password is incorrect.' });
    return;
  }
  const passwordError = validatePassword(body.newPassword, user.email, user.name);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  const { token, session } = createSessionCredentials(user.id, req);
  if (!changePasswordAndRotateSession(user.id, await hashPassword(body.newPassword), session)) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }
  setSessionCookie(res, token);
  audit(req, 'password_change', user.id);
  res.json({ ok: true });
});

app.get('/api/auth/sessions', requireAuth, (_req: Request, res: Response) => {
  const auth = getAuthContext(res)!;
  const sessions = listActiveSessions(auth.user.id, Date.now(), SESSION_IDLE_TIMEOUT_MS);
  res.json({
    sessions: sessions.map((session) => ({
      ...session,
      current: session.idHash === auth.session.idHash,
    })),
  });
});

app.delete('/api/auth/sessions/:sessionId', requireAuth, (req: Request, res: Response) => {
  const auth = getAuthContext(res)!;
  const sessionId = String(req.params.sessionId);
  if (!/^[a-f0-9]{64}$/i.test(sessionId)) {
    res.status(400).json({ error: 'Invalid session identifier.' });
    return;
  }
  if (!revokeSession(sessionId, auth.user.id, Date.now())) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }
  if (sessionId === auth.session.idHash) clearSessionCookie(res);
  audit(req, 'session_revoked', auth.user.id);
  res.json({ ok: true });
});

app.post('/api/auth/logout-everywhere', requireAuth, (req: Request, res: Response) => {
  const auth = getAuthContext(res)!;
  revokeAllSessions(auth.user.id, Date.now());
  clearSessionCookie(res);
  audit(req, 'logout_everywhere', auth.user.id);
  res.json({ ok: true });
});

app.post('/api/auth/logout', optionalAuth, (req: Request, res: Response) => {
  const auth = getAuthContext(res);
  if (auth) {
    revokeSession(auth.session.idHash, auth.user.id, Date.now());
    audit(req, 'logout', auth.user.id);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/settings/github', requireAuth, (_req: Request, res: Response) => {
  const auth = getAuthContext(res)!;
  const user = findUserById(auth.user.id);
  if (!user) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }
  const account = getOAuthAccountForUser(user.id);
  res.json({
    githubOAuthConfigured: config.githubOAuthConfigured,
    passwordSet: Boolean(user.passwordHash),
    githubAccount: account
      ? { login: account.providerLogin, avatarUrl: account.avatarUrl }
      : null,
    githubAppConfigured: config.githubAppConfigured,
    installations: listGithubAppInstallations(user.id).map((installation) => ({
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
    })),
  });
});

app.post('/api/auth/github/disconnect', requireAuth, (req: Request, res: Response) => {
  const auth = getAuthContext(res)!;
  const user = findUserById(auth.user.id);
  if (!user) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }
  if (!user.passwordHash) {
    res.status(409).json({ error: 'Set a password before disconnecting your only sign-in method.' });
    return;
  }
  if (!unlinkOAuthAccount(user.id)) {
    res.status(404).json({ error: 'No GitHub account is connected.' });
    return;
  }
  audit(req, 'github_account_unlinked', user.id);
  res.json({ ok: true });
});

app.post(
  '/api/settings/github-app/install/start',
  githubStartLimiter,
  requireAuth,
  (req: Request, res: Response) => {
    const auth = getAuthContext(res)!;
    if (!config.githubAppConfigured) {
      res.status(503).json({ error: 'Private repository access is not configured.' });
      return;
    }
    if ((req.body as { consent?: unknown })?.consent !== 'read_only_contents') {
      res.status(400).json({ error: 'Confirm the read-only Contents access before continuing.' });
      return;
    }
    const redirectAfter = parseRelativeRedirect(
      (req.body as { redirectAfter?: unknown })?.redirectAfter,
      '/settings'
    );
    if (!redirectAfter) {
      res.status(400).json({ error: 'The redirect must be a relative path.' });
      return;
    }

    const state = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const authorizationUrl = getGitHubAppInstallUrl(state);
    createOAuthState({
      stateHash: hashOAuthState(state),
      codeVerifierEnc: null,
      purpose: 'private_install',
      userId: auth.user.id,
      redirectAfter,
      createdAt: now,
      expiresAt: now + GITHUB_OAUTH_STATE_TTL_MS,
      usedAt: null,
    });
    setGitHubAppStateCookie(res, state);
    audit(req, 'github_private_access_start', auth.user.id);
    res.json({ authorizationUrl });
  }
);

app.get(
  '/api/auth/github-app/callback',
  githubCallbackLimiter,
  optionalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    const stateValue = req.query.state;
    const cookieState = req.cookies?.[GITHUB_APP_STATE_COOKIE_NAME];
    if (
      typeof stateValue !== 'string' ||
      typeof cookieState !== 'string' ||
      !compareStateValues(stateValue, cookieState)
    ) {
      clearGitHubAppStateCookie(res);
      audit(req, 'github_private_access_failure', null, { reason: 'state_mismatch' });
      res.redirect('/settings?github_error=expired_attempt');
      return;
    }
    const state = consumeOAuthState(hashOAuthState(stateValue), Date.now());
    clearGitHubAppStateCookie(res);
    if (
      !state ||
      state.purpose !== 'private_install' ||
      !state.userId ||
      getAuthContext(res)?.user.id !== state.userId
    ) {
      audit(req, 'github_private_access_failure', state?.userId ?? null, {
        reason: 'expired_attempt',
      });
      res.redirect('/settings?github_error=expired_attempt');
      return;
    }
    const installationId = req.query.installation_id;
    if (
      (req.query.setup_action !== 'install' && req.query.setup_action !== 'update') ||
      typeof installationId !== 'string' ||
      !/^\d{1,20}$/.test(installationId)
    ) {
      audit(req, 'github_private_access_failure', state.userId, { reason: 'installation_denied' });
      res.redirect(addRedirectResult(state.redirectAfter, 'github_error', 'private_access_denied'));
      return;
    }

    try {
      await storeGitHubAppInstallation(state.userId, installationId);
      audit(req, 'github_private_access_granted', state.userId);
      res.redirect(addRedirectResult(state.redirectAfter, 'private_access', 'connected'));
    } catch (error) {
      if (!(error instanceof GitHubAppError)) {
        next(error);
        return;
      }
      audit(req, 'github_private_access_failure', state.userId, { reason: 'installation_failed' });
      res.redirect(addRedirectResult(state.redirectAfter, 'github_error', 'private_install_failed'));
    }
  }
);

app.delete(
  '/api/settings/github-app/installations/:installationId',
  requireAuth,
  async (req: Request, res: Response) => {
    const auth = getAuthContext(res)!;
    const installationId = String(req.params.installationId);
    if (!/^\d{1,20}$/.test(installationId)) {
      res.status(400).json({ error: 'Invalid GitHub App installation identifier.' });
      return;
    }
    try {
      await removeGitHubAppInstallation(auth.user.id, installationId);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Unable to revoke the GitHub App installation.',
      });
      return;
    }
    audit(req, 'github_private_access_revoked', auth.user.id);
    res.json({ ok: true });
  }
);

// Repositories API
app.get('/api/repositories', optionalAuth, (_req: Request, res: Response) => {
  const user = getRequestUser(res);
  res.json({
    repositories: listRepositories(user?.id),
    featuredDemoUrl: PONYTAIL_REPO_URL,
  });
});

// Settings status and user-scoped encrypted API keys
app.get('/api/settings/status', requireAuth, (_req: Request, res: Response) => {
  const geminiKey = config.geminiApiKey ?? '';
  const githubTok = config.githubToken ?? '';
  res.json({
    hasServerGeminiKey:
      config.allowServerKey &&
      Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY') &&
      !isServerGeminiKeyRejected(geminiKey),
    serverGeminiRejected: isServerGeminiKeyRejected(),
    hasServerGithubToken: Boolean(githubTok),
  });
});

const userKeyProviders = new Set<UserApiKeyProvider>(['gemini', 'github', 'github_owner']);

function parseUserKeyProvider(value: string): UserApiKeyProvider | undefined {
  return userKeyProviders.has(value as UserApiKeyProvider) ? value as UserApiKeyProvider : undefined;
}

app.get('/api/settings/keys', requireAuth, (_req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  res.json({ keys: listUserApiKeys(user.id) });
});

app.post('/api/settings/keys/:provider/test', requireAuth, async (req: Request, res: Response) => {
  const provider = parseUserKeyProvider(String(req.params.provider));
  const user = getRequestUser(res)!;
  const body = req.body as { value?: unknown; model?: unknown };
  const value = typeof body.value === 'string' ? body.value.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : undefined;
  if (!provider || !value || value.length > 4096) {
    res.status(400).json({ valid: false, error: 'Enter a valid credential to test.' });
    return;
  }

  if (provider === 'gemini') {
    const result = await verifyGeminiApiKey(value, model);
    res.json({ ...result, error: result.error ? redactSecrets(result.error) : undefined });
    return;
  }
  if (provider === 'github') {
    const result = await verifyGitHubToken(value);
    res.json({ ...result, error: result.error ? redactSecrets(result.error) : undefined });
    return;
  }

  const owner = value.replace(/^@/, '');
  const valid = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner);
  res.json({
    valid,
    error: valid ? undefined : 'Enter a valid GitHub username or organization name.',
  });
});

app.put('/api/settings/keys/:provider', requireAuth, (req: Request, res: Response) => {
  const provider = parseUserKeyProvider(String(req.params.provider));
  const user = getRequestUser(res)!;
  const body = req.body as { value?: unknown; model?: unknown };
  let value = typeof body.value === 'string' ? body.value.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : null;
  if (!provider || !value || value.length > 4096) {
    res.status(400).json({ error: 'Enter a valid credential to save.' });
    return;
  }
  if (provider === 'github_owner') value = value.replace(/^@/, '');
  if (
    (provider === 'github_owner' &&
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)) ||
    (provider === 'gemini' &&
      model !== null &&
      (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(model)))
  ) {
    res.status(400).json({ error: 'Credential details are invalid.' });
    return;
  }
  const encrypted = encryptUserApiKey(value);
  saveUserApiKey(
    {
      id: crypto.randomUUID(),
      userId: user.id,
      provider,
      ...encrypted,
      last4: value.slice(-4),
      model: provider === 'gemini' ? model || 'gemini-4-hydrogen' : null,
    },
    Date.now()
  );
  res.json({ ok: true, provider });
});

app.delete('/api/settings/keys/:provider', requireAuth, (req: Request, res: Response) => {
  const provider = parseUserKeyProvider(String(req.params.provider));
  if (!provider) {
    res.status(400).json({ error: 'Unknown credential provider.' });
    return;
  }
  const user = getRequestUser(res)!;
  res.json({ deleted: deleteUserApiKey(user.id, provider) });
});

app.patch('/api/settings/keys/gemini', requireAuth, (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(model)) {
    res.status(400).json({ error: 'Enter a valid Gemini model name.' });
    return;
  }
  if (!getUserApiKey(user.id, 'gemini')) {
    res.status(404).json({ error: 'Save a Gemini API key before changing its model.' });
    return;
  }
  updateUserApiKeyModel(user.id, 'gemini', model);
  res.json({ ok: true });
});

app.post('/api/repositories/analyze', requireAuth, async (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const { url, forceRefresh } = req.body as { url?: string; forceRefresh?: boolean };
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'Repository URL is required.' });
    return;
  }
  try {
    const defaultOwner = getUserKey(user.id, 'github_owner');
    const repositoryInput =
      defaultOwner && !url.includes('/') && !url.includes(':') ? `${defaultOwner}/${url}` : url;
    const userGitHubToken = getUserKey(user.id, 'github');
    let githubToken = userGitHubToken;
    if (!githubToken) {
      const repository = parseGitHubUrl(repositoryInput);
      githubToken = await getGitHubAppTokenForRepository(
        user.id,
        repository.owner,
        repository.name
      );
    }
    const record = await startRepositoryAnalysis(repositoryInput, {
      forceRefresh: Boolean(forceRefresh),
      githubToken,
      userId: user.id,
    });
    res.json({ repository: record });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Invalid repository URL.',
    });
  }
});

app.get('/api/repositories/:id/analysis', optionalAuth, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const user = getRequestUser(res);
  const record = getRepositoryRecord(id, user?.id);
  if (!record) {
    res.status(404).json({ error: 'Repository not found. Please import it first.' });
    return;
  }
  res.json({ repository: record });
});

app.get('/api/repositories/:id/files', optionalAuth, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const user = getRequestUser(res);
  const data = getAnalyzedRepo(id, user?.id);
  if (!data) {
    res.status(404).json({ error: 'Repository analysis is not ready yet.' });
    return;
  }
  res.json({
    tree: data.analysis.fileTree,
    files: data.analysis.filesMeta,
  });
});

app.get('/api/repositories/:id/files/content', optionalAuth, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const filePath = String(req.query.path ?? '');
  const user = getRequestUser(res);
  const data = getAnalyzedRepo(id, user?.id);
  if (!data) {
    res.status(404).json({ error: 'Repository analysis is not ready yet.' });
    return;
  }
  const fileMeta = data.analysis.filesMeta.find((f) => f.path === filePath);
  if (!fileMeta) {
    res.status(404).json({ error: `File "${filePath}" not found in repository.` });
    return;
  }

  const content = data.analysis.fileContents[filePath] ?? '// Binary or asset file (content preview omitted)';
  const symbols = data.analysis.symbols.filter((s) => s.file_path === filePath);
  const fileNodeId = `file:${filePath}`;

  const incomingDependencies = data.graph.edges
    .filter((e) => e.target === fileNodeId && e.relationship === 'imports')
    .map((e) => ({
      file_path: e.source.replace(/^file:/, ''),
      relationship: e.relationship,
      line: e.evidence?.start_line,
    }));

  const outgoingDependencies = data.graph.edges
    .filter((e) => e.source === fileNodeId && (e.relationship === 'imports' || e.relationship === 'uses'))
    .map((e) => ({
      file_path: e.target.replace(/^file:/, '').replace(/^ext:/, 'pkg:'),
      relationship: e.relationship,
      line: e.evidence?.start_line,
    }));

  res.json({
    file: fileMeta,
    content,
    symbols,
    incomingDependencies,
    outgoingDependencies,
  });
});

app.get('/api/repositories/:id/trace', optionalAuth, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const rawQuery = String(req.query.q ?? '').trim();
  const preferredFile = String(req.query.preferredFile ?? '').trim();
  const user = getRequestUser(res);
  const data = getAnalyzedRepo(id, user?.id);
  if (!data) {
    res.status(404).json({ error: 'Repository analysis is not ready yet.' });
    return;
  }
  if (!rawQuery || rawQuery.length < 2) {
    res.json({ match: null });
    return;
  }

  const clean = rawQuery.replace(/^['"]|['"]$/g, '').replace(/\([^)]*\)$/, '').trim();
  const baseIdent = clean.includes('.') ? clean.split('.').pop()!.trim() : clean;
  const needles = Array.from(new Set([clean, baseIdent].filter((n) => n.length >= 2)));

  // 1. Check extracted symbols first
  const matchingSymbols = data.analysis.symbols.filter((s) =>
    needles.some((n) => s.name === n || s.name.toLowerCase() === n.toLowerCase())
  );
  if (matchingSymbols.length > 0) {
    const picked =
      matchingSymbols.find((s) => preferredFile && s.file_path === preferredFile) ||
      matchingSymbols.find((s) => needles.includes(s.name)) ||
      matchingSymbols[0];
    res.json({
      match: {
        file_path: picked.file_path,
        start_line: picked.start_line,
        end_line: picked.end_line,
        symbol_id: picked.id,
      },
    });
    return;
  }

  // 2. Search file contents (prioritize preferredFile; rank exact decl > case-insensitive decl > non-import ref > filename match > import ref)
  const orderedFiles = [...data.analysis.filesMeta]
    .filter((f) => f.role !== 'asset')
    .sort((a, b) => {
      if (a.path === preferredFile) return -1;
      if (b.path === preferredFile) return 1;
      return 0;
    });

  let ciDeclMatch: { file_path: string; start_line: number; end_line: number } | null = null;
  let nonImportMatch: { file_path: string; start_line: number; end_line: number } | null = null;
  let fallbackMatch: { file_path: string; start_line: number; end_line: number } | null = null;

  const isImportLine = (line: string) => /^\s*(?:import|from|require\s*\()/.test(line);

  for (const needle of needles) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isWord = /^[A-Za-z0-9_$-]+$/.test(needle);
    const declPattern = `\\b(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:function|const|let|var|type|interface|class|enum|def|app\\.(?:get|post|put|delete))\\s+${escaped}\\b`;
    const exactDeclRe = isWord ? new RegExp(declPattern) : null;
    const ciDeclRe = isWord ? new RegExp(declPattern, 'i') : null;
    const wordRe = isWord ? new RegExp(`\\b${escaped}\\b`) : null;
    const ciWordRe = isWord ? new RegExp(`\\b${escaped}\\b`, 'i') : null;

    for (const meta of orderedFiles) {
      const text = data.analysis.fileContents[meta.path];
      if (!text) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (exactDeclRe && exactDeclRe.test(line)) {
          res.json({
            match: {
              file_path: meta.path,
              start_line: i + 1,
              end_line: Math.min(lines.length, i + 15),
            },
          });
          return;
        }
        if (!ciDeclMatch && ciDeclRe && ciDeclRe.test(line)) {
          ciDeclMatch = {
            file_path: meta.path,
            start_line: i + 1,
            end_line: Math.min(lines.length, i + 15),
          };
        }
        if (!nonImportMatch && !isImportLine(line) && (wordRe ? wordRe.test(line) : line.includes(needle))) {
          nonImportMatch = {
            file_path: meta.path,
            start_line: i + 1,
            end_line: i + 1,
          };
        }
        if (!fallbackMatch && (ciWordRe ? ciWordRe.test(line) : line.toLowerCase().includes(needle.toLowerCase()))) {
          fallbackMatch = {
            file_path: meta.path,
            start_line: i + 1,
            end_line: i + 1,
          };
        }
      }
    }
  }

  const stemMatch = orderedFiles.find(
    (f) => f.name.replace(/\.[^.]+$/, '').toLowerCase() === clean.toLowerCase()
  );

  res.json({
    match:
      ciDeclMatch ??
      nonImportMatch ??
      (stemMatch ? { file_path: stemMatch.path, start_line: 1, end_line: Math.min(30, stemMatch.lineCount || 30) } : null) ??
      fallbackMatch,
  });
});

app.get('/api/repositories/:id/graph', optionalAuth, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const user = getRequestUser(res);
  const data = getAnalyzedRepo(id, user?.id);
  if (!data) {
    res.status(404).json({ error: 'Repository analysis is not ready yet.' });
    return;
  }
  res.json({ graph: data.graph });
});

app.get('/api/repositories/:id/diagrams', optionalAuth, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const user = getRequestUser(res);
  const data = getAnalyzedRepo(id, user?.id);
  if (!data) {
    res.status(404).json({ error: 'Repository analysis is not ready yet.' });
    return;
  }
  const list = Object.values(data.diagrams).map((d) => ({
    id: d.id,
    type: d.type,
    title: d.title,
    subtitle: d.subtitle,
    available: d.available,
    availabilityNote: d.availabilityNote,
    summary: d.summary,
    nodeCount: d.nodes.length,
    edgeCount: d.edges.length,
  }));
  res.json({ diagrams: list });
});

app.get('/api/repositories/:id/diagrams/:type', optionalAuth, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const type = String(req.params.type) as DiagramType;
  const user = getRequestUser(res);
  const data = getAnalyzedRepo(id, user?.id);
  if (!data) {
    res.status(404).json({ error: 'Repository analysis is not ready yet.' });
    return;
  }
  const diagram = data.diagrams[type];
  if (!diagram) {
    res.status(404).json({ error: `Unknown diagram type "${type}".` });
    return;
  }
  res.json({ diagram });
});

app.get('/api/repositories/:id/diagrams/:type/nodes/:nodeId', optionalAuth, (req: Request, res: Response) => {
  const id = String(req.params.id);
  const type = String(req.params.type) as DiagramType;
  const nodeId = decodeURIComponent(String(req.params.nodeId));
  const user = getRequestUser(res);
  const data = getAnalyzedRepo(id, user?.id);
  if (!data) {
    res.status(404).json({ error: 'Repository analysis is not ready yet.' });
    return;
  }
  const diagram = data.diagrams[type];
  const node = diagram?.nodes.find((n) => n.id === nodeId || n.graphNodeId === nodeId);
  if (!node) {
    res.status(404).json({ error: 'Node not found in diagram.' });
    return;
  }

  const incoming = diagram.edges.filter((e) => e.target === node.id);
  const outgoing = diagram.edges.filter((e) => e.source === node.id);
  const symbols = (node.childSymbolIds ?? [])
    .map((sid) => data.analysis.symbols.find((s) => s.id === sid))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  res.json({
    node,
    incoming,
    outgoing,
    symbols,
  });
});

app.get('/api/preferences', requireAuth, (_req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const preferences = getUserPreferences(user.id);
  res.json({ preferences });
});

app.put('/api/preferences', requireAuth, (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const parsed = userPreferencesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Preferences contain an invalid value.' });
    return;
  }
  const preferences = saveUserPreferences(user.id, parsed.data, Date.now());
  res.json({ preferences });
});

app.get('/api/repositories/:id/progress', requireAuth, (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const repositoryId = String(req.params.id);
  const repository = getRepositoryRecord(repositoryId, user.id);
  if (!repository) {
    res.status(404).json({ error: 'Repository not found.' });
    return;
  }
  const exploredItems = listExploredItems(user.id, repositoryId);
  const tourProgress = listTourProgress(user.id, repositoryId);
  const analysis = getAnalyzedRepo(repositoryId, user.id);
  const totalTourSteps = repository.overview?.walkthrough.length ?? 0;
  res.json({
    exploredItems,
    tourProgress,
    exploredCount: exploredItems.length,
    totalFiles: analysis?.analysis.filesMeta.length ?? 0,
    completedTourCount: tourProgress.filter((step) => step.tourId === 'overview').length,
    totalTourSteps,
  });
});

app.post('/api/repositories/:id/progress/explored', requireAuth, (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const repositoryId = String(req.params.id);
  const data = getAnalyzedRepo(repositoryId, user.id);
  const nodeId = typeof req.body?.nodeId === 'string' ? req.body.nodeId : '';
  if (!data || !nodeId.startsWith('file:') || nodeId.length > 520) {
    res.status(400).json({ error: 'Invalid explored file.' });
    return;
  }
  const filePath = nodeId.slice('file:'.length);
  if (!data.analysis.filesMeta.some((file) => file.path === filePath)) {
    res.status(404).json({ error: 'File not found in this repository.' });
    return;
  }
  markExploredItem(user.id, repositoryId, nodeId, Date.now());
  res.json({ ok: true });
});

app.post('/api/repositories/:id/progress/tours', requireAuth, (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const repositoryId = String(req.params.id);
  const repository = getRepositoryRecord(repositoryId, user.id);
  const { tourId, stepIndex } = req.body ?? {};
  const steps = repository?.overview?.walkthrough ?? [];
  if (
    !repository ||
    tourId !== 'overview' ||
    !Number.isInteger(stepIndex) ||
    stepIndex < 0 ||
    stepIndex >= steps.length
  ) {
    res.status(400).json({ error: 'Invalid walkthrough step.' });
    return;
  }
  completeTourStep(user.id, repositoryId, tourId, stepIndex, Date.now());
  res.json({ ok: true });
});

app.post('/api/chats', requireAuth, (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const repositoryId = typeof req.body?.repositoryId === 'string' ? req.body.repositoryId.trim() : '';
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : 'New chat';
  if (!repositoryId || repositoryId.length > 200 || !title || title.length > 100) {
    res.status(400).json({ error: 'Enter a valid repository and chat title.' });
    return;
  }
  if (!getRepositoryRecord(repositoryId, user.id)) {
    res.status(404).json({ error: 'Repository not found.' });
    return;
  }
  const chat = createChat({
    id: crypto.randomUUID(),
    userId: user.id,
    repositoryId,
    title,
    now: Date.now(),
  });
  res.status(201).json({ chat });
});

app.get('/api/repositories/:id/chats', requireAuth, (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const repositoryId = String(req.params.id);
  if (!getRepositoryRecord(repositoryId, user.id)) {
    res.status(404).json({ error: 'Repository not found.' });
    return;
  }
  res.json({ chats: listChatsForRepository(user.id, repositoryId) });
});

app.get('/api/chats/:chatId/messages', requireAuth, (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const chatId = String(req.params.chatId);
  if (!getChat(user.id, chatId)) {
    res.status(404).json({ error: 'Chat not found.' });
    return;
  }
  const limit = Number(req.query.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    res.status(400).json({ error: 'Message page size must be between 1 and 50.' });
    return;
  }
  let before: { createdAt: number; id: string } | undefined;
  const beforeCreatedAt = req.query.beforeCreatedAt;
  const beforeId = req.query.beforeId;
  if (beforeCreatedAt !== undefined || beforeId !== undefined) {
    const createdAt = Number(beforeCreatedAt);
    if (
      !Number.isSafeInteger(createdAt) ||
      typeof beforeId !== 'string' ||
      beforeId.length < 1 ||
      beforeId.length > 100
    ) {
      res.status(400).json({ error: 'Invalid older-message cursor.' });
      return;
    }
    before = { createdAt, id: beforeId };
  }
  const page = getChatMessages(user.id, chatId, limit, before);
  res.json({
    messages: page.messages.map(serializeChatMessage),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  });
});

app.patch('/api/chats/:chatId', requireAuth, (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const chatId = String(req.params.chatId);
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title || title.length > 100) {
    res.status(400).json({ error: 'Chat title must be between 1 and 100 characters.' });
    return;
  }
  if (!renameChat(user.id, chatId, title, Date.now())) {
    res.status(404).json({ error: 'Chat not found.' });
    return;
  }
  res.json({ chat: getChat(user.id, chatId) });
});

app.delete('/api/chats/:chatId', requireAuth, (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  if (!deleteChat(user.id, String(req.params.chatId))) {
    res.status(404).json({ error: 'Chat not found.' });
    return;
  }
  res.json({ ok: true });
});

app.delete('/api/chats', requireAuth, (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  res.json({ deleted: clearChats(user.id) });
});

app.delete('/api/repositories/:id/chats', requireAuth, (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const repositoryId = String(req.params.id);
  if (!getRepositoryRecord(repositoryId, user.id)) {
    res.status(404).json({ error: 'Repository not found.' });
    return;
  }
  res.json({ deleted: clearChats(user.id, repositoryId) });
});

app.get('/api/chats/:chatId/export', requireAuth, (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const chatId = String(req.params.chatId);
  const chat = getChat(user.id, chatId);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found.' });
    return;
  }
  const messages = getAllChatMessages(user.id, chatId);
  if (!messages) {
    res.status(404).json({ error: 'Chat not found.' });
    return;
  }
  const format = req.query.format ?? 'json';
  if (format !== 'json' && format !== 'markdown') {
    res.status(400).json({ error: 'Export format must be json or markdown.' });
    return;
  }
  const safeTitle = chat.title.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'chat';
  const serializedMessages = messages.map(serializeChatMessage);
  const content =
    format === 'json'
      ? JSON.stringify({ chat, messages: serializedMessages }, null, 2)
      : [
          `# ${chat.title}`,
          '',
          `Repository: ${chat.repositoryId}`,
          '',
          ...serializedMessages.flatMap((message) => [
            `## ${message.role === 'user' ? 'You' : 'Codebase Tutor'}`,
            '',
            message.contextLabel ? `Context: ${message.contextLabel}` : '',
            message.content,
            ...(message.citations?.length
              ? ['', ...message.citations.map((citation) => `- ${citation.file_path}:${citation.start_line}-${citation.end_line}`)]
              : []),
            '',
          ]),
        ].join('\n');
  res.json({
    fileName: `${safeTitle}.${format === 'json' ? 'json' : 'md'}`,
    contentType: format === 'json' ? 'application/json' : 'text/markdown',
    content,
  });
});

app.post('/api/chats/:chatId/messages', requireAuth, async (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const chatId = String(req.params.chatId);
  const chat = getChat(user.id, chatId);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found.' });
    return;
  }
  const body = req.body as Record<string, unknown> | null;
  if (body && 'history' in body) {
    res.status(400).json({ error: 'Chat history is loaded by the server and must not be sent by the client.' });
    return;
  }
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  const contextLabel = typeof body?.contextLabel === 'string' ? body.contextLabel.trim() : '';
  const parsedContext = chatContextSchema.safeParse(body?.context ?? {});
  if (!question || question.length > 20000 || contextLabel.length > 500 || !parsedContext.success) {
    res.status(400).json({ error: 'Enter a valid question and chat context.' });
    return;
  }
  const data = getAnalyzedRepo(chat.repositoryId, user.id);
  if (!data) {
    res.status(404).json({ error: 'Repository is not analyzed yet. Wait for analysis to finish before asking questions.' });
    return;
  }

  const userGeminiKey = getUserApiKey(user.id, 'gemini');
  const apiKeyOverride = userGeminiKey ? decryptUserApiKey(userGeminiKey) : undefined;
  const modelOverride = userGeminiKey?.model ?? undefined;
  if (!reserveServerKeyRequest(user.id, Boolean(apiKeyOverride))) {
    res.status(429).json({ error: 'The server Gemini daily request limit has been reached. Try again tomorrow or use your own key.' });
    return;
  }

  const history = getChatPromptHistory(
    user.id,
    chatId,
    config.chatHistoryMaxMessages,
    config.chatHistoryMaxChars
  );
  const now = Date.now();
  const userMessage = saveChatMessage(user.id, chatId, {
    id: crypto.randomUUID(),
    role: 'user',
    content: question,
    contextLabel: contextLabel || undefined,
    createdAt: now,
  });
  if (!userMessage) {
    res.status(404).json({ error: 'Chat not found.' });
    return;
  }

  try {
    const result = await generateGroundedExplanation(
      data,
      question,
      parsedContext.data as ChatContext,
      history,
      { apiKeyOverride, modelOverride }
    );
    if (apiKeyOverride) {
      markUserApiKeyUsed(user.id, 'gemini', Date.now());
      if (result.modelUsed && result.modelUsed !== modelOverride) {
        updateUserApiKeyModel(user.id, 'gemini', result.modelUsed);
      }
    }
    const assistantMessage = saveChatMessage(user.id, chatId, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: result.answer,
      citations: result.citations,
      confidence: result.confidenceSummary,
      createdAt: Date.now(),
    });
    if (!assistantMessage) {
      res.status(409).json({ error: 'Chat was deleted before the answer could be saved.' });
      return;
    }
    res.json({
      answer: result.answer,
      citations: result.citations,
      confidenceSummary: result.confidenceSummary,
      modelUsed: result.modelUsed,
      userMessage: serializeChatMessage(userMessage),
      assistantMessage: serializeChatMessage(assistantMessage),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate explanation.';
    const status = message.includes('GEMINI_API_KEY') ? 503 : 500;
    res.status(status).json({ error: message });
  }
});

app.post('/api/tts', requireAuth, async (req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const { text } = req.body as { text?: string };
  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'Text is required for speech synthesis.' });
    return;
  }

  const userGeminiKey = getUserApiKey(user.id, 'gemini');
  const apiKeyOverride = userGeminiKey ? decryptUserApiKey(userGeminiKey) : undefined;
  if (!reserveServerKeyRequest(user.id, Boolean(apiKeyOverride))) {
    res.status(429).json({ error: 'The server Gemini daily request limit has been reached. Try again tomorrow or use your own key.' });
    return;
  }
  try {
    const audio = await generateSpeechAudio(text, { apiKeyOverride });
    if (apiKeyOverride) markUserApiKeyUsed(user.id, 'gemini', Date.now());
    res.json(audio);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to synthesize speech.';
    const status = message.includes('GEMINI_API_KEY') ? 503 : 500;
    res.status(status).json({ error: message });
  }
});

app.post('/api/cache/clear', requireAuth, (_req: Request, res: Response) => {
  const user = getRequestUser(res)!;
  const cleared = clearRepositoryCache(user.id);
  res.json({ cleared });
});

// Ensure unmatched /api routes ALWAYS return JSON (never fall through to SPA HTML)
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

// Express JSON error handler so body-parser or route errors on /api/* never emit HTML
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/') || req.path === '/api') {
    const status = typeof (err as { status?: number })?.status === 'number' ? (err as { status: number }).status : 500;
    const message = err instanceof Error ? err.message : 'Internal server error.';
    res.status(status).json({ error: message });
    return;
  }
  next(err);
});

  return app;
}
