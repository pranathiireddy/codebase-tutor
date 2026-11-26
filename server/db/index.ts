import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.ts';
import { runMigrations } from './migrate.ts';

export interface StoredUser {
  id: string;
  email: string;
  name: string;
  role: string;
  emailVerifiedAt: number | null;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
  failedLogins: number;
  lockedUntil: number | null;
  deletedAt: number | null;
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
    passwordHash: String(row.password_hash),
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
