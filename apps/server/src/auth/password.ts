import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const parameters = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const saltBytes = 32;
const keyBytes = 64;
export const minimumPasswordCharacters = 15;
const maximumPasswordBytes = 1024;

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyBytes, parameters, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (Array.from(password).length < minimumPasswordCharacters || Buffer.byteLength(password, 'utf8') > maximumPasswordBytes) {
    throw new Error(`Password must contain at least ${minimumPasswordCharacters} characters and at most ${maximumPasswordBytes} UTF-8 bytes`);
  }

  const salt = randomBytes(saltBytes);
  const key = await deriveKey(password, salt);
  return `scrypt:1:${parameters.N}:${parameters.r}:${parameters.p}:${salt.toString('base64url')}:${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (Buffer.byteLength(password, 'utf8') > maximumPasswordBytes) return false;
  const parts = encoded.split(':');
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== '1'
    || parts[2] !== String(parameters.N) || parts[3] !== String(parameters.r) || parts[4] !== String(parameters.p)) {
    return false;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(parts[5]!) || !/^[A-Za-z0-9_-]+$/.test(parts[6]!)) return false;

  const salt = Buffer.from(parts[5]!, 'base64url');
  const expected = Buffer.from(parts[6]!, 'base64url');
  if (salt.length !== saltBytes || expected.length !== keyBytes) return false;
  if (salt.toString('base64url') !== parts[5] || expected.toString('base64url') !== parts[6]) return false;
  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, expected);
}
