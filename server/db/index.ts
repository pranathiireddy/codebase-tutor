import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.ts';

export interface StoredUser {
  id: string;
  name: string;
  email: string;
  role: string;
  salt: string;
  passwordHash: string;
}

let database: Database.Database | undefined;

function getDatabase(): Database.Database {
  if (database) return database;
  if (config.databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true });
  }
  database = new Database(config.databasePath);
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS public_repository_owners (
      repository_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS public_repository_owners_user_id_idx
      ON public_repository_owners(user_id);
    CREATE TABLE IF NOT EXISTS gemini_daily_usage (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      utc_date TEXT NOT NULL,
      request_count INTEGER NOT NULL CHECK (request_count >= 0),
      PRIMARY KEY (user_id, utc_date)
    );
  `);
  return database;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function toStoredUser(row: Record<string, unknown> | undefined): StoredUser | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    role: String(row.role),
    salt: String(row.salt),
    passwordHash: String(row.password_hash),
  };
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
    .prepare('SELECT id, name, email, role, salt, password_hash FROM users WHERE email = ?')
    .get(email) as Record<string, unknown> | undefined;
  return toStoredUser(row);
}

export function insertUser(user: StoredUser): boolean {
  try {
    getDatabase()
      .prepare(
        'INSERT INTO users (id, name, email, role, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(user.id, user.name, user.email, user.role, user.salt, user.passwordHash, new Date().toISOString());
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: users.email')) {
      return false;
    }
    throw error;
  }
}

export function createSession(token: string, userId: string, expiresAt: number): void {
  getDatabase()
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, expiresAt, new Date().toISOString());
}

export function getSessionUser(token: string): Omit<StoredUser, 'salt' | 'passwordHash'> | undefined {
  const tokenHash = hashToken(token);
  const row = getDatabase()
    .prepare(`
      SELECT users.id, users.name, users.email, users.role, sessions.expires_at
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
    `)
    .get(tokenHash) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  if (Number(row.expires_at) <= Date.now()) {
    getDatabase().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return undefined;
  }
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    role: String(row.role),
  };
}

export function deleteSession(token: string): void {
  getDatabase().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function removeExpiredSessions(now = Date.now()): void {
  getDatabase().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}

export function setPublicRepositoryOwner(repositoryId: string, userId: string): void {
  getDatabase()
    .prepare(`
      INSERT INTO public_repository_owners (repository_id, user_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET user_id = excluded.user_id
    `)
    .run(repositoryId, userId, new Date().toISOString());
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
