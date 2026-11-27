import crypto from 'node:crypto';
import { config } from './config.ts';

export interface EncryptedSecretFields {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export function parseEncryptionKey(value: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('Encryption key must be 32 bytes encoded as base64.');
  }
  return key;
}

export function getConfiguredEncryptionKey(): Buffer {
  if (!config.appEncryptionKey) {
    throw new Error('APP_ENCRYPTION_KEY must be configured to store encrypted credentials.');
  }
  return parseEncryptionKey(config.appEncryptionKey);
}

export function encryptSecretWithKey(value: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${authTag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecretWithKey(encryptedValue: string, key: Buffer): string {
  const [version, ivText, authTagText, ciphertextText, ...extra] = encryptedValue.split('.');
  if (version !== 'v1' || !ivText || !authTagText || !ciphertextText || extra.length > 0) {
    throw new Error('Stored credential has an invalid encrypted format.');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivText, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(authTagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptSecret(value: string): string {
  return encryptSecretWithKey(value, getConfiguredEncryptionKey());
}

export function decryptSecret(encryptedValue: string): string {
  return decryptSecretWithKey(encryptedValue, getConfiguredEncryptionKey());
}

export function encryptUserApiKey(
  value: string,
  key = getConfiguredEncryptionKey()
): EncryptedSecretFields {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: 1,
  };
}

export function decryptUserApiKey(
  record: EncryptedSecretFields,
  key = getConfiguredEncryptionKey()
): string {
  if (record.keyVersion !== 1) {
    throw new Error('Stored API key uses an unsupported encryption version.');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(record.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
