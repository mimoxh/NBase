import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { googleOAuthCallbackPath, type CalendarSyncListResponse, type CreateCalendarSourcesResponse, type DatabaseDocument, type OAuthAppsResponse,
  type OAuthFlowResponse, type StartOAuthResponse } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { OAuthTokens, openTokens } from '../src/calendar/oauth/tokens.js';
import { claimDueSource, runSource, type CalendarSyncOptions } from '../src/calendar/scheduler.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';
import { credentialKeyFromText } from '../src/secrets/credentials.js';
import { icsText, MockCalDav } from './caldav-mock.js';
import { FakeProviders, googleClient, msClientId } from './oauth-mock.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local integration password only';
const key = credentialKeyFromText(Buffer.alloc(32, 11).toString('base64'));

test('OAuth accounts: apps, Google authorization and two-way sync, tokens, re-authorization, Microsoft device code and Graph sync', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const admin = new pg.Pool({ connectionString: sourceUrl, max: 2 });
  const name = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  const mock = new MockCalDav({ home: '/caldav/v2/' });
  const fake = new FakeProviders(mock);
  let created = false;
  let pool: pg.Pool | undefined;
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    const db = pool;
    await runMigrations(pool);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(ownerPassword), '测试');
    const editorId = randomUUID();
    await db.query('INSERT INTO users (id, login_name, password_hash) VALUES ($1, $2, $3)', [editorId, 'other-editor', await hashPassword(ownerPassword)]);
    await db.query("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'editor')", [owner.workspaceId, editorId]);

    const work = mock.addCalendar('alice@gmail.test/events', { name: 'Alice', writable: true });
    mock.set(work, 'standup.ics', icsText([['UID:standup', 'DTSTART:20260310T010000Z', 'DTEND:20260310T013000Z', 'SUMMARY:站会']]));
    mock.set(work, 'trip.ics', icsText([['UID:trip', 'DTSTART;VALUE=DATE:20260312', 'DTEND;VALUE=DATE:20260314', 'SUMMARY:出差']]));
    await mock.start();

    let clock = Date.now();
    const tokens = new OAuthTokens(() => clock);
    const pages = new PgPageRepository(pool);
    const auth = new PgAuthRepository(pool);
    type Calendar = NonNullable<NonNullable<Parameters<typeof buildApp>[0]>['calendar']>;
    const appWith = async (calendar: Calendar, loginName = 'owner') => {
      const instance = await buildApp({ auth: { repository: auth, publicOrigin: origin }, pages, notesPool: db, calendar });
      apps.push(instance);
      const login = await instance.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { loginName, password: ownerPassword } });
      const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
      const write = { cookie, origin, 'x-csrf-token': login.json().csrfToken as string };
      const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown, extraCookie?: string) => {
        const headers = method === 'GET' ? { cookie } : { ...write };
        if (extraCookie) headers.cookie = `${cookie}; ${extraCookie}`;
        return instance.inject({ method, url: `/api/workspaces/${owner.workspaceId}${path}`, headers,
          ...(method === 'GET' ? {} : { payload: (payload ?? {}) as object }) });
      };
      return { instance, call };
    };
    const options: Calendar = { scheduler: false, credentialKey: key, oauthTransport: fake.transport, oauthTokens: tokens };
    const { instance: main, call } = await appWith(options);
    const syncOptions: CalendarSyncOptions = { fetchEnabled: true, credentialKey: key, oauthTransport: fake.transport, oauthTokens: tokens };
    const syncAll = async () => {
      for (let due = await claimDueSource(db); due; due = await claimDueSource(db)) await runSource(db, pages, due, syncOptions);
    };
    const listed = async (id: string) => ((await call('GET', '/calendar/sync')).json() as CalendarSyncListResponse).sources.find(s => s.id === id)!;
    const run = async (id: string) => {
      assert.equal((await call('POST', `/calendar/sync/${id}/run`)).statusCode, 202);
      await syncAll();
      return listed(id);
    };
    const flow = async (id: string, using = call) => {
      const response = await using('GET', `/calendar/oauth/flows/${id}`);
      assert.equal(response.statusCode, 200, response.body);
      return response.json() as OAuthFlowResponse;
    };
    const callback = (query: Record<string, string>, cookie?: string) => main.inject({ method: 'GET',
      url: `${googleOAuthCallbackPath}?${new URLSearchParams(query)}`, headers: cookie ? { cookie } : {} });
    const startGoogle = async (body: Record<string, unknown> = {}, cookie?: string) => {
      const response = await call('POST', '/calendar/oauth/start', { provider: 'google', ...body }, cookie);
      assert.equal(response.statusCode, 200, response.body);
      const started = response.json() as Extract<StartOAuthResponse, { provider: 'google' }>;
      const setCookie = String(response.headers['set-cookie']);
      return { started, state: new URL(started.authorizeUrl).searchParams.get('state')!, binding: setCookie.split(';', 1)[0]!, setCookie };
    };

    // Apps: a credential key is required, secrets are never returned.
    const { call: keyless } = await appWith({ scheduler: false, oauthTransport: fake.transport });
    const noKey = await keyless('PUT', '/calendar/oauth/apps/google', googleClient);
    assert.equal(noKey.statusCode, 503, noKey.body);
    assert.equal(noKey.json().error, 'CREDENTIALS_UNAVAILABLE');
    const noKeyApps = await keyless('GET', '/calendar/oauth/apps');
    assert.equal(noKeyApps.statusCode, 503, noKeyApps.body);
    assert.equal(noKeyApps.json().error, 'CREDENTIALS_UNAVAILABLE');
    assert.equal((await call('PUT', '/calendar/oauth/apps/google', { ...googleClient, extra: 1 })).statusCode, 400);
    assert.equal((await call('POST', '/calendar/oauth/start', { provider: 'google' })).json().error, 'OAUTH_APP_MISSING');
    const put = await call('PUT', '/calendar/oauth/apps/google', googleClient);
    assert.equal(put.statusCode, 200, put.body);
    assert.ok(!put.body.includes(googleClient.clientSecret));
    const appsBody = await call('GET', '/calendar/oauth/apps');
    assert.deepEqual(appsBody.json() as OAuthAppsResponse, { googleRedirectUri: `${origin}${googleOAuthCallbackPath}`,
      google: { clientId: googleClient.clientId }, microsoft: null });
    const storedApp = await db.query<{ secret_cipher: Buffer; key_id: string }>(`SELECT secret_cipher, key_id FROM calendar_oauth_apps
      WHERE workspace_id = $1 AND provider = 'google'`, [owner.workspaceId]);
    assert.equal(storedApp.rows[0]!.key_id, key.id);
    assert.ok(!storedApp.rows[0]!.secret_cipher.includes(Buffer.from(googleClient.clientSecret)));

    // Google: the callback needs the browser that started the flow.
    const first = await startGoogle();
    assert.match(first.setCookie, /^nbase_oauth=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=900$/);
    assert.equal(new URL(first.started.authorizeUrl).searchParams.get('redirect_uri'), `${origin}${googleOAuthCallbackPath}`);
    assert.equal((await flow(first.started.flowId)).status, 'pending');
    const code = fake.authorize(first.started.authorizeUrl);
    const unbound = await callback({ state: first.state, code });
    assert.equal(unbound.statusCode, 400);
    assert.equal((await callback({ state: first.state, code }, `nbase_oauth=${'B'.repeat(43)}`)).statusCode, 400);
    assert.equal((await callback({ state: 'x'.repeat(43), code }, first.binding)).statusCode, 400);
    assert.equal((await flow(first.started.flowId)).status, 'pending');
    const done = await callback({ state: first.state, code, scope: 'email' }, first.binding);
    assert.equal(done.statusCode, 200, done.body);
    assert.match(done.body, /授权完成，可以关闭此页，回到 NBase 继续/);
    assert.doesNotMatch(done.body, /<script/i);
    assert.equal(done.headers['cache-control'], 'no-store');
    assert.equal(done.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'");
    assert.equal(done.headers['referrer-policy'], 'no-referrer');
    assert.match(String(done.headers['content-type']), /^text\/html/);
    const ready = await flow(first.started.flowId);
    assert.deepEqual([ready.status, ready.error, ready.account, ready.source], ['ready', null, 'alice@gmail.test', null]);
    assert.deepEqual(ready.calendars, [
      { url: 'https://apidata.googleusercontent.com/caldav/v2/alice%40gmail.test/events/', name: 'Alice', color: '#9fc6e7', writable: true },
      { url: 'https://apidata.googleusercontent.com/caldav/v2/zh.china%23holiday%40group.v.calendar.google.com/events/', name: '中国节假日',
        color: null, writable: false },
    ]);
    // A repeated callback shows the finished state; the code is not exchanged again.
    assert.match((await callback({ state: first.state, code }, first.binding)).body, /授权完成/);
    // Only the user who started the flow reads it.
    const { call: other } = await appWith(options, 'other-editor');
    assert.equal((await other('GET', `/calendar/oauth/flows/${first.started.flowId}`)).statusCode, 404);
    assert.equal((await call('GET', `/calendar/oauth/flows/${randomUUID()}`)).statusCode, 404);

    // A second flow in the same browser keeps the binding; declining fails the flow.
    const second = await startGoogle({}, first.binding);
    assert.equal(second.binding, first.binding);
    const denied = await callback({ state: second.state, error: 'access_denied' }, first.binding);
    assert.equal(denied.statusCode, 400);
    assert.match(denied.body, /授权被拒绝/);
    assert.deepEqual([(await flow(second.started.flowId)).status, (await flow(second.started.flowId)).error], ['failed', 'OAUTH_DENIED']);

    // Creating the source uses up a ready flow; retries replay the first answer.
    const pending = await startGoogle({}, first.binding);
    const sourceBody = { clientMutationId: randomUUID(), flowId: first.started.flowId, calendars: [{ calendarUrl: ready.calendars[0]!.url, name: 'Google 日历' }],
      intervalMinutes: 15 };
    assert.equal((await call('POST', '/calendar/oauth/sources', { ...sourceBody, flowId: pending.started.flowId })).json().error, 'FLOW_NOT_READY');
    assert.equal((await other('POST', '/calendar/oauth/sources', { ...sourceBody, clientMutationId: randomUUID() })).statusCode, 404);
    assert.equal((await call('POST', '/calendar/oauth/sources', { ...sourceBody, clientMutationId: randomUUID(),
      calendars: [{ calendarUrl: 'https://apidata.googleusercontent.com/caldav/v2/nope/events/', name: 'x' }] })).json().error, 'CALENDAR_NOT_FOUND');
    const createdSource = await call('POST', '/calendar/oauth/sources', sourceBody);
    assert.equal(createdSource.statusCode, 201, createdSource.body);
    const googleCreated = createdSource.json() as CreateCalendarSourcesResponse;
    assert.equal(googleCreated.sources.length, 1);
    const google = googleCreated.sources[0]!;
    assert.deepEqual(google.caldav, { provider: 'google', account: 'alice@gmail.test', serverHost: 'apidata.googleusercontent.com',
      calendarName: 'Alice', writable: true, credentialsOk: true, conflictCount: 0, aggregate: false });
    assert.deepEqual((await call('POST', '/calendar/oauth/sources', sourceBody)).json(), googleCreated);
    assert.equal((await call('POST', '/calendar/oauth/sources', { ...sourceBody, clientMutationId: randomUUID() })).json().error, 'FLOW_NOT_READY');
    const storedSource = async () => (await db.query<{ credential_cipher: Buffer; credential_key_id: string; caldav_json: Record<string, unknown> }>(
      'SELECT credential_cipher, credential_key_id, caldav_json FROM calendar_sync_sources WHERE id = $1', [google.id])).rows[0]!;
    let stored = await storedSource();
    let sealed = openTokens(key, google.id, stored.credential_cipher, stored.credential_key_id);
    assert.equal(sealed?.subject, 'g-alice');
    assert.ok(fake.refreshTokens.has(sealed!.refreshToken));
    assert.ok(!createdSource.body.includes(sealed!.refreshToken));
    assert.equal(stored.caldav_json.subject, 'g-alice');
    assert.equal(stored.caldav_json.serverUrl, 'https://apidata.googleusercontent.com/');
    const usedFlow = await db.query<{ status: string; token_cipher: Buffer | null }>('SELECT status, token_cipher FROM calendar_oauth_flows WHERE id = $1',
      [first.started.flowId]);
    assert.deepEqual(usedFlow.rows[0], { status: 'used', token_cipher: null });

    // The first run refreshes once and reads the Google CalDAV calendar with the bearer token.
    let state = await run(google.id);
    assert.equal(state.lastError, null, JSON.stringify(state));
    assert.equal(state.lastCounts?.created, 2);
    assert.equal(fake.counts.refresh, 1);
    const database = async (id: string) => (await call('GET', `/databases/${id}`)).json() as DatabaseDocument;
    const row = async (title: string) => (await database(google.databaseId)).rows.find(r => r.title === title)!;
    const fields = google.fields;

    // Local edits are written back; new events go without If-None-Match.
    const standup = await row('站会');
    assert.equal((await call('PATCH', `/pages/${standup.id}`, { clientMutationId: randomUUID(), expectedRevision: standup.revision,
      title: '站会（改）' })).statusCode, 200);
    assert.equal((await call('POST', `/databases/${google.databaseId}/rows/bulk`, { clientMutationId: randomUUID(), operation: 'create',
      rows: [{ title: '新事件', properties: { [fields.dateId]: '2026-03-20' } }] })).statusCode, 200);
    let mark = mock.requests.length;
    state = await run(google.id);
    assert.equal(state.lastError, null);
    assert.equal(state.lastCounts?.pushed, 2);
    assert.equal(fake.counts.refresh, 1);
    const puts = mock.requests.slice(mark).filter(r => r.method === 'PUT');
    assert.equal(puts.length, 2);
    assert.ok(puts.every(r => r.ifNoneMatch === undefined));
    assert.equal(puts.filter(r => r.ifMatch).length, 1);
    assert.match(mock.body(work, 'standup.ics')!, /SUMMARY:站会（改）/);
    const fresh = [...mock.calendars.get(work)!.resources.keys()].filter(n => !['standup.ics', 'trip.ics'].includes(n));
    assert.equal(fresh.length, 1);
    assert.match(mock.body(work, fresh[0]!)!, /SUMMARY:新事件/);
    // External changes come back.
    mock.set(work, 'trip.ics', mock.body(work, 'trip.ics')!.replace('SUMMARY:出差', 'SUMMARY:出差（改）'));
    state = await run(google.id);
    assert.equal(state.lastCounts?.updated, 1);
    assert.ok(await row('出差（改）'));

    // An access token near its expiry is refreshed; a 401 renews once.
    clock += 3600 * 1000;
    state = await run(google.id);
    assert.equal(state.lastError, null);
    assert.equal(fake.counts.refresh, 2);
    fake.access.clear();
    const unauthorized = fake.counts.unauthorized;
    state = await run(google.id);
    assert.equal(state.lastError, null);
    assert.equal(fake.counts.refresh, 3);
    assert.equal(fake.counts.unauthorized, unauthorized + 1);

    // A rotated refresh token is saved at once.
    fake.rotate = true;
    const before = sealed!.refreshToken;
    clock += 3600 * 1000;
    state = await run(google.id);
    assert.equal(state.lastError, null);
    stored = await storedSource();
    sealed = openTokens(key, google.id, stored.credential_cipher, stored.credential_key_id);
    assert.notEqual(sealed?.refreshToken, before);
    assert.ok(fake.refreshTokens.has(sealed!.refreshToken) && !fake.refreshTokens.has(before));
    fake.rotate = false;
    clock += 3600 * 1000;
    assert.equal((await run(google.id)).lastError, null);

    // A revoked grant needs a new authorization.
    fake.refreshTokens.clear();
    clock += 3600 * 1000;
    state = await run(google.id);
    assert.equal(state.lastError, 'AUTH_FAILED');
    assert.equal(state.status, 'error');
    assert.equal((await call('PATCH', `/calendar/sync/${google.id}`, { credentials: { username: 'a', password: 'b' } })).json().error,
      'SYNC_KIND_INVALID');
    assert.equal((await call('POST', '/calendar/oauth/start', { provider: 'google', sourceId: randomUUID() })).statusCode, 404);

    // Another account cannot take over the source.
    const intruder = await startGoogle({ sourceId: google.id }, first.binding);
    const mismatch = await callback({ state: intruder.state, code: fake.authorize(intruder.started.authorizeUrl, { sub: 'g-mallory',
      email: 'mallory@gmail.test' }) }, first.binding);
    assert.equal(mismatch.statusCode, 400);
    assert.match(mismatch.body, /账号/);
    assert.deepEqual([(await flow(intruder.started.flowId)).status, (await flow(intruder.started.flowId)).error], ['failed', 'ACCOUNT_MISMATCH']);
    assert.ok((await storedSource()).credential_cipher.equals(stored.credential_cipher));

    // Re-authorizing the same account replaces the tokens and syncs right away.
    const again = await startGoogle({ sourceId: google.id }, first.binding);
    assert.equal(new URL(again.started.authorizeUrl).searchParams.get('login_hint'), 'alice@gmail.test');
    assert.equal((await callback({ state: again.state, code: fake.authorize(again.started.authorizeUrl) }, first.binding)).statusCode, 200);
    const reauthorized = await flow(again.started.flowId);
    assert.equal(reauthorized.status, 'ready');
    assert.deepEqual(reauthorized.calendars, []);
    assert.equal(reauthorized.source?.id, google.id);
    assert.equal(reauthorized.source?.lastError, null);
    const due = await db.query<{ due: boolean }>('SELECT next_run_at <= now() AS due FROM calendar_sync_sources WHERE id = $1', [google.id]);
    assert.equal(due.rows[0]!.due, true);
    const refreshes = fake.counts.refresh;
    await syncAll();
    assert.equal((await listed(google.id)).lastError, null);
    assert.equal(fake.counts.refresh, refreshes);

    // A Google project without the CalDAV or Calendar API fails the flow, and the sync.
    fake.caldavDisabled = true;
    const disabled = await startGoogle({}, first.binding);
    const disabledPage = await callback({ state: disabled.state, code: fake.authorize(disabled.started.authorizeUrl) }, first.binding);
    assert.match(disabledPage.body, /编号为 987654321 的 Google Cloud 项目没有启用 CalDAV API/);
    assert.equal((await flow(disabled.started.flowId)).error, 'API_DISABLED');
    assert.equal((await run(google.id)).lastError, 'API_DISABLED');
    fake.caldavDisabled = false;
    fake.calendarApiDisabled = true;
    const noList = await startGoogle({}, first.binding);
    const noListPage = await callback({ state: noList.state, code: fake.authorize(noList.started.authorizeUrl) }, first.binding);
    assert.equal((await flow(noList.started.flowId)).error, 'API_DISABLED');
    // An answer without a project number keeps the general advice.
    assert.match(noListPage.body, /没有启用 CalDAV API 或 Google Calendar API。已经启用的话/);
    fake.calendarApiDisabled = false;
    // Leaving out the calendar permission on the consent screen.
    const narrow = await startGoogle({}, first.binding);
    await callback({ state: narrow.state, code: fake.authorize(narrow.started.authorizeUrl, fake.alice, 'openid email') }, first.binding);
    assert.equal((await flow(narrow.started.flowId)).error, 'OAUTH_DENIED');
    assert.equal((await run(google.id)).lastError, null);

    // An app in use stays; one removed anyway stops the source.
    assert.equal((await call('DELETE', '/calendar/oauth/apps/google')).json().error, 'OAUTH_APP_IN_USE');
    await db.query(`DELETE FROM calendar_oauth_apps WHERE workspace_id = $1 AND provider = 'google'`, [owner.workspaceId]);
    assert.equal((await run(google.id)).lastError, 'OAUTH_APP_MISSING');
    assert.equal((await call('PUT', '/calendar/oauth/apps/google', googleClient)).statusCode, 200);
    assert.equal((await run(google.id)).lastError, null);
    // A changed client secret that Google refuses means authorizing again.
    assert.equal((await call('PUT', '/calendar/oauth/apps/google', { ...googleClient, clientSecret: 'GOCSPX-other' })).statusCode, 200);
    assert.equal((await run(google.id)).lastError, 'AUTH_FAILED');
    assert.equal((await call('PUT', '/calendar/oauth/apps/google', googleClient)).statusCode, 200);
    assert.equal((await run(google.id)).lastError, null);

    // A replaced credential key: the saved client secret asks to be entered again, the source to be authorized again.
    const otherKey = credentialKeyFromText(Buffer.alloc(32, 12).toString('base64'));
    const { call: rekeyed } = await appWith({ ...options, credentialKey: otherKey, oauthTokens: new OAuthTokens(() => clock) });
    assert.deepEqual(((await rekeyed('GET', '/calendar/oauth/apps')).json() as OAuthAppsResponse).google,
      { clientId: googleClient.clientId, secretUnavailable: true });
    const staleStart = await rekeyed('POST', '/calendar/oauth/start', { provider: 'google', sourceId: google.id });
    assert.deepEqual([staleStart.statusCode, staleStart.json().error], [422, 'OAUTH_APP_MISSING']);
    const rekeyedSource = ((await rekeyed('GET', '/calendar/sync')).json() as CalendarSyncListResponse).sources.find(s => s.id === google.id)!;
    assert.equal(rekeyedSource.caldav?.credentialsOk, false);
    assert.equal((await rekeyed('POST', `/calendar/sync/${google.id}/run`)).statusCode, 202);
    const rekeyedRun = await claimDueSource(db);
    assert.equal(rekeyedRun?.id, google.id);
    await runSource(db, pages, rekeyedRun!, { ...syncOptions, credentialKey: otherKey, oauthTokens: new OAuthTokens(() => clock) });
    assert.equal((await listed(google.id)).lastError, 'CREDENTIALS_UNAVAILABLE');
    const resaved = await rekeyed('PUT', '/calendar/oauth/apps/google', googleClient);
    assert.deepEqual((resaved.json() as OAuthAppsResponse).google, { clientId: googleClient.clientId });
    assert.equal((await rekeyed('POST', '/calendar/oauth/start', { provider: 'google', sourceId: google.id })).statusCode, 200);
    // Back to the original key for the rest.
    assert.equal(((await call('GET', '/calendar/oauth/apps')).json() as OAuthAppsResponse).google?.secretUnavailable, true);
    assert.equal((await call('PUT', '/calendar/oauth/apps/google', googleClient)).statusCode, 200);
    assert.equal((await run(google.id)).lastError, null);

    // Microsoft: the device code flow, polled at most once per interval.
    assert.equal((await call('PUT', '/calendar/oauth/apps/microsoft', { clientId: 'not-a-guid', tenant: 'common' })).statusCode, 400);
    const msApp = await call('PUT', '/calendar/oauth/apps/microsoft', { clientId: msClientId, tenant: 'common' });
    assert.deepEqual((msApp.json() as OAuthAppsResponse).microsoft, { clientId: msClientId, tenant: 'common' });
    assert.equal((await call('POST', '/calendar/oauth/start', { provider: 'microsoft', sourceId: google.id })).json().error, 'SYNC_KIND_INVALID');
    fake.msRefused = true;
    const refused = await call('POST', '/calendar/oauth/start', { provider: 'microsoft' });
    assert.deepEqual([refused.statusCode, refused.json().error], [422, 'OAUTH_FAILED']);
    fake.msRefused = false;
    const startMicrosoft = async () => {
      const response = await call('POST', '/calendar/oauth/start', { provider: 'microsoft' });
      assert.equal(response.statusCode, 200, response.body);
      return response.json() as Extract<StartOAuthResponse, { provider: 'microsoft' }>;
    };
    const due2 = (id: string) => db.query('UPDATE calendar_oauth_flows SET next_poll_at = now() WHERE id = $1', [id]);
    fake.msScript = ['authorization_pending', 'slow_down', 'ready'];
    const ms = await startMicrosoft();
    assert.deepEqual([ms.userCode, ms.verificationUri, ms.intervalSeconds], ['ABCD-EFGH', 'https://microsoft.com/devicelogin', 5]);
    const span = Date.parse(ms.expiresAt) - Date.now();
    assert.ok(span > 14 * 60000 && span <= 15 * 60000 + 5000, String(span));
    assert.equal((await flow(ms.flowId)).status, 'pending');
    assert.equal(fake.counts.msToken, 0);
    await due2(ms.flowId);
    assert.equal((await flow(ms.flowId)).status, 'pending');
    assert.equal((await flow(ms.flowId)).status, 'pending');
    assert.equal(fake.counts.msToken, 1);
    await due2(ms.flowId);
    assert.equal((await flow(ms.flowId)).status, 'pending');
    const interval = await db.query<{ poll_interval: number; wait: boolean }>(`SELECT poll_interval, next_poll_at > now() + interval '8 seconds' AS wait
      FROM calendar_oauth_flows WHERE id = $1`, [ms.flowId]);
    assert.deepEqual(interval.rows[0], { poll_interval: 10, wait: true });
    await due2(ms.flowId);
    const msReady = await flow(ms.flowId);
    assert.deepEqual([msReady.status, msReady.account], ['ready', 'bob@contoso.test']);
    assert.deepEqual(msReady.calendars, [
      { url: 'https://graph.microsoft.com/v1.0/me/calendars/AAMkCal1/', name: '日历', color: '#ff8c00', writable: true },
      { url: 'https://graph.microsoft.com/v1.0/me/calendars/AAMkCal2/', name: '生日', color: null, writable: false },
    ]);
    assert.equal(fake.counts.msToken, 3);
    assert.equal((await other('GET', `/calendar/oauth/flows/${ms.flowId}`)).statusCode, 404);
    const msSource = await call('POST', '/calendar/oauth/sources', { clientMutationId: randomUUID(), flowId: ms.flowId,
      calendars: [{ calendarUrl: msReady.calendars[0]!.url, name: 'Outlook' }], intervalMinutes: 30 });
    assert.equal(msSource.statusCode, 201, msSource.body);
    const microsoft = (msSource.json() as CreateCalendarSourcesResponse).sources[0]!;
    assert.deepEqual(microsoft.caldav, { provider: 'microsoft', account: 'bob@contoso.test', serverHost: 'graph.microsoft.com', calendarName: '日历',
      writable: true, credentialsOk: true, conflictCount: 0, aggregate: false });
    const msStored = await db.query<{ caldav_json: Record<string, unknown> }>('SELECT caldav_json FROM calendar_sync_sources WHERE id = $1', [microsoft.id]);
    assert.equal(msStored.rows[0]!.caldav_json.subject, 'm-bob');
    assert.equal(msStored.rows[0]!.caldav_json.calendarUrl, 'https://graph.microsoft.com/v1.0/me/calendars/AAMkCal1/');

    // Outlook through Graph, run by the scheduler with the source's tokens and the workspace's time zone.
    const cst = (dateTime: string) => ({ dateTime, timeZone: 'China Standard Time' });
    const outlook = fake.graph;
    outlook.addCalendar('AAMkCal1', '日历');
    const review = outlook.add('AAMkCal1', { subject: '评审', start: cst('2026-03-10T09:00:00'), end: cst('2026-03-10T09:30:00'), location: '二号会议室' });
    outlook.add('AAMkCal1', { subject: '年假', isAllDay: true, start: cst('2026-03-16T00:00:00'), end: cst('2026-03-18T00:00:00') });
    await db.query(`UPDATE workspaces SET note_time_zone = 'Asia/Shanghai' WHERE id = $1`, [owner.workspaceId]);
    const msRow = async (title: string) => (await database(microsoft.databaseId)).rows.find(r => r.title === title);
    let msState = await run(microsoft.id);
    assert.equal(msState.lastError, null, JSON.stringify(msState));
    assert.equal(msState.lastCounts?.created, 2);
    const reviewRow = (await msRow('评审'))!;
    assert.equal(reviewRow.properties[microsoft.fields.dateId], '2026-03-10T01:00:00Z/2026-03-10T01:30:00Z|tz=Asia/Shanghai');
    assert.equal(reviewRow.properties[microsoft.fields.uidId], review.iCalUId);
    assert.equal(reviewRow.properties[microsoft.fields.locationId], '二号会议室');
    assert.equal((await msRow('年假'))!.properties[microsoft.fields.dateId], '2026-03-16/2026-03-17');
    const msRefreshes = fake.counts.msRefresh;
    const msTokens = async () => {
      const row = (await db.query<{ credential_cipher: Buffer; credential_key_id: string }>(
        'SELECT credential_cipher, credential_key_id FROM calendar_sync_sources WHERE id = $1', [microsoft.id])).rows[0]!;
      return openTokens(key, microsoft.id, row.credential_cipher, row.credential_key_id);
    };
    assert.equal((await msTokens())?.subject, 'm-bob');
    assert.ok(fake.refreshTokens.has((await msTokens())!.refreshToken));
    // Local edits go out as PATCH with If-Match, new rows as POST in the workspace's zone.
    assert.equal((await call('PATCH', `/pages/${reviewRow.id}`, { clientMutationId: randomUUID(), expectedRevision: reviewRow.revision,
      title: '评审（改）' })).statusCode, 200);
    assert.equal((await call('POST', `/databases/${microsoft.databaseId}/rows/bulk`, { clientMutationId: randomUUID(), operation: 'create',
      rows: [{ title: '团建', properties: { [microsoft.fields.dateId]: '2026-03-20' } }] })).statusCode, 200);
    const etagBefore = review.etag;
    let graphMark = outlook.requests.length;
    msState = await run(microsoft.id);
    assert.equal(msState.lastError, null, JSON.stringify(msState));
    assert.equal(msState.lastCounts?.pushed, 2);
    const graphWrites = outlook.writes(graphMark);
    const patch = graphWrites.find(r => r.method === 'PATCH');
    assert.deepEqual([patch?.path, patch?.ifMatch, (patch?.body as { subject?: string }).subject], [`me/events/${review.id}`, etagBefore, '评审（改）']);
    assert.equal(review.subject, '评审（改）');
    const post = graphWrites.find(r => r.method === 'POST');
    assert.equal(post?.path, 'me/calendars/AAMkCal1/events');
    assert.deepEqual((post?.body as { isAllDay?: boolean; start?: unknown }).isAllDay, true);
    assert.deepEqual((post?.body as { start?: { timeZone?: string } }).start?.timeZone, 'China Standard Time');
    const team = [...outlook.events.values()].find(e => e.subject === '团建')!;
    assert.equal((await msRow('团建'))!.properties[microsoft.fields.uidId], team.iCalUId);
    graphMark = outlook.requests.length;
    msState = await run(microsoft.id);
    assert.deepEqual([msState.lastError, msState.lastCounts?.created, msState.lastCounts?.pushed], [null, 0, 0]);
    assert.equal(outlook.writes(graphMark).length, 0);
    // Outlook changes come back; a lost access token is renewed once and the new refresh token kept.
    outlook.update(review, { subject: '评审（外部改）' });
    fake.access.clear();
    const msUnauthorizedRefreshes = fake.counts.msRefresh;
    msState = await run(microsoft.id);
    assert.equal(msState.lastError, null, JSON.stringify(msState));
    assert.equal(msState.lastCounts?.updated, 1);
    assert.ok(await msRow('评审（外部改）'));
    assert.equal(fake.counts.msRefresh, msUnauthorizedRefreshes + 1);
    assert.ok(msUnauthorizedRefreshes >= msRefreshes);
    assert.ok(fake.refreshTokens.has((await msTokens())!.refreshToken));

    for (const [answer, expected] of [['authorization_declined', 'OAUTH_DENIED'], ['expired_token', 'OAUTH_EXPIRED'],
      ['unauthorized_client', 'OAUTH_FAILED']] as const) {
      fake.msScript = [answer];
      const started = await startMicrosoft();
      await due2(started.flowId);
      const failed = await flow(started.flowId);
      assert.deepEqual([failed.status, failed.error], ['failed', expected], answer);
    }
    const late = await startMicrosoft();
    await db.query(`UPDATE calendar_oauth_flows SET expires_at = now() - interval '1 minute', next_poll_at = now() WHERE id = $1`, [late.flowId]);
    const polls = fake.counts.msToken;
    assert.deepEqual([(await flow(late.flowId)).status, (await flow(late.flowId)).error], ['failed', 'OAUTH_EXPIRED']);
    assert.equal(fake.counts.msToken, polls);
    // Flows long past their expiry are dropped.
    await db.query(`UPDATE calendar_oauth_flows SET expires_at = now() - interval '2 hours' WHERE id = $1`, [late.flowId]);
    assert.equal((await call('GET', `/calendar/oauth/flows/${late.flowId}`)).statusCode, 404);
    assert.equal((await db.query('SELECT 1 FROM calendar_oauth_flows WHERE id = $1', [late.flowId])).rows.length, 0);
    // Without outgoing requests no flow starts.
    const { call: offline } = await appWith({ ...options, fetchEnabled: false });
    assert.equal((await offline('POST', '/calendar/oauth/start', { provider: 'microsoft' })).json().error, 'DISABLED');

    // Several calendars of one authorization: each gets a database and a source with its own copy of the tokens, all or none.
    fake.msScript = ['ready'];
    const multi = await startMicrosoft();
    await due2(multi.flowId);
    const multiReady = await flow(multi.flowId);
    assert.equal(multiReady.status, 'ready');
    const [calOne, calTwo] = multiReady.calendars;
    const sourceCount = async () => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM calendar_sync_sources')).rows[0]!.n;
    const pageCount = async () => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM pages')).rows[0]!.n;
    const counts = [await sourceCount(), await pageCount()];
    const multiBody = { clientMutationId: randomUUID(), flowId: multi.flowId, intervalMinutes: 60,
      calendars: [{ calendarUrl: calOne!.url, name: ' 工作 ' }, { calendarUrl: calTwo!.url, name: '生日' }] };
    const partly = await call('POST', '/calendar/oauth/sources', { ...multiBody, clientMutationId: randomUUID(),
      calendars: [multiBody.calendars[0], { calendarUrl: 'https://graph.microsoft.com/v1.0/me/calendars/AAMkNone/', name: '无' }] });
    assert.deepEqual([partly.statusCode, partly.json().error], [422, 'CALENDAR_NOT_FOUND']);
    const twice = await call('POST', '/calendar/oauth/sources', { ...multiBody, clientMutationId: randomUUID(),
      calendars: [multiBody.calendars[0], { calendarUrl: calOne!.url.replace(/\/$/, ''), name: '又一个' }] });
    assert.equal(twice.statusCode, 400, twice.body);
    assert.equal((await call('POST', '/calendar/oauth/sources', { ...multiBody, calendars: [] })).statusCode, 400);
    assert.deepEqual([await sourceCount(), await pageCount()], counts);
    assert.equal((await flow(multi.flowId)).status, 'ready');
    const both = await call('POST', '/calendar/oauth/sources', multiBody);
    assert.equal(both.statusCode, 201, both.body);
    const pair = (both.json() as CreateCalendarSourcesResponse).sources;
    assert.deepEqual(pair.map(s => [s.name, s.caldav?.calendarName, s.caldav?.writable, s.intervalMinutes]),
      [['工作', '日历', true, 60], ['生日', '生日', false, 60]]);
    assert.notEqual(pair[0]!.databaseId, pair[1]!.databaseId);
    assert.deepEqual((await call('POST', '/calendar/oauth/sources', multiBody)).json(), { sources: pair });
    assert.equal((await call('POST', '/calendar/oauth/sources', { ...multiBody, clientMutationId: randomUUID() })).json().error, 'FLOW_NOT_READY');
    const pairRows = await db.query<{ id: string; client_mutation_id: string; credential_cipher: Buffer; credential_key_id: string }>(
      'SELECT id, client_mutation_id, credential_cipher, credential_key_id FROM calendar_sync_sources WHERE id = ANY($1::uuid[])',
      [pair.map(s => s.id)]);
    assert.equal(new Set(pairRows.rows.map(r => r.client_mutation_id)).size, 2);
    assert.ok(pairRows.rows.some(r => r.client_mutation_id === multiBody.clientMutationId));
    for (const stored of pairRows.rows) {
      assert.equal(openTokens(key, stored.id, stored.credential_cipher, stored.credential_key_id)?.subject, 'm-bob');
    }
    assert.deepEqual([await sourceCount(), await pageCount()], [counts[0]! + 2, counts[1]! + 2]);

    // Deleting a source drops its tokens; then the app may go, with its flows.
    assert.equal((await call('DELETE', '/calendar/oauth/apps/microsoft')).json().error, 'OAUTH_APP_IN_USE');
    assert.equal((await call('DELETE', `/calendar/sync/${google.id}`)).statusCode, 204);
    assert.equal((await db.query('SELECT 1 FROM calendar_oauth_flows WHERE source_id = $1', [google.id])).rows.length, 0);
    assert.equal((await call('DELETE', '/calendar/oauth/apps/google')).statusCode, 204);
    assert.equal((await db.query(`SELECT 1 FROM calendar_oauth_flows WHERE workspace_id = $1 AND provider = 'google'`, [owner.workspaceId])).rows.length, 0);
    assert.equal(((await call('GET', '/calendar/oauth/apps')).json() as OAuthAppsResponse).google, null);
    assert.equal((await call('DELETE', '/calendar/oauth/apps/other')).statusCode, 404);

    // Viewers see the apps but do not change them.
    await db.query(`UPDATE workspace_memberships SET role = 'viewer' WHERE user_id = $1`, [owner.userId]);
    assert.equal((await call('GET', '/calendar/oauth/apps')).statusCode, 200);
    assert.equal((await call('PUT', '/calendar/oauth/apps/google', googleClient)).statusCode, 403);
    assert.equal((await call('POST', '/calendar/oauth/start', { provider: 'microsoft' })).statusCode, 403);
  } finally {
    for (const instance of apps) await instance.close();
    await mock.close();
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
