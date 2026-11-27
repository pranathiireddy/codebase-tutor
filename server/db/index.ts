import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.ts';
import { redactSecrets } from '../redaction.ts';
import { runMigrations } from './migrate.ts';
import type { DiagramType } from '../../src/types/codebase.ts';

export interface StoredUser {
  id: string;
  email: string;
  name: string;
  role: string;
  emailVerifiedAt: number | null;
  passwordHash: string | null;
  createdAt: number;
  updatedAt: number;
  failedLogins: number;
  lockedUntil: number | null;
  deletedAt: number | null;
}

export interface OAuthAccountRecord {
  id: string;
  userId: string;
  provider: 'github';
  providerUserId: string;
  providerLogin: string;
  avatarUrl: string | null;
  createdAt: number;
  lastLoginAt: number;
}

export interface OAuthStateRecord {
  stateHash: string;
  codeVerifierEnc: string | null;
  purpose: 'login' | 'link' | 'private_install';
  userId: string | null;
  redirectAfter: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export interface GithubAppInstallationRecord {
  userId: string;
  installationId: string;
  accountLogin: string;
  accessTokenEnc: string;
  tokenExpiresAt: number;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export type UserApiKeyProvider = 'gemini' | 'github' | 'github_owner';

export interface UserApiKeyRecord {
  id: string;
  userId: string;
  provider: UserApiKeyProvider;
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
  last4: string;
  model: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface UserApiKeyMetadata {
  provider: UserApiKeyProvider;
  last4: string;
  model: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface SessionRecord {
  idHash: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  revokedAt: number | null;
}

export interface AuthenticatedSession {
  session: SessionRecord;
  user: Pick<StoredUser, 'id' | 'email' | 'name' | 'role'>;
}

export interface NewSession {
  idHash: string;
  userId: string;
  now: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

export interface ChatRecord {
  id: string;
  userId: string;
  repositoryId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessageRecord {
  id: string;
  chatId: string;
  role: 'user' | 'assistant';
  content: string;
  contextLabel: string | null;
  citationsJson: string | null;
  confidenceJson: string | null;
  createdAt: number;
}

export interface UserPreferencesRecord {
  userId: string;
  editorFontSize: number;
  defaultDiagramType: DiagramType;
  showMinimap: boolean;
  chatRetentionDays: number;
  updatedAt: number;
}

export interface TourProgressRecord {
  tourId: string;
  stepIndex: number;
  completedAt: number;
}

export interface NewChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  contextLabel?: string;
  citations?: unknown;
  confidence?: unknown;
  createdAt: number;
}

export interface MessageCursor {
  createdAt: number;
  id: string;
}

let chatRetentionTimer: NodeJS.Timeout | undefined;
let database: Database.Database | undefined;

function getDatabase(): Database.Database {
  if (database) return database;
  if (config.databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true });
  }
  database = new Database(config.databasePath);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  runMigrations(database);
  return database;
}

function toStoredUser(row: Record<string, unknown> | undefined): StoredUser | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    role: String(row.role),
    emailVerifiedAt: row.email_verified_at == null ? null : Number(row.email_verified_at),
    passwordHash: row.password_hash == null ? null : String(row.password_hash),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    failedLogins: Number(row.failed_logins),
    lockedUntil: row.locked_until == null ? null : Number(row.locked_until),
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
  };
}

function toSessionRecord(row: Record<string, unknown>): SessionRecord {
  return {
    idHash: String(row.id_hash),
    userId: String(row.user_id),
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    expiresAt: Number(row.expires_at),
    ip: row.ip == null ? null : String(row.ip),
    userAgent: row.user_agent == null ? null : String(row.user_agent),
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
  };
}

function insertSession(db: Database.Database, session: NewSession): void {
  db.prepare(`
    INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.idHash,
    session.userId,
    session.now,
    session.now,
    session.expiresAt,
    session.ip,
    session.userAgent
  );
}

export function initializeDatabase(): void {
  getDatabase();
}

export function closeDatabase(): void {
  database?.close();
  database = undefined;
}

export function findUserByEmail(email: string): StoredUser | undefined {
  const row = getDatabase()
    .prepare(`
      SELECT id, email, name, role, email_verified_at, password_hash, created_at, updated_at,
             failed_logins, locked_until, deleted_at
      FROM users
      WHERE email = ? AND deleted_at IS NULL
    `)
    .get(email.trim().toLowerCase()) as Record<string, unknown> | undefined;
  return toStoredUser(row);
}

export function findUserById(userId: string): StoredUser | undefined {
  const row = getDatabase()
    .prepare(`
      SELECT id, email, name, role, email_verified_at, password_hash, created_at, updated_at,
             failed_logins, locked_until, deleted_at
      FROM users
      WHERE id = ? AND deleted_at IS NULL
    `)
    .get(userId) as Record<string, unknown> | undefined;
  return toStoredUser(row);
}

export function insertUser(user: Pick<StoredUser, 'id' | 'email' | 'name' | 'role' | 'passwordHash'>): boolean {
  const now = Date.now();
  try {
    getDatabase()
      .prepare(`
        INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(user.id, user.email.trim().toLowerCase(), user.name.trim(), user.role, user.passwordHash, now, now);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: users.email')) {
      return false;
    }
    throw error;
  }
}

function toOAuthAccountRecord(row: Record<string, unknown> | undefined): OAuthAccountRecord | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    provider: 'github',
    providerUserId: String(row.provider_user_id),
    providerLogin: String(row.provider_login),
    avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
    createdAt: Number(row.created_at),
    lastLoginAt: Number(row.last_login_at),
  };
}

function toOAuthStateRecord(row: Record<string, unknown> | undefined): OAuthStateRecord | undefined {
  if (!row) return undefined;
  return {
    stateHash: String(row.state_hash),
    codeVerifierEnc: row.code_verifier_enc == null ? null : String(row.code_verifier_enc),
    purpose: String(row.purpose) as OAuthStateRecord['purpose'],
    userId: row.user_id == null ? null : String(row.user_id),
    redirectAfter: String(row.redirect_after),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    usedAt: row.used_at == null ? null : Number(row.used_at),
  };
}

function toGithubAppInstallationRecord(
  row: Record<string, unknown> | undefined
): GithubAppInstallationRecord | undefined {
  if (!row) return undefined;
  return {
    userId: String(row.user_id),
    installationId: String(row.installation_id),
    accountLogin: String(row.account_login),
    accessTokenEnc: String(row.access_token_enc),
    tokenExpiresAt: Number(row.token_expires_at),
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
  };
}

export function createOAuthUser(
  user: { id: string; email: string; name: string; role: string; emailVerifiedAt: number },
  account: {
    id: string;
    providerUserId: string;
    providerLogin: string;
    avatarUrl: string | null;
    now: number;
  }
): 'created' | 'email_exists' | 'oauth_account_exists' {
  const db = getDatabase();
  const create = db.transaction(() => {
    const now = account.now;
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO users (
        id, email, name, role, email_verified_at, password_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      user.id,
      user.email.trim().toLowerCase(),
      user.name.trim(),
      user.role,
      user.emailVerifiedAt,
      now,
      now
    );
    if (inserted.changes === 0) return 'email_exists' as const;
    db.prepare(`
      INSERT INTO oauth_accounts (
        id, user_id, provider, provider_user_id, provider_login, avatar_url, created_at, last_login_at
      ) VALUES (?, ?, 'github', ?, ?, ?, ?, ?)
    `).run(
      account.id,
      user.id,
      account.providerUserId,
      account.providerLogin,
      account.avatarUrl,
      now,
      now
    );
    return 'created' as const;
  });
  try {
    return create();
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: oauth_accounts.')) {
      return 'oauth_account_exists';
    }
    throw error;
  }
}

export function findOAuthAccount(providerUserId: string): {
  account: OAuthAccountRecord;
  user: StoredUser;
} | undefined {
  const row = getDatabase().prepare(`
    SELECT oauth_accounts.id AS oauth_id,
           oauth_accounts.user_id AS oauth_user_id,
           oauth_accounts.provider_user_id,
           oauth_accounts.provider_login,
           oauth_accounts.avatar_url,
           oauth_accounts.created_at AS oauth_created_at,
           oauth_accounts.last_login_at,
           users.email,
           users.name,
           users.role,
           users.email_verified_at,
           users.password_hash,
           users.created_at AS user_created_at,
           users.updated_at AS user_updated_at,
           users.failed_logins,
           users.locked_until,
           users.deleted_at
    FROM oauth_accounts
    JOIN users ON users.id = oauth_accounts.user_id
    WHERE oauth_accounts.provider = 'github'
      AND oauth_accounts.provider_user_id = ?
      AND users.deleted_at IS NULL
  `).get(providerUserId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const account = toOAuthAccountRecord({
    id: row.oauth_id,
    user_id: row.oauth_user_id,
    provider_user_id: row.provider_user_id,
    provider_login: row.provider_login,
    avatar_url: row.avatar_url,
    created_at: row.oauth_created_at,
    last_login_at: row.last_login_at,
  })!;
  const user = toStoredUser({
    id: row.oauth_user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    email_verified_at: row.email_verified_at,
    password_hash: row.password_hash,
    created_at: row.user_created_at,
    updated_at: row.user_updated_at,
    failed_logins: row.failed_logins,
    locked_until: row.locked_until,
    deleted_at: row.deleted_at,
  })!;
  return { account, user };
}

export function getOAuthAccountForUser(userId: string): OAuthAccountRecord | undefined {
  const row = getDatabase()
    .prepare("SELECT * FROM oauth_accounts WHERE user_id = ? AND provider = 'github'")
    .get(userId) as Record<string, unknown> | undefined;
  return toOAuthAccountRecord(row);
}

export function refreshOAuthAccount(
  providerUserId: string,
  providerLogin: string,
  avatarUrl: string | null,
  now: number
): void {
  getDatabase().prepare(`
    UPDATE oauth_accounts
    SET provider_login = ?, avatar_url = ?, last_login_at = ?
    WHERE provider = 'github' AND provider_user_id = ?
  `).run(providerLogin, avatarUrl, now, providerUserId);
}

export function linkOAuthAccount(account: {
  id: string;
  userId: string;
  providerUserId: string;
  providerLogin: string;
  avatarUrl: string | null;
  now: number;
}): boolean {
  try {
    getDatabase().prepare(`
      INSERT INTO oauth_accounts (
        id, user_id, provider, provider_user_id, provider_login, avatar_url, created_at, last_login_at
      ) VALUES (?, ?, 'github', ?, ?, ?, ?, ?)
    `).run(
      account.id,
      account.userId,
      account.providerUserId,
      account.providerLogin,
      account.avatarUrl,
      account.now,
      account.now
    );
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: oauth_accounts.')) {
      return false;
    }
    throw error;
  }
}

export function unlinkOAuthAccount(userId: string): boolean {
  return getDatabase()
    .prepare("DELETE FROM oauth_accounts WHERE user_id = ? AND provider = 'github'")
    .run(userId).changes > 0;
}

export function deleteUserAccount(userId: string): boolean {
  return getDatabase().prepare('DELETE FROM users WHERE id = ?').run(userId).changes > 0;
}

export function createOAuthState(state: OAuthStateRecord): void {
  getDatabase().prepare(`
    INSERT INTO oauth_states (
      state_hash, code_verifier_enc, purpose, user_id, redirect_after, created_at, expires_at, used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    state.stateHash,
    state.codeVerifierEnc,
    state.purpose,
    state.userId,
    state.redirectAfter,
    state.createdAt,
    state.expiresAt,
    state.usedAt
  );
}

export function consumeOAuthState(stateHash: string, now: number): OAuthStateRecord | undefined {
  const db = getDatabase();
  const consume = db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM oauth_states
      WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?
    `).get(stateHash, now) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const updated = db.prepare(`
      UPDATE oauth_states SET used_at = ?
      WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?
    `).run(now, stateHash, now);
    if (updated.changes !== 1) return undefined;
    return toOAuthStateRecord({ ...row, used_at: now });
  });
  return consume();
}

export function saveGithubAppInstallation(installation: GithubAppInstallationRecord): void {
  getDatabase().prepare(`
    INSERT INTO github_app_installations (
      user_id, installation_id, account_login, access_token_enc, token_expires_at,
      created_at, last_used_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(user_id, installation_id) DO UPDATE SET
      account_login = excluded.account_login,
      access_token_enc = excluded.access_token_enc,
      token_expires_at = excluded.token_expires_at,
      last_used_at = excluded.last_used_at,
      revoked_at = NULL
  `).run(
    installation.userId,
    installation.installationId,
    installation.accountLogin,
    installation.accessTokenEnc,
    installation.tokenExpiresAt,
    installation.createdAt,
    installation.lastUsedAt
  );
}

export function getGithubAppInstallation(
  userId: string,
  installationId: string
): GithubAppInstallationRecord | undefined {
  const row = getDatabase().prepare(`
    SELECT * FROM github_app_installations
    WHERE user_id = ? AND installation_id = ? AND revoked_at IS NULL
  `).get(userId, installationId) as Record<string, unknown> | undefined;
  return toGithubAppInstallationRecord(row);
}

export function listGithubAppInstallations(userId: string): GithubAppInstallationRecord[] {
  const rows = getDatabase().prepare(`
    SELECT * FROM github_app_installations
    WHERE user_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC
  `).all(userId) as Record<string, unknown>[];
  return rows.map((row) => toGithubAppInstallationRecord(row)!);
}

export function updateGithubAppInstallationToken(
  userId: string,
  installationId: string,
  accessTokenEnc: string,
  tokenExpiresAt: number,
  now: number
): boolean {
  return getDatabase().prepare(`
    UPDATE github_app_installations
    SET access_token_enc = ?, token_expires_at = ?, last_used_at = ?
    WHERE user_id = ? AND installation_id = ? AND revoked_at IS NULL
  `).run(accessTokenEnc, tokenExpiresAt, now, userId, installationId).changes > 0;
}

export function revokeGithubAppInstallation(userId: string, installationId: string, now: number): boolean {
  return getDatabase().prepare(`
    UPDATE github_app_installations SET revoked_at = ?, access_token_enc = ''
    WHERE user_id = ? AND installation_id = ? AND revoked_at IS NULL
  `).run(now, userId, installationId).changes > 0;
}

function toUserApiKeyRecord(row: Record<string, unknown> | undefined): UserApiKeyRecord | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    provider: String(row.provider) as UserApiKeyProvider,
    ciphertext: String(row.ciphertext),
    iv: String(row.iv),
    authTag: String(row.auth_tag),
    keyVersion: Number(row.key_version),
    last4: String(row.last4),
    model: row.model == null ? null : String(row.model),
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
  };
}

export function saveUserApiKey(
  key: Pick<
    UserApiKeyRecord,
    'id' | 'userId' | 'provider' | 'ciphertext' | 'iv' | 'authTag' | 'keyVersion' | 'last4' | 'model'
  >,
  now: number
): void {
  getDatabase().prepare(`
    INSERT INTO user_api_keys (
      id, user_id, provider, ciphertext, iv, auth_tag, key_version, last4, model, created_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      auth_tag = excluded.auth_tag,
      key_version = excluded.key_version,
      last4 = excluded.last4,
      model = excluded.model
  `).run(
    key.id,
    key.userId,
    key.provider,
    key.ciphertext,
    key.iv,
    key.authTag,
    key.keyVersion,
    key.last4,
    key.model,
    now
  );
}

export function getUserApiKey(userId: string, provider: UserApiKeyProvider): UserApiKeyRecord | undefined {
  const row = getDatabase()
    .prepare('SELECT * FROM user_api_keys WHERE user_id = ? AND provider = ?')
    .get(userId, provider) as Record<string, unknown> | undefined;
  return toUserApiKeyRecord(row);
}

export function listUserApiKeys(userId: string): UserApiKeyMetadata[] {
  const rows = getDatabase()
    .prepare(`
      SELECT provider, last4, model, created_at, last_used_at
      FROM user_api_keys
      WHERE user_id = ?
      ORDER BY provider
    `)
    .all(userId) as Record<string, unknown>[];
  return rows.map((row) => ({
    provider: String(row.provider) as UserApiKeyProvider,
    last4: String(row.last4),
    model: row.model == null ? null : String(row.model),
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
  }));
}

export function markUserApiKeyUsed(userId: string, provider: UserApiKeyProvider, now: number): void {
  getDatabase()
    .prepare('UPDATE user_api_keys SET last_used_at = ? WHERE user_id = ? AND provider = ?')
    .run(now, userId, provider);
}

export function updateUserApiKeyModel(
  userId: string,
  provider: UserApiKeyProvider,
  model: string
): void {
  getDatabase()
    .prepare('UPDATE user_api_keys SET model = ? WHERE user_id = ? AND provider = ?')
    .run(model, userId, provider);
}

export function deleteUserApiKey(userId: string, provider: UserApiKeyProvider): boolean {
  return getDatabase()
    .prepare('DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?')
    .run(userId, provider).changes > 0;
}

export function recordFailedLogin(
  userId: string,
  now: number,
  maximumFailures: number,
  lockDurationMs: number
): { failedLogins: number; lockedUntil: number | null } {
  const db = getDatabase();
  db.prepare(`
    UPDATE users
    SET failed_logins = failed_logins + 1,
        locked_until = CASE
          WHEN failed_logins + 1 >= ? THEN ?
          ELSE locked_until
        END,
        updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `).run(maximumFailures, now + lockDurationMs, now, userId);
  const row = db
    .prepare('SELECT failed_logins, locked_until FROM users WHERE id = ?')
    .get(userId) as { failed_logins: number; locked_until: number | null } | undefined;
  return {
    failedLogins: row?.failed_logins ?? 0,
    lockedUntil: row?.locked_until ?? null,
  };
}

export function clearFailedLogins(userId: string, now: number): void {
  getDatabase()
    .prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
    .run(now, userId);
}

export function createSession(session: NewSession): void {
  insertSession(getDatabase(), session);
}

export function findSessionByHash(
  idHash: string,
  now: number,
  idleTimeoutMs: number
): AuthenticatedSession | undefined {
  const db = getDatabase();
  const row = db
    .prepare(`
      SELECT sessions.id_hash, sessions.user_id, sessions.created_at, sessions.last_seen_at,
             sessions.expires_at, sessions.ip, sessions.user_agent, sessions.revoked_at,
             users.id AS joined_user_id, users.email, users.name, users.role
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.id_hash = ?
        AND sessions.revoked_at IS NULL
        AND users.deleted_at IS NULL
    `)
    .get(idHash) as Record<string, unknown> | undefined;
  if (!row) return undefined;

  const session = toSessionRecord(row);
  if (session.expiresAt <= now || now - session.lastSeenAt >= idleTimeoutMs) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL')
      .run(now, idHash);
    return undefined;
  }

  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ? AND revoked_at IS NULL')
    .run(now, idHash);
  return {
    session: { ...session, lastSeenAt: now },
    user: {
      id: String(row.joined_user_id),
      email: String(row.email),
      name: String(row.name),
      role: String(row.role),
    },
  };
}

export function revokeSession(idHash: string, userId: string, now: number): boolean {
  const result = getDatabase()
    .prepare(`
      UPDATE sessions SET revoked_at = ?
      WHERE id_hash = ? AND user_id = ? AND revoked_at IS NULL
    `)
    .run(now, idHash, userId);
  return result.changes > 0;
}

export function revokeAllSessions(userId: string, now: number): void {
  getDatabase()
    .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(now, userId);
}

export function changePasswordAndRotateSession(
  userId: string,
  passwordHash: string,
  session: NewSession
): boolean {
  const db = getDatabase();
  const change = db.transaction(() => {
    const updated = db
      .prepare(`
        UPDATE users
        SET password_hash = ?, updated_at = ?, failed_logins = 0, locked_until = NULL
        WHERE id = ? AND deleted_at IS NULL
      `)
      .run(passwordHash, session.now, userId);
    if (updated.changes === 0) return false;
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(session.now, userId);
    insertSession(db, session);
    return true;
  });
  return change();
}

export function listActiveSessions(
  userId: string,
  now: number,
  idleTimeoutMs: number
): SessionRecord[] {
  const rows = getDatabase()
    .prepare(`
      SELECT id_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent, revoked_at
      FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at > ?
      ORDER BY last_seen_at DESC
    `)
    .all(userId, now, now - idleTimeoutMs) as Record<string, unknown>[];
  return rows.map(toSessionRecord);
}

export function removeExpiredSessions(now = Date.now(), idleTimeoutMs = 30 * 60 * 1000): void {
  getDatabase()
    .prepare(`
      UPDATE sessions SET revoked_at = ?
      WHERE revoked_at IS NULL AND (expires_at <= ? OR last_seen_at <= ?)
    `)
    .run(now, now, now - idleTimeoutMs);
}

export function recordAuditEvent(event: {
  id: string;
  userId?: string | null;
  event: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  detail?: Record<string, unknown>;
}): void {
  getDatabase()
    .prepare(`
      INSERT INTO audit_log (id, user_id, event, ip, user_agent, created_at, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      event.id,
      event.userId ?? null,
      event.event,
      event.ip,
      event.userAgent,
      event.createdAt,
      event.detail ? JSON.stringify(event.detail) : null
    );
}

function toChatRecord(row: Record<string, unknown> | undefined): ChatRecord | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    repositoryId: String(row.repository_id),
    title: String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toChatMessageRecord(row: Record<string, unknown>): ChatMessageRecord {
  return {
    id: String(row.id),
    chatId: String(row.chat_id),
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: String(row.content),
    contextLabel: row.context_label == null ? null : String(row.context_label),
    citationsJson: row.citations_json == null ? null : String(row.citations_json),
    confidenceJson: row.confidence_json == null ? null : String(row.confidence_json),
    createdAt: Number(row.created_at),
  };
}

function toUserPreferencesRecord(row: Record<string, unknown>): UserPreferencesRecord {
  return {
    userId: String(row.user_id),
    editorFontSize: Number(row.editor_font_size),
    defaultDiagramType: String(row.default_diagram_type) as DiagramType,
    showMinimap: Number(row.show_minimap) === 1,
    chatRetentionDays: Number(row.chat_retention_days),
    updatedAt: Number(row.updated_at),
  };
}

export function createChat(chat: {
  id: string;
  userId: string;
  repositoryId: string;
  title: string;
  now: number;
}): ChatRecord {
  getDatabase()
    .prepare(`
      INSERT INTO chats (id, user_id, repository_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(chat.id, chat.userId, chat.repositoryId, chat.title, chat.now, chat.now);
  return {
    ...chat,
    createdAt: chat.now,
    updatedAt: chat.now,
  };
}

export function getChat(userId: string, chatId: string): ChatRecord | undefined {
  const row = getDatabase()
    .prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?')
    .get(chatId, userId) as Record<string, unknown> | undefined;
  return toChatRecord(row);
}

export function listChatsForRepository(userId: string, repositoryId: string): ChatRecord[] {
  const rows = getDatabase()
    .prepare(`
      SELECT * FROM chats
      WHERE user_id = ? AND repository_id = ?
      ORDER BY updated_at DESC, id DESC
    `)
    .all(userId, repositoryId) as Record<string, unknown>[];
  return rows.map((row) => toChatRecord(row)!);
}

export function renameChat(userId: string, chatId: string, title: string, now: number): boolean {
  const result = getDatabase()
    .prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(title, now, chatId, userId);
  return result.changes > 0;
}

export function deleteChat(userId: string, chatId: string): boolean {
  const result = getDatabase()
    .prepare('DELETE FROM chats WHERE id = ? AND user_id = ?')
    .run(chatId, userId);
  return result.changes > 0;
}

export function clearChats(userId: string, repositoryId?: string): number {
  const result = repositoryId
    ? getDatabase()
        .prepare('DELETE FROM chats WHERE user_id = ? AND repository_id = ?')
        .run(userId, repositoryId)
    : getDatabase().prepare('DELETE FROM chats WHERE user_id = ?').run(userId);
  return result.changes;
}

export function saveChatMessage(
  userId: string,
  chatId: string,
  message: NewChatMessage
): ChatMessageRecord | undefined {
  const db = getDatabase();
  const save = db.transaction(() => {
    const inserted = db
      .prepare(`
        INSERT INTO messages (
          id, chat_id, role, content, context_label, citations_json, confidence_json, created_at
        )
        SELECT ?, chats.id, ?, ?, ?, ?, ?, ?
        FROM chats
        WHERE chats.id = ? AND chats.user_id = ?
      `)
      .run(
        message.id,
        message.role,
        message.content,
        message.contextLabel ?? null,
        message.citations === undefined ? null : JSON.stringify(message.citations),
        message.confidence === undefined ? null : JSON.stringify(message.confidence),
        message.createdAt,
        chatId,
        userId
      );
    if (inserted.changes === 0) return false;
    db.prepare(`
      UPDATE chats
      SET updated_at = ?,
          title = CASE
            WHEN title = 'New chat' AND ? = 'user' THEN substr(?, 1, 80)
            ELSE title
          END
      WHERE id = ? AND user_id = ?
    `).run(message.createdAt, message.role, message.content.trim(), chatId, userId);
    return true;
  });
  if (!save()) return undefined;
  return {
    id: message.id,
    chatId,
    role: message.role,
    content: message.content,
    contextLabel: message.contextLabel ?? null,
    citationsJson: message.citations === undefined ? null : JSON.stringify(message.citations),
    confidenceJson: message.confidence === undefined ? null : JSON.stringify(message.confidence),
    createdAt: message.createdAt,
  };
}

export function getChatMessages(
  userId: string,
  chatId: string,
  pageSize: number,
  before?: MessageCursor
): { messages: ChatMessageRecord[]; hasMore: boolean; nextCursor?: MessageCursor } {
  const db = getDatabase();
  const rows = (before
    ? db
        .prepare(`
          SELECT messages.*
          FROM messages
          JOIN chats ON chats.id = messages.chat_id
          WHERE chats.id = ? AND chats.user_id = ?
            AND (messages.created_at < ? OR (messages.created_at = ? AND messages.id < ?))
          ORDER BY messages.created_at DESC, messages.id DESC
          LIMIT ?
        `)
        .all(chatId, userId, before.createdAt, before.createdAt, before.id, pageSize + 1)
    : db
        .prepare(`
          SELECT messages.*
          FROM messages
          JOIN chats ON chats.id = messages.chat_id
          WHERE chats.id = ? AND chats.user_id = ?
          ORDER BY messages.created_at DESC, messages.id DESC
          LIMIT ?
        `)
        .all(chatId, userId, pageSize + 1)) as Record<string, unknown>[];
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize).map(toChatMessageRecord);
  page.reverse();
  const oldest = page[0];
  return {
    messages: page,
    hasMore,
    nextCursor: hasMore && oldest ? { createdAt: oldest.createdAt, id: oldest.id } : undefined,
  };
}

export function getAllChatMessages(userId: string, chatId: string): ChatMessageRecord[] | undefined {
  if (!getChat(userId, chatId)) return undefined;
  const rows = getDatabase()
    .prepare(`
      SELECT messages.*
      FROM messages
      JOIN chats ON chats.id = messages.chat_id
      WHERE chats.id = ? AND chats.user_id = ?
      ORDER BY messages.created_at ASC, messages.id ASC
    `)
    .all(chatId, userId) as Record<string, unknown>[];
  return rows.map(toChatMessageRecord);
}

export function getChatPromptHistory(
  userId: string,
  chatId: string,
  maxMessages: number,
  maxCharacters: number
): { role: 'user' | 'assistant'; content: string }[] {
  const rows = getDatabase()
    .prepare(`
      SELECT messages.role, messages.content
      FROM messages
      JOIN chats ON chats.id = messages.chat_id
      WHERE chats.id = ? AND chats.user_id = ?
      ORDER BY messages.created_at DESC, messages.id DESC
      LIMIT ?
    `)
    .all(chatId, userId, maxMessages) as { role: string; content: string }[];

  let remaining = maxCharacters;
  const recent: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const row of rows) {
    if (remaining <= 0) break;
    const content = row.content.slice(-remaining);
    recent.push({
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content,
    });
    remaining -= content.length;
  }
  return recent.reverse();
}

export function getUserPreferences(userId: string): UserPreferencesRecord {
  const db = getDatabase();
  db.prepare(`
    INSERT OR IGNORE INTO user_preferences (user_id, updated_at)
    VALUES (?, ?)
  `).run(userId, Date.now());
  const row = db
    .prepare('SELECT * FROM user_preferences WHERE user_id = ?')
    .get(userId) as Record<string, unknown>;
  return toUserPreferencesRecord(row);
}

export function saveUserPreferences(
  userId: string,
  preferences: Omit<UserPreferencesRecord, 'userId' | 'updatedAt'>,
  now: number
): UserPreferencesRecord {
  getDatabase()
    .prepare(`
      INSERT INTO user_preferences (
        user_id, editor_font_size, default_diagram_type, show_minimap, chat_retention_days, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        editor_font_size = excluded.editor_font_size,
        default_diagram_type = excluded.default_diagram_type,
        show_minimap = excluded.show_minimap,
        chat_retention_days = excluded.chat_retention_days,
        updated_at = excluded.updated_at
    `)
    .run(
      userId,
      preferences.editorFontSize,
      preferences.defaultDiagramType,
      preferences.showMinimap ? 1 : 0,
      preferences.chatRetentionDays,
      now
    );
  return { userId, ...preferences, updatedAt: now };
}

export function listExploredItems(userId: string, repositoryId: string): string[] {
  const rows = getDatabase()
    .prepare(`
      SELECT node_id FROM explored_items
      WHERE user_id = ? AND repository_id = ?
      ORDER BY visited_at DESC
    `)
    .all(userId, repositoryId) as { node_id: string }[];
  return rows.map((row) => row.node_id);
}

export function markExploredItem(
  userId: string,
  repositoryId: string,
  nodeId: string,
  visitedAt: number
): void {
  getDatabase()
    .prepare(`
      INSERT INTO explored_items (user_id, repository_id, node_id, visited_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, repository_id, node_id) DO UPDATE SET visited_at = excluded.visited_at
    `)
    .run(userId, repositoryId, nodeId, visitedAt);
}

export function listTourProgress(userId: string, repositoryId: string): TourProgressRecord[] {
  const rows = getDatabase()
    .prepare(`
      SELECT tour_id, step_index, completed_at FROM tour_progress
      WHERE user_id = ? AND repository_id = ?
      ORDER BY tour_id, step_index
    `)
    .all(userId, repositoryId) as { tour_id: string; step_index: number; completed_at: number }[];
  return rows.map((row) => ({
    tourId: row.tour_id,
    stepIndex: row.step_index,
    completedAt: row.completed_at,
  }));
}

export function completeTourStep(
  userId: string,
  repositoryId: string,
  tourId: string,
  stepIndex: number,
  completedAt: number
): void {
  getDatabase()
    .prepare(`
      INSERT INTO tour_progress (user_id, repository_id, tour_id, step_index, completed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, repository_id, tour_id, step_index)
      DO UPDATE SET completed_at = excluded.completed_at
    `)
    .run(userId, repositoryId, tourId, stepIndex, completedAt);
}

export function deleteExpiredChats(now = Date.now()): number {
  return getDatabase()
    .prepare(`
      DELETE FROM chats
      WHERE EXISTS (
        SELECT 1 FROM user_preferences
        WHERE user_preferences.user_id = chats.user_id
          AND user_preferences.chat_retention_days > 0
          AND chats.updated_at < ? - user_preferences.chat_retention_days * 86400000
      )
    `)
    .run(now)
    .changes;
}

export function startDailyChatRetentionCleanup(): void {
  if (chatRetentionTimer) return;
  deleteExpiredChats();
  chatRetentionTimer = setInterval(() => {
    try {
      deleteExpiredChats();
    } catch (error) {
      console.error(
        'Daily chat retention cleanup failed:',
        redactSecrets(error instanceof Error ? error.message : String(error))
      );
    }
  }, 24 * 60 * 60 * 1000);
  chatRetentionTimer.unref();
}

export function setPublicRepositoryOwner(repositoryId: string, userId: string): void {
  getDatabase()
    .prepare(`
      INSERT INTO public_repository_owners (repository_id, user_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET user_id = excluded.user_id
    `)
    .run(repositoryId, userId, Date.now());
}

export function getPublicRepositoryOwner(repositoryId: string): string | undefined {
  const row = getDatabase()
    .prepare('SELECT user_id FROM public_repository_owners WHERE repository_id = ?')
    .get(repositoryId) as { user_id?: string } | undefined;
  return row?.user_id;
}

export function listPublicRepositoryIds(userId: string): string[] {
  const rows = getDatabase()
    .prepare('SELECT repository_id FROM public_repository_owners WHERE user_id = ?')
    .all(userId) as { repository_id: string }[];
  return rows.map((row) => row.repository_id);
}

export function consumeGeminiDailyQuota(userId: string, utcDate: string, cap: number): boolean {
  const db = getDatabase();
  const consume = db.transaction(() => {
    const row = db
      .prepare('SELECT request_count FROM gemini_daily_usage WHERE user_id = ? AND utc_date = ?')
      .get(userId, utcDate) as { request_count?: number } | undefined;
    if ((row?.request_count ?? 0) >= cap) return false;
    db.prepare(`
      INSERT INTO gemini_daily_usage (user_id, utc_date, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(user_id, utc_date) DO UPDATE SET request_count = request_count + 1
    `).run(userId, utcDate);
    return true;
  });
  return consume();
}
