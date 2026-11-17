import { randomUUID, timingSafeEqual } from 'node:crypto';
import { googleOAuthCallbackPath, isCreateOAuthSourceRequest, isPutGoogleOAuthAppRequest, isPutMicrosoftOAuthAppRequest, isStartOAuthRequest,
  oauthProviders, type CalDavCalendarOption, type CalendarSyncSource, type CreateCalendarSourcesResponse, type OAuthAppsResponse, type OAuthFlowError, type OAuthFlowResponse,
  type OAuthProvider, type StartOAuthResponse } from '@nbase/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { WorkspaceRouteError } from '../../auth/workspace.js';
import { isUuid, PageError, type PgPageRepository } from '../../pages/repository.js';
import { openJson, sealJson, type CredentialKey } from '../../secrets/credentials.js';
import { CalDavError } from '../caldav/client.js';
import { graphBase, listGraphCalendars } from '../graph/adapter.js';
import type { HttpTransport } from '../remote.js';
import { CalendarRouteError, chosenCalendars, createSyncDatabase, insertSource, sourceColumns, sourceMutationId, toSyncSource, withWorkspaceLock,
  type CaldavConfig, type SourceRow, type SourceView } from '../sources.js';
import { OAuthFlowFailure, pkcePair, randomToken, sha256, staticAuth, type OAuthIdentity, type TokenGrant } from './common.js';
import { exchangeGoogleCode, googleAuthorizeUrl, googleServerUrl, listGoogleCalendars, probeGoogleCalDav } from './google.js';
import { pollDeviceToken, requestDeviceCode } from './microsoft.js';
import { appAad, loadOAuthApp, openClientSecret, openTokens, sealTokens, type OAuthApp, type OAuthTokens } from './tokens.js';

/** What the calendar routes share with the OAuth routes. */
export interface OAuthRouteContext {
  pool: Pool;
  pages: PgPageRepository;
  origin: string;
  secure: boolean;
  credentialKey: CredentialKey | null;
  fetchEnabled: boolean;
  transport: HttpTransport;
  tokens: OAuthTokens;
  view: SourceView;
  authorize: (request: FastifyRequest, workspaceId: string, write: boolean | 'post-read') => Promise<string>;
  fail: (request: FastifyRequest, reply: FastifyReply, error: unknown) => unknown;
  requireKey: () => CredentialKey;
  nudge: () => void;
  log: (message: string, details: Record<string, unknown>) => void;
}

interface WorkspaceParams { workspaceId: string }

interface FlowRow {
  id: string;
  workspace_id: string;
  user_id: string;
  provider: OAuthProvider;
  source_id: string | null;
  binding_hash: Buffer | null;
  secret_cipher: Buffer;
  token_cipher: Buffer | null;
  key_id: string;
  status: 'pending' | 'ready' | 'failed' | 'used';
  error: OAuthFlowError | null;
  account_json: { account: string | null; subject: string } | null;
  calendars_json: CalDavCalendarOption[] | null;
  expires_at: Date;
  /** expires_at has passed, by the database clock. */
  expired: boolean;
}

const flowColumns = `id, workspace_id, user_id, provider, source_id, binding_hash, secret_cipher, token_cipher, key_id, status, error,
  account_json, calendars_json, expires_at, expires_at <= now() AS expired`;
const flowMinutes = 15;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

/** The cookie that ties a Google authorization to the browser that started it; named like the session cookie. */
export function bindingCookieName(secure: boolean): string {
  return secure ? '__Host-nbase_oauth' : 'nbase_oauth';
}

export function readBindingCookie(cookieHeader: string | undefined, secure: boolean): string | null {
  if (!cookieHeader) return null;
  const name = bindingCookieName(secure);
  const matches = cookieHeader.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  return tokenPattern.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value ? value : null;
}

/**
 * Lax, unlike the Strict session cookie, so that the browser sends it on the redirect back from Google; it
 * carries no authority of its own and only proves that the callback reaches the browser that started the flow.
 */
export function bindingCookie(value: string, secure: boolean): string {
  return `${bindingCookieName(secure)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${flowMinutes * 60}${secure ? '; Secure' : ''}`;
}

function requestError(): never { throw new WorkspaceRouteError(400, 'INVALID_REQUEST'); }

const failureText: Record<OAuthFlowError, string> = {
  OAUTH_DENIED: '授权被拒绝，或没有授予访问日历的权限。请回到 NBase 重新连接，并在授权页勾选日历权限。',
  OAUTH_EXPIRED: '授权已过期。请回到 NBase 重新连接。',
  OAUTH_FAILED: 'Google 拒绝了这次授权。请检查 NBase 中填写的客户端 ID、客户端密钥和回调地址。',
  ACCOUNT_MISMATCH: '登录的 Google 账号与这个同步来源的账号不同。请用原来的账号重新授权。',
  FETCH_FAILED: '暂时无法连接 Google。请回到 NBase 稍后重试。',
  API_DISABLED: 'Google Cloud 项目没有启用 CalDAV API 或 Google Calendar API。已经启用的话，确认 NBase 中上传的客户端属于同一个项目；刚启用的话，等几分钟再回到 NBase 重新连接。',
};

const googleApiNames: Record<string, string> = { 'caldav.googleapis.com': 'CalDAV API', 'calendar-json.googleapis.com': 'Google Calendar API' };

function disabledText(detail: Readonly<Record<string, string>>): string {
  const api = detail.service ? googleApiNames[detail.service] : undefined;
  if (!api || !detail.project) return failureText.API_DISABLED;
  return `Google 报告：编号为 ${detail.project} 的 Google Cloud 项目没有启用 ${api}。请确认在这个项目里启用了它，并且 NBase 中上传的客户端也属于这个项目；刚启用的话，等几分钟再回到 NBase 重新连接。`;
}

function disabledDetail(error: unknown): Readonly<Record<string, string>> | undefined {
  return (error instanceof OAuthFlowFailure || error instanceof CalDavError) && error.code === 'API_DISABLED' ? error.detail : undefined;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The callback answers a small static page: no script, nothing loaded, no referrer for links. */
function sendPage(reply: FastifyReply, status: number, title: string, message: string) {
  return reply.code(status).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store')
    .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'").header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff')
    .send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
      + `<title>${escapeHtml(title)} - NBase</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:34rem;margin:15vh auto;`
      + `padding:0 1.5rem;color:#37352f}h1{font-size:1.25rem;font-weight:600}</style></head><body><h1>${escapeHtml(title)}</h1>`
      + `<p>${escapeHtml(message)}</p></body></html>`);
}

/** OAuth apps, authorization flows and OAuth sources under /api/workspaces/:id/calendar, and the Google callback. */
export function registerOAuthRoutes(app: FastifyInstance, ctx: OAuthRouteContext): void {
  const { pool, pages, view } = ctx;
  const base = '/api/workspaces/:workspaceId/calendar';
  const redirectUri = `${ctx.origin}${googleOAuthCallbackPath}`;

  /** Flows more than an hour past their expiry are dropped whenever an OAuth route is used. */
  const cleanup = () => pool.query(`DELETE FROM calendar_oauth_flows WHERE expires_at < now() - interval '1 hour'`);

  const readFlow = async (id: string): Promise<FlowRow | null> => {
    const result = await pool.query<FlowRow>(`SELECT ${flowColumns} FROM calendar_oauth_flows WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
  };

  const failFlow = async (id: string, code: OAuthFlowError): Promise<void> => {
    await pool.query(`UPDATE calendar_oauth_flows SET status = 'failed', error = $2, token_cipher = NULL, next_poll_at = NULL
      WHERE id = $1 AND status = 'pending'`, [id, code]);
  };

  const flowErrorCode = (error: unknown, provider: OAuthProvider): OAuthFlowError => {
    const disabled = disabledDetail(error);
    if (disabled) ctx.log('google api disabled', { provider, ...disabled });
    if (error instanceof OAuthFlowFailure) return error.code;
    if (error instanceof CalDavError) {
      if (error.code === 'API_DISABLED') return 'API_DISABLED';
      if (error.code === 'AUTH_FAILED') return 'OAUTH_FAILED';
      if (error.code === 'FETCH_FAILED') ctx.log('oauth request failed', { provider });
      return 'FETCH_FAILED';
    }
    ctx.log('oauth flow failed', { provider, err: error });
    return 'FETCH_FAILED';
  };

  const appsResponse = async (workspaceId: string, key: CredentialKey): Promise<OAuthAppsResponse> => {
    const result = await pool.query<{ provider: OAuthProvider; client_id: string; tenant: string | null; secret_cipher: Buffer | null;
      key_id: string | null }>('SELECT provider, client_id, tenant, secret_cipher, key_id FROM calendar_oauth_apps WHERE workspace_id = $1',
    [workspaceId]);
    const google = result.rows.find(row => row.provider === 'google');
    const microsoft = result.rows.find(row => row.provider === 'microsoft');
    const unreadable = !!google && openClientSecret(key, workspaceId, google.secret_cipher, google.key_id) === null;
    return { googleRedirectUri: redirectUri,
      google: google ? { clientId: google.client_id, ...(unreadable ? { secretUnavailable: true as const } : {}) } : null,
      microsoft: microsoft ? { clientId: microsoft.client_id, tenant: microsoft.tenant ?? 'common' } : null };
  };

  /**
   * Ends a flow with tokens. A new-source flow lists the account's calendars and keeps the sealed tokens; a
   * re-authorization replaces the source's tokens when the account is the same. Network calls happen before
   * the short transaction. Answers what Google said when listing failed because an API is disabled.
   */
  const completeFlow = async (flow: FlowRow, key: CredentialKey, oauthApp: OAuthApp, grant: TokenGrant & { refreshToken: string },
    identity: OAuthIdentity): Promise<Readonly<Record<string, string>> | undefined> => {
    const account = { account: identity.account, subject: identity.subject };
    if (!flow.source_id) {
      let calendars: CalDavCalendarOption[];
      try {
        if (oauthApp.provider === 'google') {
          const listed = await listGoogleCalendars(ctx.transport, staticAuth(grant.accessToken));
          calendars = listed.calendars;
          const probe = listed.primary ?? calendars[0]?.url;
          if (probe) await probeGoogleCalDav(ctx.transport, grant.accessToken, probe);
        } else {
          calendars = await listGraphCalendars({ transport: ctx.transport, auth: staticAuth(grant.accessToken) });
        }
      } catch (error) {
        await failFlow(flow.id, flowErrorCode(error, flow.provider));
        return disabledDetail(error);
      }
      await pool.query(`UPDATE calendar_oauth_flows SET status = 'ready', account_json = $2::jsonb, calendars_json = $3::jsonb,
          token_cipher = $4, key_id = $5, next_poll_at = NULL WHERE id = $1 AND status = 'pending'`,
      [flow.id, JSON.stringify(account), JSON.stringify(calendars), sealTokens(key, flow.id, { refreshToken: grant.refreshToken,
        subject: identity.subject }), key.id]);
      return;
    }
    const sourceId = flow.source_id;
    const client = await pool.connect();
    let replaced = false;
    try {
      await client.query('BEGIN');
      const found = await client.query<{ caldav_json: CaldavConfig | null }>(`SELECT caldav_json FROM calendar_sync_sources
        WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, [flow.workspace_id, sourceId]);
      const config = found.rows[0]?.caldav_json;
      if (!config || config.provider !== flow.provider || config.subject !== identity.subject) {
        await client.query(`UPDATE calendar_oauth_flows SET status = 'failed', error = 'ACCOUNT_MISMATCH', next_poll_at = NULL
          WHERE id = $1 AND status = 'pending'`, [flow.id]);
      } else {
        await client.query(`UPDATE calendar_sync_sources SET credential_cipher = $3, credential_key_id = $4,
            caldav_json = caldav_json || jsonb_build_object('account', COALESCE($5::text, caldav_json->>'account')),
            last_error = NULL, status = CASE WHEN status = 'error' THEN 'idle' ELSE status END, next_run_at = now(), updated_at = now()
          WHERE workspace_id = $1 AND id = $2`,
        [flow.workspace_id, sourceId, sealTokens(key, sourceId, { refreshToken: grant.refreshToken, subject: identity.subject }), key.id,
          identity.account]);
        const marked = await client.query(`UPDATE calendar_oauth_flows SET status = 'ready', account_json = $2::jsonb, next_poll_at = NULL
          WHERE id = $1 AND status = 'pending' RETURNING id`, [flow.id, JSON.stringify(account)]);
        replaced = marked.rows.length > 0;
        if (!replaced) throw new Error('flow finished meanwhile');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (!(error instanceof Error && error.message === 'flow finished meanwhile')) throw error;
      replaced = false;
    } finally { client.release(); }
    if (replaced) {
      ctx.tokens.prime({ id: sourceId, workspaceId: flow.workspace_id, provider: flow.provider }, grant);
      ctx.nudge();
    }
  };

  /** Asks Microsoft's token endpoint once; the caller has claimed this poll. */
  const pollMicrosoft = async (flow: FlowRow, key: CredentialKey): Promise<void> => {
    const secret = openJson(key, flow.id, flow.secret_cipher, flow.key_id) as { deviceCode?: unknown } | null;
    const oauthApp = await loadOAuthApp(pool, key, flow.workspace_id, 'microsoft').catch(() => null);
    if (typeof secret?.deviceCode !== 'string' || !oauthApp || oauthApp.provider !== 'microsoft') {
      await failFlow(flow.id, 'OAUTH_FAILED');
      return;
    }
    try {
      const result = await pollDeviceToken(ctx.transport, oauthApp, secret.deviceCode);
      if (result.status === 'slow_down') {
        await pool.query(`UPDATE calendar_oauth_flows SET poll_interval = LEAST(poll_interval + 5, 3600),
          next_poll_at = now() + LEAST(poll_interval + 5, 3600) * interval '1 second' WHERE id = $1 AND status = 'pending'`, [flow.id]);
      } else if (result.status === 'ready') {
        await completeFlow(flow, key, oauthApp, result.grant, result.identity);
      }
    } catch (error) { await failFlow(flow.id, flowErrorCode(error, 'microsoft')); }
  };

  const flowResponse = async (flow: FlowRow): Promise<OAuthFlowResponse> => {
    let source: CalendarSyncSource | null = null;
    if (flow.source_id && (flow.status === 'ready' || flow.status === 'used')) {
      const found = await pool.query<SourceRow>(`SELECT ${sourceColumns} FROM calendar_sync_sources s WHERE s.workspace_id = $1 AND s.id = $2`,
        [flow.workspace_id, flow.source_id]);
      source = found.rows[0] ? toSyncSource(found.rows[0], view) : null;
    }
    return { status: flow.status === 'used' ? 'ready' : flow.status, error: flow.error, account: flow.account_json?.account ?? null,
      calendars: flow.source_id ? [] : flow.calendars_json ?? [], source };
  };

  app.get<{ Params: WorkspaceParams }>(`${base}/oauth/apps`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      await ctx.authorize(request, workspaceId, false);
      // Without the key no app can be saved or used; saying so up front spares filling in the setup form.
      const key = ctx.credentialKey;
      if (!key) throw new CalendarRouteError(503, 'CREDENTIALS_UNAVAILABLE');
      await cleanup();
      return reply.send(await appsResponse(workspaceId, key));
    } catch (error) { return ctx.fail(request, reply, error); }
  });

  app.put<{ Params: WorkspaceParams & { provider: string } }>(`${base}/oauth/apps/:provider`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId, provider } = request.params;
      const actorId = await ctx.authorize(request, workspaceId, true);
      if (provider !== 'google' && provider !== 'microsoft') throw new PageError(404, 'NOT_FOUND');
      const body = request.body;
      if (provider === 'google' ? !isPutGoogleOAuthAppRequest(body) : !isPutMicrosoftOAuthAppRequest(body)) requestError();
      const key = ctx.requireKey();
      await cleanup();
      const google = provider === 'google' && isPutGoogleOAuthAppRequest(body) ? body : null;
      const microsoft = provider === 'microsoft' && isPutMicrosoftOAuthAppRequest(body) ? body : null;
      const secret = google ? sealJson(key, appAad(workspaceId, 'google'), { clientSecret: google.clientSecret }) : null;
      await withWorkspaceLock(pool, workspaceId, actorId, async client => {
        await client.query(`INSERT INTO calendar_oauth_apps (workspace_id, provider, client_id, secret_cipher, tenant, key_id)
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (workspace_id, provider) DO UPDATE SET client_id = EXCLUDED.client_id,
            secret_cipher = EXCLUDED.secret_cipher, tenant = EXCLUDED.tenant, key_id = EXCLUDED.key_id, updated_at = now()`,
        [workspaceId, provider, (google ?? microsoft)!.clientId, secret, microsoft?.tenant ?? null, secret ? key.id : null]);
      });
      ctx.tokens.invalidateApp(workspaceId, provider);
      return reply.send(await appsResponse(workspaceId, key));
    } catch (error) { return ctx.fail(request, reply, error); }
  });

  app.delete<{ Params: WorkspaceParams & { provider: string } }>(`${base}/oauth/apps/:provider`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId, provider } = request.params;
      const actorId = await ctx.authorize(request, workspaceId, true);
      if (!(oauthProviders as readonly string[]).includes(provider)) throw new PageError(404, 'NOT_FOUND');
      await cleanup();
      await withWorkspaceLock(pool, workspaceId, actorId, async client => {
        const used = await client.query(`SELECT 1 FROM calendar_sync_sources WHERE workspace_id = $1 AND kind = 'caldav'
          AND caldav_json->>'provider' = $2 LIMIT 1`, [workspaceId, provider]);
        if (used.rows[0]) throw new CalendarRouteError(409, 'OAUTH_APP_IN_USE');
        await client.query('DELETE FROM calendar_oauth_flows WHERE workspace_id = $1 AND provider = $2', [workspaceId, provider]);
        await client.query('DELETE FROM calendar_oauth_apps WHERE workspace_id = $1 AND provider = $2', [workspaceId, provider]);
      });
      ctx.tokens.invalidateApp(workspaceId, provider as OAuthProvider);
      return reply.code(204).send();
    } catch (error) { return ctx.fail(request, reply, error); }
  });

  app.post<{ Params: WorkspaceParams }>(`${base}/oauth/start`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await ctx.authorize(request, workspaceId, true);
      const body = request.body;
      if (!isStartOAuthRequest(body)) requestError();
      const key = ctx.requireKey();
      await cleanup();
      const provider = body.provider;
      let oauthApp: OAuthApp | null;
      try { oauthApp = await loadOAuthApp(pool, key, workspaceId, provider); } catch (error) {
        // A secret sealed with a replaced key is as good as missing: the app has to be saved again.
        if (error instanceof CalDavError && error.code === 'CREDENTIALS_UNAVAILABLE') throw new CalendarRouteError(422, 'OAUTH_APP_MISSING');
        throw error;
      }
      if (!oauthApp) throw new CalendarRouteError(422, 'OAUTH_APP_MISSING');
      const sourceId = body.sourceId?.toLowerCase() ?? null;
      let loginHint: string | null = null;
      if (sourceId) {
        const found = await pool.query<{ kind: string; caldav_json: CaldavConfig | null }>(`SELECT kind, caldav_json FROM calendar_sync_sources
          WHERE workspace_id = $1 AND id = $2`, [workspaceId, sourceId]);
        const row = found.rows[0];
        if (!row) throw new PageError(404, 'NOT_FOUND');
        if (row.kind !== 'caldav' || row.caldav_json?.provider !== provider) throw new CalendarRouteError(422, 'SYNC_KIND_INVALID');
        loginHint = row.caldav_json.account ?? null;
      }
      const id = randomUUID();
      if (oauthApp.provider === 'google') {
        const state = randomToken();
        const { verifier, challenge } = pkcePair();
        // One binding per browser, so flows started in several tabs all complete.
        const binding = readBindingCookie(request.headers.cookie, ctx.secure) ?? randomToken();
        const inserted = await pool.query<{ expires_at: Date }>(`INSERT INTO calendar_oauth_flows (id, workspace_id, user_id, provider, source_id,
            state_hash, binding_hash, secret_cipher, key_id, expires_at)
          VALUES ($1, $2, $3, 'google', $4, $5, $6, $7, $8, now() + $9::int * interval '1 minute') RETURNING expires_at`,
        [id, workspaceId, actorId, sourceId, sha256(state), sha256(binding), sealJson(key, id, { verifier }), key.id, flowMinutes]);
        reply.header('Set-Cookie', bindingCookie(binding, ctx.secure));
        const response: StartOAuthResponse = { flowId: id, provider: 'google', expiresAt: inserted.rows[0]!.expires_at.toISOString(),
          authorizeUrl: googleAuthorizeUrl(oauthApp, { redirectUri, state, challenge, loginHint }) };
        return reply.send(response);
      }
      let device;
      try { device = await requestDeviceCode(ctx.transport, oauthApp); } catch (error) {
        const code = error instanceof OAuthFlowFailure && error.code === 'FETCH_FAILED' ? 'FETCH_FAILED' : 'OAUTH_FAILED';
        if (code === 'FETCH_FAILED') ctx.log('oauth request failed', { provider });
        throw new CalendarRouteError(422, code);
      }
      const seconds = Math.min(flowMinutes * 60, Math.floor(device.expiresIn));
      const inserted = await pool.query<{ expires_at: Date }>(`INSERT INTO calendar_oauth_flows (id, workspace_id, user_id, provider, source_id,
          secret_cipher, key_id, expires_at, poll_interval, next_poll_at)
        VALUES ($1, $2, $3, 'microsoft', $4, $5, $6, now() + $7::int * interval '1 second', $8::int, now() + $8::int * interval '1 second')
        RETURNING expires_at`,
      [id, workspaceId, actorId, sourceId, sealJson(key, id, { deviceCode: device.deviceCode }), key.id, seconds, device.interval]);
      const response: StartOAuthResponse = { flowId: id, provider: 'microsoft', userCode: device.userCode, verificationUri: device.verificationUri,
        expiresAt: inserted.rows[0]!.expires_at.toISOString(), intervalSeconds: device.interval };
      return reply.send(response);
    } catch (error) { return ctx.fail(request, reply, error); }
  });

  app.get<{ Params: WorkspaceParams & { flowId: string } }>(`${base}/oauth/flows/:flowId`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await ctx.authorize(request, workspaceId, false);
      if (!isUuid(request.params.flowId)) throw new PageError(404, 'NOT_FOUND');
      await cleanup();
      const id = request.params.flowId.toLowerCase();
      let flow = await readFlow(id);
      if (!flow || flow.workspace_id !== workspaceId || flow.user_id !== actorId) throw new PageError(404, 'NOT_FOUND');
      if (flow.status === 'pending' && flow.expired) {
        await failFlow(id, 'OAUTH_EXPIRED');
      } else if (flow.status === 'pending' && flow.provider === 'microsoft' && ctx.credentialKey && ctx.fetchEnabled) {
        // At most one question per interval, whoever reads; the claim is its own statement so no lock is held while asking.
        const claimed = await pool.query(`UPDATE calendar_oauth_flows SET next_poll_at = now() + poll_interval * interval '1 second'
          WHERE id = $1 AND status = 'pending' AND expires_at > now() AND next_poll_at <= now() RETURNING id`, [id]);
        if (claimed.rows[0]) await pollMicrosoft(flow, ctx.credentialKey);
      }
      flow = await readFlow(id);
      if (!flow) throw new PageError(404, 'NOT_FOUND');
      return reply.send(await flowResponse(flow));
    } catch (error) { return ctx.fail(request, reply, error); }
  });

  app.post<{ Params: WorkspaceParams }>(`${base}/oauth/sources`, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { workspaceId } = request.params;
      const actorId = await ctx.authorize(request, workspaceId, true);
      const body = request.body;
      if (!isCreateOAuthSourceRequest(body)) requestError();
      const key = ctx.requireKey();
      await cleanup();
      const create = (action: (client: PoolClient) => Promise<{ statusCode: number; body: CreateCalendarSourcesResponse }>) =>
        pages.mutate<CreateCalendarSourcesResponse>(workspaceId, actorId, body.clientMutationId, 'calendar-oauth', null, body, action,
          response => response.sources[0]?.databaseId ?? null);
      const prior = await pool.query('SELECT 1 FROM page_mutation_receipts WHERE workspace_id = $1 AND actor_user_id = $2 AND client_mutation_id = $3',
        [workspaceId, actorId, body.clientMutationId]);
      if (prior.rows[0]) {
        const replay = await create(async () => { throw new PageError(409, 'MUTATION_CONFLICT'); });
        return reply.code(replay.statusCode).send(replay.body);
      }
      const flow = await readFlow(body.flowId.toLowerCase());
      if (!flow || flow.workspace_id !== workspaceId || flow.user_id !== actorId) throw new PageError(404, 'NOT_FOUND');
      if (flow.status !== 'ready' || flow.source_id || !flow.token_cipher || !flow.account_json) throw new CalendarRouteError(422, 'FLOW_NOT_READY');
      const chosen = chosenCalendars(flow.calendars_json ?? [], body.calendars);
      const tokens = openTokens(key, flow.id, flow.token_cipher, flow.key_id);
      if (!tokens) throw new CalendarRouteError(503, 'CREDENTIALS_UNAVAILABLE');
      const account = flow.account_json.account;
      // Each source keeps its own copy of the tokens and refreshes it on its own.
      const planned = chosen.map((calendar, index) => {
        const id = randomUUID();
        const config: CaldavConfig = { provider: flow.provider, account, subject: tokens.subject,
          serverUrl: flow.provider === 'google' ? googleServerUrl : graphBase, calendarUrl: calendar.url, calendarName: calendar.name,
          writable: calendar.writable, color: calendar.color };
        return { id, name: body.calendars[index]!.name.trim(), config, cipher: sealTokens(key, id, tokens) };
      });
      const result = await create(async client => {
        const used = await client.query(`UPDATE calendar_oauth_flows SET status = 'used', token_cipher = NULL
          WHERE id = $1 AND status = 'ready' RETURNING id`, [flow.id]);
        if (!used.rows[0]) throw new CalendarRouteError(422, 'FLOW_NOT_READY');
        const sources: CalendarSyncSource[] = [];
        for (const [index, { id, name, config, cipher }] of planned.entries()) {
          const mutationId = sourceMutationId(body.clientMutationId, index);
          const database = await createSyncDatabase(client, pages, workspaceId, actorId, null, name, mutationId);
          const source = await insertSource(client, { id, workspaceId, databaseId: database.databaseId, kind: 'caldav', name, url: null,
            intervalMinutes: body.intervalMinutes, fields: database.fields, actorId, clientMutationId: mutationId,
            caldav: { config, cipher, keyId: key.id } });
          sources.push(toSyncSource(source, view));
        }
        return { statusCode: 201, body: { sources } };
      });
      ctx.nudge();
      return reply.code(result.statusCode).send(result.body);
    } catch (error) { return ctx.fail(request, reply, error); }
  });

  // Not under a workspace and without the session: the Strict session cookie is not sent on the redirect from Google.
  app.get<{ Querystring: Record<string, unknown> }>(googleOAuthCallbackPath, async (request, reply) => {
    const finished = (flow: FlowRow) => flow.status === 'ready' || flow.status === 'used'
      ? sendPage(reply, 200, '授权完成', '授权完成，可以关闭此页，回到 NBase 继续。')
      : sendPage(reply, 400, '授权没有完成', failureText[flow.error ?? 'OAUTH_FAILED']);
    try {
      await cleanup();
      const query = request.query ?? {};
      const param = (name: string) => typeof query[name] === 'string' ? query[name] as string : null;
      const state = param('state');
      const invalid = () => sendPage(reply, 400, '授权链接无效', '这个授权链接无效或已过期。请回到 NBase 重新连接。');
      if (!state || !tokenPattern.test(state)) return invalid();
      const found = await pool.query<FlowRow>(`SELECT ${flowColumns} FROM calendar_oauth_flows WHERE state_hash = $1 AND provider = 'google'`,
        [sha256(state)]);
      let flow = found.rows[0];
      if (!flow) return invalid();
      const binding = readBindingCookie(request.headers.cookie, ctx.secure);
      if (!binding || !flow.binding_hash || !timingSafeEqual(sha256(binding), flow.binding_hash)) {
        return sendPage(reply, 400, '请在原浏览器中完成授权', '这次授权不是在当前浏览器中发起的。请回到发起连接的 NBase 页面重新打开授权页。');
      }
      if (flow.status !== 'pending') return finished(flow);
      const key = ctx.credentialKey;
      const fail = async (code: OAuthFlowError) => { await failFlow(flow!.id, code); return sendPage(reply, 400, '授权没有完成', failureText[code]); };
      if (flow.expired) return fail('OAUTH_EXPIRED');
      const providerError = param('error');
      if (providerError) return fail(providerError === 'access_denied' ? 'OAUTH_DENIED' : 'OAUTH_FAILED');
      const code = param('code');
      if (!code || code.length > 4096) return fail('OAUTH_FAILED');
      if (!key || !ctx.fetchEnabled) return fail('FETCH_FAILED');
      // A second callback for the same flow (a reload while the first is exchanging the code) does not exchange it again.
      const claimed = await pool.query(`UPDATE calendar_oauth_flows SET next_poll_at = now() + interval '2 minutes'
        WHERE id = $1 AND status = 'pending' AND (next_poll_at IS NULL OR next_poll_at <= now()) RETURNING id`, [flow.id]);
      if (!claimed.rows[0]) return sendPage(reply, 409, '授权正在处理', 'NBase 正在完成这次授权，请回到 NBase 查看结果。');
      const secret = openJson(key, flow.id, flow.secret_cipher, flow.key_id) as { verifier?: unknown } | null;
      const oauthApp = await loadOAuthApp(pool, key, flow.workspace_id, 'google').catch(() => null);
      if (typeof secret?.verifier !== 'string' || !oauthApp || oauthApp.provider !== 'google') return fail('OAUTH_FAILED');
      let disabled: Readonly<Record<string, string>> | undefined;
      try {
        const { grant, identity } = await exchangeGoogleCode(ctx.transport, oauthApp, { code, verifier: secret.verifier, redirectUri });
        disabled = await completeFlow(flow, key, oauthApp, grant, identity);
      } catch (error) { await failFlow(flow.id, flowErrorCode(error, 'google')); }
      flow = (await readFlow(flow.id)) ?? undefined;
      if (!flow) return invalid();
      if (disabled && flow.status === 'failed' && flow.error === 'API_DISABLED') return sendPage(reply, 400, '授权没有完成', disabledText(disabled));
      return finished(flow);
    } catch (error) {
      request.log.error({ err: error }, 'google oauth callback failed');
      return sendPage(reply, 500, '授权没有完成', '处理授权时出错。请回到 NBase 重试。');
    }
  });
}
