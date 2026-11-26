import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.ts';
import { runMigrations } from './migrate.ts';
import type { DiagramType } from '../../src/types/codebase.ts';

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
      console.error('Daily chat retention cleanup failed:', error);
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
