import { createHash, randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { DavRequest, DavResponse } from '../src/calendar/caldav/client.js';
import type { MockCalDav } from './caldav-mock.js';
import { MockGraph } from './msgraph-mock.js';

export const googleClient = { clientId: 'nbase-test.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-secret-value' };
export const msClientId = '11111111-2222-3333-4444-555555555555';

const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.`
  + `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const token = () => randomBytes(12).toString('hex');
const json = (status: number, body: unknown, url: URL): DavResponse =>
  ({ status, url, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) });

export interface Account { sub: string; email: string }

/**
 * Google's and Microsoft's endpoints in process: token endpoints, calendarList, Graph /me/calendars, Google's CalDAV
 * API forwarded to a MockCalDav that checks the bearer token, and the rest of Graph forwarded to a MockGraph.
 */
export class FakeProviders {
  googleSecret = googleClient.clientSecret;
  alice: Account = { sub: 'g-alice', email: 'alice@gmail.test' };
  readonly codes = new Map<string, { challenge: string; redirectUri: string; account: Account; scope: string }>();
  readonly refreshTokens = new Map<string, Account>();
  readonly access = new Set<string>();
  rotate = false;
  expiresIn = 3600;
  calendarApiDisabled = false;
  caldavDisabled = false;
  msRefused = false;
  msScript: string[] = [];
  readonly graph = new MockGraph();
  readonly counts = { refresh: 0, msToken: 0, msRefresh: 0, list: 0, unauthorized: 0 };

  constructor(readonly mock: MockCalDav) {
    mock.authorize = header => {
      const ok = !!header?.startsWith('Bearer ') && this.access.has(header.slice(7));
      if (!ok) this.counts.unauthorized++;
      return ok;
    };
  }

  /** What the browser does at Google: the user consents, Google redirects back with a code. */
  authorize(authorizeUrl: string, account: Account = this.alice, scope = 'openid https://www.googleapis.com/auth/calendar email'): string {
    const url = new URL(authorizeUrl);
    const code = token();
    this.codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirectUri: url.searchParams.get('redirect_uri')!, account, scope });
    return code;
  }

  private grant(account: Account, refresh: string | null, extra: Record<string, unknown> = {}) {
    const access = token();
    this.access.add(access);
    return { access_token: access, expires_in: this.expiresIn, token_type: 'Bearer', ...(refresh ? { refresh_token: refresh } : {}), ...extra };
  }

  transport = async (request: DavRequest): Promise<DavResponse> => {
    const url = request.url;
    const form = new URLSearchParams(request.body ?? '');
    const bearer = request.headers.Authorization?.startsWith('Bearer ') ? request.headers.Authorization.slice(7) : null;
    if (url.protocol !== 'https:') throw new Error(`unexpected ${url}`);
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token' && request.method === 'POST') {
      if (form.get('client_id') !== googleClient.clientId || form.get('client_secret') !== this.googleSecret) {
        return json(401, { error: 'invalid_client' }, url);
      }
      if (form.get('grant_type') === 'authorization_code') {
        const entry = this.codes.get(form.get('code') ?? '');
        this.codes.delete(form.get('code') ?? '');
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (!entry || entry.redirectUri !== form.get('redirect_uri') || entry.challenge !== challenge) return json(400, { error: 'invalid_grant' }, url);
        const refresh = token();
        this.refreshTokens.set(refresh, entry.account);
        return json(200, this.grant(entry.account, refresh, { scope: entry.scope, id_token: jwt({ iss: 'https://accounts.google.com',
          aud: googleClient.clientId, sub: entry.account.sub, email: entry.account.email }) }), url);
      }
      if (form.get('grant_type') === 'refresh_token') {
        this.counts.refresh++;
        const old = form.get('refresh_token') ?? '';
        const account = this.refreshTokens.get(old);
        if (!account) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, url);
        let next: string | null = null;
        if (this.rotate) { next = token(); this.refreshTokens.delete(old); this.refreshTokens.set(next, account); }
        return json(200, this.grant(account, next, { scope: 'https://www.googleapis.com/auth/calendar' }), url);
      }
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/calendar/v3/users/me/calendarList') {
      this.counts.list++;
      if (!bearer || !this.access.has(bearer)) return json(401, { error: { code: 401 } }, url);
      if (this.calendarApiDisabled) return json(403, { error: { code: 403, errors: [{ reason: 'accessNotConfigured' }] } }, url);
      return json(200, { items: [
        { id: 'alice@gmail.test', summary: 'alice@gmail.test', summaryOverride: 'Alice', backgroundColor: '#9FC6E7', accessRole: 'owner', primary: true },
        { id: 'zh.china#holiday@group.v.calendar.google.com', summary: '中国节假日', accessRole: 'reader' },
      ] }, url);
    }
    if (url.hostname === 'apidata.googleusercontent.com') {
      if (this.caldavDisabled) {
        return json(403, { error: { code: 403, message: 'CalDAV API has not been used in project 987654321 before or it is disabled.',
        details: [{ reason: 'SERVICE_DISABLED', metadata: { service: 'caldav.googleapis.com', consumer: 'projects/987654321' } }] } }, url);
      }
      const response = await fetch(new URL(url.pathname + url.search, this.mock.origin), { method: request.method, redirect: 'manual',
        headers: request.headers, ...(request.body !== undefined ? { body: request.body } : {}) });
      const headers: IncomingHttpHeaders = {};
      response.headers.forEach((value, name) => { headers[name] = value; });
      return { status: response.status, url, headers, body: Buffer.from(await response.arrayBuffer()) };
    }
    if (url.hostname === 'login.microsoftonline.com' && request.method === 'POST') {
      if (form.get('client_id') !== msClientId) return json(400, { error: 'unauthorized_client' }, url);
      if (url.pathname === '/common/oauth2/v2.0/devicecode') {
        if (this.msRefused) return json(400, { error: 'invalid_request', error_description: 'AADSTS7000218' }, url);
        return json(200, { device_code: token(), user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900,
          interval: 5, message: 'To sign in…' }, url);
      }
      if (url.pathname === '/common/oauth2/v2.0/token' && form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        this.counts.msToken++;
        const next = this.msScript.shift() ?? 'authorization_pending';
        if (next !== 'ready') return json(400, { error: next }, url);
        const bob = { sub: 'm-bob', email: 'bob@contoso.test' };
        const refresh = token();
        this.refreshTokens.set(refresh, bob);
        return json(200, this.grant(bob, refresh, { id_token: jwt({ aud: msClientId, oid: 'm-bob',
          sub: 'pairwise', preferred_username: 'bob@contoso.test' }) }), url);
      }
      if (url.pathname === '/common/oauth2/v2.0/token' && form.get('grant_type') === 'refresh_token') {
        // Microsoft hands out a new refresh token on every refresh.
        this.counts.msRefresh++;
        const old = form.get('refresh_token') ?? '';
        const account = this.refreshTokens.get(old);
        if (!account) return json(400, { error: 'invalid_grant' }, url);
        const next = token();
        this.refreshTokens.delete(old);
        this.refreshTokens.set(next, account);
        return json(200, this.grant(account, next), url);
      }
    }
    if (url.hostname === 'graph.microsoft.com') {
      if (!bearer || !this.access.has(bearer)) return json(401, { error: { code: 'InvalidAuthenticationToken' } }, url);
      if (url.pathname === '/v1.0/me/calendars') {
        return json(200, { value: [{ id: 'AAMkCal1', name: '日历', hexColor: '#ff8c00', canEdit: true },
          { id: 'AAMkCal2', name: '生日', hexColor: '', canEdit: false }] }, url);
      }
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== 'authorization'));
      return this.graph.transport({ ...request, headers: { ...headers, Authorization: `Bearer ${this.graph.token}` } });
    }
    throw new Error(`unexpected provider request ${request.method} ${url.hostname}${url.pathname}`);
  };
}
