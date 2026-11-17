import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { CalDavAccount } from '@nbase/contracts';
import { readSecretFile } from '../config.js';

/**
 * Encryption of stored account credentials (CalDAV). The key lives in a secret file outside the database
 * and outside backups; records carry the key's fingerprint, so a record sealed with another key is
 * recognised instead of failing to decrypt.
 *
 * Record layout: version (1 byte) | IV (12) | ciphertext | GCM tag (16). The additional data is the id of
 * the record owner, so a record copied to another source does not open.
 */
export interface CredentialKey {
  key: Buffer;
  /** First 8 bytes of SHA-256 of the key, as hex. */
  id: string;
}

const version = 1;
const ivLength = 12;
const tagLength = 16;

export function credentialKeyFromText(text: string): CredentialKey {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error('NBASE_CREDENTIAL_KEY_FILE must hold one line of base64');
  }
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== 32) throw new Error('NBASE_CREDENTIAL_KEY_FILE must decode to exactly 32 bytes');
  return { key, id: createHash('sha256').update(key).digest().subarray(0, 8).toString('hex') };
}

/**
 * Null when NBASE_CREDENTIAL_KEY_FILE is unset or names an empty file; an unreadable or malformed file is a
 * startup error. Compose mounts an empty placeholder when no key is configured, so older configurations start.
 */
export async function loadCredentialKey(env: NodeJS.ProcessEnv = process.env): Promise<CredentialKey | null> {
  const path = env.NBASE_CREDENTIAL_KEY_FILE;
  if (path === undefined || path === '') return null;
  let text: string;
  try {
    if ((await stat(path)).size === 0) return null;
    text = await readSecretFile(path);
  } catch (error) {
    throw new Error(`NBASE_CREDENTIAL_KEY_FILE cannot be read: ${(error as Error).message}`);
  }
  return credentialKeyFromText(text);
}

export function sealCredentials(key: CredentialKey, ownerId: string, account: CalDavAccount): Buffer {
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv('aes-256-gcm', key.key, iv, { authTagLength: tagLength });
  cipher.setAAD(Buffer.from(ownerId, 'utf8'));
  const plain = Buffer.from(JSON.stringify({ username: account.username, password: account.password }), 'utf8');
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([version]), iv, sealed, cipher.getAuthTag()]);
}

/** Null when the record was sealed with another key, for another owner, or is damaged. */
export function openCredentials(key: CredentialKey, ownerId: string, record: Buffer, keyId: string | null): CalDavAccount | null {
  if (keyId !== null && keyId !== key.id) return null;
  if (record.length < 1 + ivLength + tagLength + 1 || record[0] !== version) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, record.subarray(1, 1 + ivLength), { authTagLength: tagLength });
    decipher.setAAD(Buffer.from(ownerId, 'utf8'));
    decipher.setAuthTag(record.subarray(record.length - tagLength));
    const plain = Buffer.concat([decipher.update(record.subarray(1 + ivLength, record.length - tagLength)), decipher.final()]);
    const value: unknown = JSON.parse(plain.toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { username, password } = value as Record<string, unknown>;
    return typeof username === 'string' && typeof password === 'string' ? { username, password } : null;
  } catch { return null; }
}
