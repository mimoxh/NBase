import { createHash, randomBytes } from 'node:crypto';
import type { OAuthFlowError } from '@nbase/contracts';
import { CalDavError } from '../caldav/client.js';
import type { BearerAuth, HttpTransport } from '../remote.js';

/** Why an authorization flow failed; recorded on the flow and shown on the Google callback page. */
export class OAuthFlowFailure extends Error {
  constructor(public readonly code: OAuthFlowError, public readonly detail: Readonly<Record<string, string>> = {}) { super(code); }
}

/** What a token endpoint answers on success. `expiresIn` is in seconds. */
export interface TokenGrant {
  accessToken: string;
  expiresIn: number;
  refreshToken: string | null;
  idToken: string | null;
  scope: string | null;
}

/** The account a grant belongs to: `subject` is the provider's stable id, `account` the e-mail when known. */
export interface OAuthIdentity { subject: string; account: string | null }

/** Sealed in a source's credential_cipher and in a ready flow's token_cipher. */
export interface StoredTokens { refreshToken: string; subject: string }

export function isStoredTokens(value: unknown): value is StoredTokens {
  if (typeof value !== 'object' || value === null) return false;
  const { refreshToken, subject } = value as Record<string, unknown>;
  return typeof refreshToken === 'string' && refreshToken.length > 0 && typeof subject === 'string' && subject.length > 0;
}

export interface FormAnswer { status: number; data: Record<string, unknown> | null }

/** POSTs a form to a token endpoint. A network failure is CalDavError('FETCH_FAILED'); answers of any status are returned. */
export async function postForm(transport: HttpTransport, url: string, form: Record<string, string>): Promise<FormAnswer> {
  let response;
  try {
    response = await transport({ method: 'POST', url: new URL(url), followRedirects: false, body: new URLSearchParams(form).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'NBase-Calendar/1.0' } });
  } catch { throw new CalDavError('FETCH_FAILED'); }
  return { status: response.status, data: jsonObject(response.body) };
}

export function jsonObject(body: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function errorOf(answer: FormAnswer): string | null {
  const error = answer.data?.error;
  return typeof error === 'string' ? error : null;
}

/** A successful token answer, or null when it lacks an access token. */
export function tokenGrant(data: Record<string, unknown> | null): TokenGrant | null {
  if (!data || typeof data.access_token !== 'string' || !data.access_token) return null;
  const expires = Number(data.expires_in);
  return {
    accessToken: data.access_token,
    expiresIn: Number.isFinite(expires) && expires > 0 ? expires : 3600,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : null,
    idToken: typeof data.id_token === 'string' && data.id_token ? data.id_token : null,
    scope: typeof data.scope === 'string' ? data.scope : null,
  };
}

/**
 * Claims of an id_token. The token comes straight from the provider's token endpoint over TLS, so the
 * signature is not checked (OpenID Connect Core 3.1.3.7); callers check the audience and issuer.
 */
export function idTokenClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function audienceIncludes(claims: Record<string, unknown>, clientId: string): boolean {
  const aud = claims.aud;
  return aud === clientId || (Array.isArray(aud) && aud.includes(clientId));
}

/** 32 random bytes as base64url: OAuth state, PKCE verifiers and the browser binding cookie. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** PKCE with S256 (RFC 7636). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken();
  return { verifier, challenge: sha256(verifier).toString('base64url') };
}

/** One access token without a way to renew it, for requests made while a flow completes. */
export function staticAuth(token: string): BearerAuth {
  return { token: async () => token, renew: async () => token };
}

/** Account e-mails and ids are shown and stored; control characters and overlong values are not. */
export function cleanClaim(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, '').trim();
  return text && text.length <= max ? text : null;
}
