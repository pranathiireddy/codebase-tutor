import crypto from 'node:crypto';
import { config } from './config.ts';

function getEncryptionKey(): Buffer {
  if (!config.appEncryptionKey) {
    throw new Error('APP_ENCRYPTION_KEY must be configured to store encrypted GitHub credentials.');
  }
  return Buffer.from(config.appEncryptionKey, 'hex');
}

export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${authTag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(encryptedValue: string): string {
  const [version, ivText, authTagText, ciphertextText, ...extra] = encryptedValue.split('.');
  if (version !== 'v1' || !ivText || !authTagText || !ciphertextText || extra.length > 0) {
    throw new Error('Stored GitHub credential has an invalid encrypted format.');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(ivText, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(authTagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
