import type { OAuthProvider } from '@nbase/contracts';
import type { Pool } from 'pg';
import { openJson, sealJson, type CredentialKey } from '../../secrets/credentials.js';
import { CalDavError } from '../caldav/client.js';
import type { BearerAuth, HttpTransport } from '../remote.js';
import { isStoredTokens, type StoredTokens, type TokenGrant } from './common.js';
import { refreshGoogleToken, type GoogleApp } from './google.js';
import { refreshMicrosoftToken, type MicrosoftApp } from './microsoft.js';

export type OAuthApp = ({ provider: 'google' } & GoogleApp) | ({ provider: 'microsoft' } & MicrosoftApp);

/** Additional data of a sealed client secret: the workspace and provider it belongs to. */
export function appAad(workspaceId: string, provider: OAuthProvider): string {
  return `oauth-app:${workspaceId}:${provider}`;
}

/** The Google client secret, or null when it does not open with this key. */
export function openClientSecret(key: CredentialKey, workspaceId: string, cipher: Buffer | null, keyId: string | null): string | null {
  const secret = cipher ? openJson(key, appAad(workspaceId, 'google'), cipher, keyId) : null;
  return typeof secret === 'object' && secret !== null && typeof (secret as { clientSecret?: unknown }).clientSecret === 'string'
    ? (secret as { clientSecret: string }).clientSecret : null;
}

/** Null when the workspace has no app for the provider; CREDENTIALS_UNAVAILABLE when its secret does not open with this key. */
export async function loadOAuthApp(db: Pick<Pool, 'query'>, key: CredentialKey, workspaceId: string, provider: OAuthProvider): Promise<OAuthApp | null> {
  const result = await db.query<{ client_id: string; secret_cipher: Buffer | null; tenant: string | null; key_id: string | null }>(
    'SELECT client_id, secret_cipher, tenant, key_id FROM calendar_oauth_apps WHERE workspace_id = $1 AND provider = $2', [workspaceId, provider]);
  const row = result.rows[0];
  if (!row) return null;
  if (provider === 'microsoft') return { provider, clientId: row.client_id, tenant: row.tenant ?? 'common' };
  const clientSecret = openClientSecret(key, workspaceId, row.secret_cipher, row.key_id);
  if (clientSecret === null) throw new CalDavError('CREDENTIALS_UNAVAILABLE');
  return { provider, clientId: row.client_id, clientSecret };
}

export function sealTokens(key: CredentialKey, ownerId: string, tokens: StoredTokens): Buffer {
  return sealJson(key, ownerId, { refreshToken: tokens.refreshToken, subject: tokens.subject });
}

/** Null when the record does not open with this key and owner (a source id or a flow id). */
export function openTokens(key: CredentialKey, ownerId: string, record: Buffer, keyId: string | null): StoredTokens | null {
  const value = openJson(key, ownerId, record, keyId);
  return isStoredTokens(value) ? { refreshToken: value.refreshToken, subject: value.subject } : null;
}

export function refreshAccess(transport: HttpTransport, app: OAuthApp, refreshToken: string): Promise<TokenGrant> {
  return app.provider === 'google' ? refreshGoogleToken(transport, app, refreshToken) : refreshMicrosoftToken(transport, app, refreshToken);
}

export interface TokenSource { id: string; workspaceId: string; provider: OAuthProvider }

/** Access tokens are kept until this long before they expire. */
const marginMs = 60000;

/**
 * Access tokens of OAuth sources, in memory only. A refresh loads the workspace's app and the source's sealed
 * refresh token afresh; a refresh token the provider rotates is sealed and saved at once. Re-authorization,
 * app changes and source deletion drop the cached token (`invalidate`, `invalidateApp`).
 */
export class OAuthTokens {
  private readonly entries = new Map<string, { token: string; validUntil: number }>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly generations = new Map<string, number>();
  private readonly owners = new Map<string, { workspaceId: string; provider: OAuthProvider }>();

  constructor(private readonly now: () => number = Date.now) {}

  auth(pool: Pool, key: CredentialKey, transport: HttpTransport, source: TokenSource): BearerAuth {
    this.owners.set(source.id, { workspaceId: source.workspaceId, provider: source.provider });
    return { token: () => this.access(pool, key, transport, source, false), renew: () => this.access(pool, key, transport, source, true) };
  }

  /** Keeps the access token a completed authorization brought, so the next sync needs no refresh. */
  prime(source: TokenSource, grant: Pick<TokenGrant, 'accessToken' | 'expiresIn'>): void {
    this.invalidate(source.id);
    this.owners.set(source.id, { workspaceId: source.workspaceId, provider: source.provider });
    this.entries.set(source.id, { token: grant.accessToken, validUntil: this.now() + grant.expiresIn * 1000 - marginMs });
  }

  invalidate(sourceId: string): void {
    this.entries.delete(sourceId);
    this.pending.delete(sourceId);
    this.generations.set(sourceId, (this.generations.get(sourceId) ?? 0) + 1);
  }

  invalidateApp(workspaceId: string, provider: OAuthProvider): void {
    for (const [id, owner] of this.owners) if (owner.workspaceId === workspaceId && owner.provider === provider) this.invalidate(id);
  }

  private access(pool: Pool, key: CredentialKey, transport: HttpTransport, source: TokenSource, force: boolean): Promise<string> {
    const cached = this.entries.get(source.id);
    if (!force && cached && cached.validUntil > this.now()) return Promise.resolve(cached.token);
    const running = this.pending.get(source.id);
    if (running) return running;
    this.entries.delete(source.id);
    const generation = this.generations.get(source.id) ?? 0;
    const promise = this.refresh(pool, key, transport, source).then(grant => {
      // An invalidation meanwhile means the grant may belong to replaced credentials: use it once, do not keep it.
      if ((this.generations.get(source.id) ?? 0) === generation) {
        this.entries.set(source.id, { token: grant.accessToken, validUntil: this.now() + grant.expiresIn * 1000 - marginMs });
      }
      return grant.accessToken;
    }).finally(() => { if (this.pending.get(source.id) === promise) this.pending.delete(source.id); });
    this.pending.set(source.id, promise);
    return promise;
  }

  private async refresh(pool: Pool, key: CredentialKey, transport: HttpTransport, source: TokenSource): Promise<TokenGrant> {
    const app = await loadOAuthApp(pool, key, source.workspaceId, source.provider);
    if (!app) throw new CalDavError('OAUTH_APP_MISSING');
    const result = await pool.query<{ credential_cipher: Buffer | null; credential_key_id: string | null }>(
      'SELECT credential_cipher, credential_key_id FROM calendar_sync_sources WHERE id = $1', [source.id]);
    const cipher = result.rows[0]?.credential_cipher;
    const stored = cipher ? openTokens(key, source.id, cipher, result.rows[0]!.credential_key_id) : null;
    if (!cipher || !stored) throw new CalDavError('CREDENTIALS_UNAVAILABLE');
    const grant = await refreshAccess(transport, app, stored.refreshToken);
    if (grant.refreshToken && grant.refreshToken !== stored.refreshToken) {
      // Compared with the record read above, so a re-authorization saved meanwhile is not overwritten.
      await pool.query(`UPDATE calendar_sync_sources SET credential_cipher = $2, credential_key_id = $3, updated_at = now()
        WHERE id = $1 AND credential_cipher = $4`,
      [source.id, sealTokens(key, source.id, { refreshToken: grant.refreshToken, subject: stored.subject }), key.id, cipher]);
    }
    return grant;
  }
}

/** The tokens of this process; routes and the scheduler share them. */
export const oauthTokens = new OAuthTokens();
