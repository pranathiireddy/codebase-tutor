import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../server/config.ts';
import { runMigrations } from '../server/db/migrate.ts';
import {
  decryptSecretWithKey,
  decryptUserApiKey,
  encryptSecretWithKey,
  encryptUserApiKey,
  getConfiguredEncryptionKey,
  parseEncryptionKey,
} from '../server/secretCrypto.ts';
import { redactSecrets } from '../server/redaction.ts';

function rotateEncryptedRecords(): void {
  const currentKey = getConfiguredEncryptionKey();
  const nextKeyValue = process.env.APP_ENCRYPTION_KEY_NEXT?.trim();
  if (!nextKeyValue) {
    throw new Error('Set APP_ENCRYPTION_KEY_NEXT to a new 32-byte base64 key before rotation.');
  }
  const nextKey = parseEncryptionKey(nextKeyValue);
  if (currentKey.equals(nextKey)) {
    throw new Error('The next encryption key must differ from the current key.');
  }

  if (config.databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true });
  }
  const db = new Database(config.databasePath);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const rotate = db.transaction(() => {
      const userKeys = db.prepare('SELECT id, ciphertext, iv, auth_tag, key_version FROM user_api_keys')
        .all() as Array<{
          id: string;
          ciphertext: string;
          iv: string;
          auth_tag: string;
          key_version: number;
        }>;
      const updateUserKey = db.prepare(`
        UPDATE user_api_keys SET ciphertext = ?, iv = ?, auth_tag = ?, key_version = ?
        WHERE id = ?
      `);
      for (const row of userKeys) {
        const plaintext = decryptUserApiKey(
          {
            ciphertext: row.ciphertext,
            iv: row.iv,
            authTag: row.auth_tag,
            keyVersion: row.key_version,
          },
          currentKey
        );
        const encrypted = encryptUserApiKey(plaintext, nextKey);
        updateUserKey.run(
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.keyVersion,
          row.id
        );
      }

      const encryptedSecrets = [
        {
          select: "SELECT user_id, installation_id, access_token_enc AS encrypted FROM github_app_installations WHERE access_token_enc != ''",
          update: 'UPDATE github_app_installations SET access_token_enc = ? WHERE user_id = ? AND installation_id = ?',
          keyColumns: ['user_id', 'installation_id'],
        },
        {
          select: 'SELECT state_hash, code_verifier_enc AS encrypted FROM oauth_states WHERE code_verifier_enc IS NOT NULL',
          update: 'UPDATE oauth_states SET code_verifier_enc = ? WHERE state_hash = ?',
          keyColumns: ['state_hash'],
        },
      ] as const;
      for (const table of encryptedSecrets) {
        const rows = db.prepare(table.select).all() as Array<Record<string, string>>;
        const update = db.prepare(table.update);
        for (const row of rows) {
          const plaintext = decryptSecretWithKey(row.encrypted, currentKey);
          update.run(
            encryptSecretWithKey(plaintext, nextKey),
            ...table.keyColumns.map((column) => row[column])
          );
        }
      }
    });

    rotate();
    console.log('Encrypted records rotated. Promote APP_ENCRYPTION_KEY_NEXT to APP_ENCRYPTION_KEY before restarting the app.');
  } finally {
    db.close();
  }
}

try {
  rotateEncryptedRecords();
} catch (error) {
  const message = redactSecrets(error instanceof Error ? error.message : 'Key rotation failed.');
  console.error(`Key rotation failed: ${message}`);
  process.exitCode = 1;
}
