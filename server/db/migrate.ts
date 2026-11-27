import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const MIGRATION_FILE_RE = /^(\d+)_([a-z0-9_-]+)\.sql$/i;

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => MIGRATION_FILE_RE.test(name))
    .map((name) => {
      const match = MIGRATION_FILE_RE.exec(name);
      if (!match) throw new Error(`Invalid migration filename: ${name}`);
      return { name, version: Number(match[1]) };
    })
    .sort((a, b) => a.version - b.version);

  for (let index = 1; index < migrationFiles.length; index += 1) {
    if (migrationFiles[index - 1].version === migrationFiles[index].version) {
      throw new Error(`Duplicate database migration version: ${migrationFiles[index].version}`);
    }
  }

  const currentVersion = db
    .prepare('SELECT MAX(version) AS version FROM schema_version')
    .get() as { version: number | null };
  const latestAvailableVersion = migrationFiles.at(-1)?.version ?? 0;
  if ((currentVersion.version ?? 0) > latestAvailableVersion) {
    throw new Error('Database schema is newer than the available migrations.');
  }

  const hasMigration = db.prepare('SELECT 1 FROM schema_version WHERE version = ?');
  const recordMigration = db.prepare(
    'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)'
  );

  for (const migration of migrationFiles) {
    if (hasMigration.get(migration.version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, migration.name), 'utf8');
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      recordMigration.run(migration.version, Date.now());
    });
    applyMigration();
  }
}
