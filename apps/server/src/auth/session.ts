import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const sessionBytes = 32;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const csrfPurpose = 'nbase:csrf:v1';
const sessionDays = 7;

export interface SessionTokens {
  token: string;
  tokenHash: Buffer;
  csrfToken: string;
  csrfHash: Buffer;
  expiresAt: Date;
}

export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-nbase_session' : 'nbase_session';
}

export function publicOriginConfig(value: string): { origin: string; secure: boolean } {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('NBASE_PUBLIC_ORIGIN must be an exact HTTP(S) origin without path or credentials');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('HTTP authentication is allowed only on the local loopback origin');
  }
  return { origin: url.origin, secure: url.protocol === 'https:' };
}

export function createSessionTokens(now = new Date()): SessionTokens {
  const bytes = randomBytes(sessionBytes);
  const token = bytes.toString('base64url');
  const csrfToken = createHmac('sha256', bytes).update(csrfPurpose).digest('base64url');
  return {
    token,
    tokenHash: createHash('sha256').update(bytes).digest(),
    csrfToken,
    csrfHash: createHash('sha256').update(csrfToken).digest(),
    expiresAt: new Date(now.getTime() + sessionDays * 24 * 60 * 60 * 1000),
  };
}

export function readSessionToken(cookieHeader: string | undefined, secure: boolean): string | null {
  if (!cookieHeader) return null;
  const name = sessionCookieName(secure);
  const matches = cookieHeader.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  if (!tokenPattern.test(value) || Buffer.from(value, 'base64url').length !== sessionBytes) return null;
  return value;
}

export function sessionTokenHash(token: string): Buffer {
  if (!tokenPattern.test(token)) throw new Error('Invalid session token');
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== sessionBytes || bytes.toString('base64url') !== token) throw new Error('Invalid session token');
  return createHash('sha256').update(bytes).digest();
}

export function csrfTokenForSession(token: string): string {
  return createHmac('sha256', Buffer.from(token, 'base64url')).update(csrfPurpose).digest('base64url');
}

export function verifyCsrf(storedHash: Buffer, submitted: string | undefined): boolean {
  if (!submitted || !tokenPattern.test(submitted) || storedHash.length !== 32) return false;
  const actualHash = createHash('sha256').update(submitted).digest();
  return timingSafeEqual(storedHash, actualHash);
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${sessionCookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDays * 24 * 60 * 60}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${sessionCookieName(secure)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}
