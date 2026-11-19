import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { googleOAuthCallbackPath, type CalendarSyncConflictsResponse, type CalendarSyncListResponse, type CalendarSyncSource,
  type CreateCalendarSourcesResponse, type DatabaseDocument, type OAuthFlowResponse, type PropertyDefinition,
  type StartOAuthResponse } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { OAuthTokens } from '../src/calendar/oauth/tokens.js';
import { claimDueSource, runSource, type CalendarSyncOptions } from '../src/calendar/scheduler.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';
import { credentialKeyFromText } from '../src/secrets/credentials.js';
import { icsText, MockCalDav } from './caldav-mock.js';
import { FakeProviders, googleClient, msClientId } from './oauth-mock.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local integration password only';
const key = credentialKeyFromText(Buffer.alloc(32, 13).toString('base64'));
const cst = (dateTime: string) => ({ dateTime, timeZone: 'China Standard Time' });

test('aggregate calendar on Google (CalDAV with OAuth) and Microsoft (Graph) accounts', {
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
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    const db = pool;
    await runMigrations(db);
    const owner = await initializeOwner(db, 'owner', await hashPassword(ownerPassword), '测试');
    await db.query(`UPDATE workspaces SET note_time_zone = 'Asia/Shanghai' WHERE id = $1`, [owner.workspaceId]);

    const work = mock.addCalendar('alice@gmail.test/events', { name: 'Alice', writable: true });
    mock.set(work, 'standup.ics', icsText([['UID:standup', 'DTSTART:20260310T010000Z', 'DTEND:20260310T013000Z', 'SUMMARY:站会']]));
    await mock.start();
    const outlook = fake.graph;
    outlook.addCalendar('AAMkCal1', '日历');
    outlook.addCalendar('AAMkCal2', '生日', false);
    outlook.add('AAMkCal1', { subject: '例会', start: cst('2026-03-11T09:00:00'), end: cst('2026-03-11T10:00:00') });

    let clock = Date.now();
    const tokens = new OAuthTokens(() => clock);
    const pages = new PgPageRepository(db);
    app = await buildApp({ auth: { repository: new PgAuthRepository(db), publicOrigin: origin }, pages, notesPool: db,
      calendar: { scheduler: false, credentialKey: key, oauthTransport: fake.transport, oauthTokens: tokens } });
    const instance = app;
    const login = await instance.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { loginName: 'owner', password: ownerPassword } });
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const write = { cookie, origin, 'x-csrf-token': login.json().csrfToken as string };
    const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown, extraCookie?: string) =>
      instance.inject({ method, url: `/api/workspaces/${owner.workspaceId}${path}`,
        headers: method === 'GET' ? { cookie } : { ...write, ...(extraCookie ? { cookie: `${cookie}; ${extraCookie}` } : {}) },
        ...(method === 'GET' ? {} : { payload: (payload ?? {}) as object }) });
    const syncOptions: CalendarSyncOptions = { fetchEnabled: true, credentialKey: key, oauthTransport: fake.transport, oauthTokens: tokens };
    const syncAll = async () => {
      for (let due = await claimDueSource(db); due; due = await claimDueSource(db)) await runSource(db, pages, due, syncOptions);
    };
    const listed = async (id: string) => ((await call('GET', '/calendar/sync')).json() as CalendarSyncListResponse).sources.find(s => s.id === id)!;
    const run = async (id: string, error: string | null = null) => {
      assert.equal((await call('POST', `/calendar/sync/${id}/run`)).statusCode, 202);
      await syncAll();
      const state = await listed(id);
      assert.equal(state.lastError, error, JSON.stringify(state));
      return state;
    };
    const database = async (id: string) => (await call('GET', `/databases/${id}`)).json() as DatabaseDocument;
    const row = async (databaseId: string, title: string) => {
      const found = (await database(databaseId)).rows.find(r => r.title === title);
      assert.ok(found, `row ${title}`);
      return found;
    };
    const bulk = async (databaseId: string, body: Record<string, unknown>) => {
      const response = await call('POST', `/databases/${databaseId}/rows/bulk`, { clientMutationId: randomUUID(), ...body });
      assert.equal(response.statusCode, 200, response.body);
      return response.json() as { rows: { id: string; revision: string }[] };
    };
    const patchRow = (databaseId: string, id: string, patch: { title?: string; properties?: Record<string, unknown> }) =>
      bulk(databaseId, { operation: 'patch', items: [{ id, ...patch }] });
    const caldavWrites = (from: number) => mock.requests.slice(from).filter(r => r.method === 'PUT' || r.method === 'DELETE');
    const names = () => [...mock.calendars.get(work)!.resources.keys()].sort();
    const holding = (summary: string) => names().filter(n => mock.body(work, n)!.includes(`SUMMARY:${summary}\r\n`));
    /** Revokes every grant of one account; cached access tokens run out. */
    const revoke = (subject: string) => {
      for (const [refresh, account] of fake.refreshTokens) if (account.sub === subject) fake.refreshTokens.delete(refresh);
      fake.access.clear();
      clock += 3600 * 1000;
    };
    const graphEvents = (summary?: string) => [...outlook.events.values()].filter(e => e.calendarId === 'AAMkCal1'
      && (summary === undefined || e.subject === summary));

    // Both accounts are connected through their OAuth flows, as in the dialog.
    assert.equal((await call('PUT', '/calendar/oauth/apps/google', googleClient)).statusCode, 200);
    assert.equal((await call('PUT', '/calendar/oauth/apps/microsoft', { clientId: msClientId, tenant: 'common' })).statusCode, 200);
    let binding = '';
    const authorizeGoogle = async (body: Record<string, unknown> = {}) => {
      const response = await call('POST', '/calendar/oauth/start', { provider: 'google', ...body }, binding || undefined);
      assert.equal(response.statusCode, 200, response.body);
      const started = response.json() as Extract<StartOAuthResponse, { provider: 'google' }>;
      binding ||= String(response.headers['set-cookie']).split(';', 1)[0]!;
      const state = new URL(started.authorizeUrl).searchParams.get('state')!;
      const done = await instance.inject({ method: 'GET', headers: { cookie: binding },
        url: `${googleOAuthCallbackPath}?${new URLSearchParams({ state, code: fake.authorize(started.authorizeUrl) })}` });
      assert.equal(done.statusCode, 200, done.body);
      const flow = (await call('GET', `/calendar/oauth/flows/${started.flowId}`)).json() as OAuthFlowResponse;
      assert.equal(flow.status, 'ready');
      return { ...flow, flowId: started.flowId };
    };
    const authorizeMicrosoft = async (body: Record<string, unknown> = {}) => {
      const response = await call('POST', '/calendar/oauth/start', { provider: 'microsoft', ...body });
      assert.equal(response.statusCode, 200, response.body);
      const started = response.json() as Extract<StartOAuthResponse, { provider: 'microsoft' }>;
      fake.msScript = ['ready'];
      await db.query('UPDATE calendar_oauth_flows SET next_poll_at = now() WHERE id = $1', [started.flowId]);
      const flow = (await call('GET', `/calendar/oauth/flows/${started.flowId}`)).json() as OAuthFlowResponse;
      assert.equal(flow.status, 'ready');
      return { ...flow, flowId: started.flowId };
    };
    const connect = async (flow: { flowId: string }, chosen: [url: string, title: string][]) => {
      const response = await call('POST', '/calendar/oauth/sources', { clientMutationId: randomUUID(), flowId: flow.flowId, intervalMinutes: 60,
        calendars: chosen.map(([calendarUrl, title]) => ({ calendarUrl, name: title })) });
      assert.equal(response.statusCode, 201, response.body);
      return (response.json() as CreateCalendarSourcesResponse).sources;
    };
    const googleFlow = await authorizeGoogle();
    const [google] = await connect(googleFlow, [[googleFlow.calendars[0]!.url, 'Google 日历']]) as [CalendarSyncSource];
    // One flow per calendar: the fake Microsoft endpoint, unlike Microsoft, refuses a refresh token once it has been rotated.
    const msFlow = await authorizeMicrosoft();
    const [microsoft] = await connect(msFlow, [[msFlow.calendars[0]!.url, 'Outlook']]) as [CalendarSyncSource];
    const birthdayFlow = await authorizeMicrosoft();
    const [birthdays] = await connect(birthdayFlow, [[birthdayFlow.calendars[1]!.url, '生日']]) as [CalendarSyncSource];
    assert.deepEqual([google.caldav?.provider, microsoft.caldav?.provider, birthdays.caldav?.writable], ['google', 'microsoft', false]);

    // An ordinary database with dates; a row without a date is not pushed.
    const doc = (await call('POST', '/databases', { clientMutationId: randomUUID(), parentId: null, title: '项目' })).json() as DatabaseDocument;
    const date: PropertyDefinition = { id: randomUUID(), name: '日期', type: 'date' };
    assert.equal((await call('PATCH', `/databases/${doc.page.id}`, { clientMutationId: randomUUID(), expectedRevision: doc.schemaRevision,
      properties: [...doc.properties, date], views: doc.views })).statusCode, 200);
    const project = doc.page.id;
    const reviewValue = '2026-03-06T02:00:00Z/2026-03-06T03:00:00Z|tz=Asia/Shanghai';
    await bulk(project, { operation: 'create', rows: [
      { title: '交付', properties: { [date.id]: '2026-03-05' } },
      { title: '周报', properties: { [date.id]: '2026-03-02|rrule=FREQ=WEEKLY;COUNT=3' } },
      { title: '评审', properties: { [date.id]: reviewValue } },
      { title: '草稿', properties: {} },
    ] });
    await syncAll();
    for (const id of [google.id, microsoft.id, birthdays.id]) assert.equal((await listed(id)).lastError, null);

    // A read-only account calendar cannot be the aggregate; a writable Google calendar can.
    assert.equal((await call('PATCH', `/calendar/sync/${birthdays.id}`, { aggregate: true })).json().error, 'SYNC_KIND_INVALID');
    const enabled = await call('PATCH', `/calendar/sync/${google.id}`, { aggregate: true });
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.deepEqual([(enabled.json() as CalendarSyncSource).caldav?.provider, (enabled.json() as CalendarSyncSource).caldav?.aggregate], ['google', true]);

    // Google: every dated row goes to the calendar with the bearer token, without If-None-Match.
    let mark = mock.requests.length;
    let state = await run(google.id);
    assert.equal(state.lastCounts?.pushed, 3, JSON.stringify(state.lastCounts));
    assert.ok(caldavWrites(mark).every(r => r.method === 'PUT' && r.ifNoneMatch === undefined && r.ifMatch === undefined));
    assert.equal(names().length, 4);
    assert.match(mock.body(work, holding('交付')[0]!)!, /DTSTART;VALUE=DATE:20260305/);
    assert.match(mock.body(work, holding('周报')[0]!)!, /RRULE:FREQ=WEEKLY;COUNT=3/);
    assert.equal(holding('草稿').length, 0);
    assert.deepEqual((await database(google.databaseId)).rows.map(r => r.title), ['站会']);
    mark = mock.requests.length;
    state = await run(google.id);
    assert.deepEqual([state.lastCounts?.created, state.lastCounts?.updated, state.lastCounts?.pushed], [0, 0, 0]);
    assert.equal(caldavWrites(mark).length, 0);

    // External edits come back into the row; local edits go out with If-Match and keep the external location.
    const [delivery] = holding('交付');
    const deliveryUid = /UID:([^\r]+)/.exec(mock.body(work, delivery!)!)![1]!;
    mock.set(work, delivery!, icsText([[`UID:${deliveryUid}`, 'DTSTART;VALUE=DATE:20260306', 'DTEND;VALUE=DATE:20260307', 'SUMMARY:交付（Google 改）',
      'LOCATION:外部地点']]));
    state = await run(google.id);
    assert.equal(state.lastCounts?.updated, 1);
    let deliveryRow = await row(project, '交付（Google 改）');
    assert.equal(deliveryRow.properties[date.id], '2026-03-06');
    await patchRow(project, deliveryRow.id, { title: '交付（本地）' });
    mark = mock.requests.length;
    state = await run(google.id);
    assert.equal(state.lastCounts?.pushed, 1);
    assert.ok(caldavWrites(mark)[0]?.ifMatch);
    assert.match(mock.body(work, delivery!)!, /SUMMARY:交付（本地）/);
    assert.match(mock.body(work, delivery!)!, /LOCATION:外部地点/);

    // Both sides changed: a conflict with a copy in the project database, resolved for the NBase side.
    deliveryRow = await row(project, '交付（本地）');
    await patchRow(project, deliveryRow.id, { title: '交付（本地二）' });
    mock.set(work, delivery!, mock.body(work, delivery!)!.replace('SUMMARY:交付（本地）', 'SUMMARY:交付（Google 二）'));
    mark = mock.requests.length;
    state = await run(google.id);
    assert.equal(state.lastCounts?.conflicts, 1);
    assert.equal(caldavWrites(mark).length, 0);
    const googleConflicts = ((await call('GET', `/calendar/sync/${google.id}/conflicts`)).json() as CalendarSyncConflictsResponse).conflicts;
    assert.deepEqual(googleConflicts.map(c => [c.kind, c.local?.title, c.remote?.title]), [['both-changed', '交付（本地二）', '交付（Google 二）']]);
    assert.equal((await row(project, '交付（Google 二）')).id, googleConflicts[0]!.copyRowId);
    assert.equal((await call('POST', `/calendar/sync/${google.id}/conflicts/${deliveryRow.id}`, { choice: 'local' })).statusCode, 200);
    state = await run(google.id);
    assert.equal(state.lastCounts?.pushed, 1);
    assert.match(mock.body(work, delivery!)!, /SUMMARY:交付（本地二）/);

    // A cleared date deletes the event; an event deleted in Google trashes the row.
    await patchRow(project, deliveryRow.id, { properties: { [date.id]: null } });
    mark = mock.requests.length;
    await run(google.id);
    assert.deepEqual(caldavWrites(mark).map(r => r.method), ['DELETE']);
    assert.equal(holding('交付（本地二）').length, 0);
    await patchRow(project, deliveryRow.id, { properties: { [date.id]: '2026-03-08' } });
    assert.equal((await run(google.id)).lastCounts?.pushed, 1);
    mock.remove(work, holding('交付（本地二）')[0]!);
    state = await run(google.id);
    assert.equal(state.lastCounts?.removed, 1);
    assert.ok(!(await database(project)).rows.some(r => r.id === deliveryRow.id));

    // A lost access token is renewed once.
    fake.access.clear();
    const refreshes = fake.counts.refresh;
    await run(google.id);
    assert.equal(fake.counts.refresh, refreshes + 1);

    // A revoked grant stops the aggregate like any Google source: nothing is written, the aggregate stays set,
    // and once authorized again the change made meanwhile goes out.
    const review = await row(project, '评审');
    await patchRow(project, review.id, { title: '评审（授权失效时改）' });
    revoke('g-alice');
    mark = mock.requests.length;
    state = await run(google.id, 'AUTH_FAILED');
    assert.equal(state.caldav?.aggregate, true);
    assert.equal(caldavWrites(mark).length, 0);
    assert.equal((await row(project, '评审（授权失效时改）')).properties[date.id], reviewValue);
    const again = await authorizeGoogle({ sourceId: google.id });
    assert.equal(again.source?.id, google.id);
    await syncAll();
    state = await listed(google.id);
    assert.deepEqual([state.lastError, state.caldav?.aggregate], [null, true]);
    assert.equal(holding('评审（授权失效时改）').length, 1);

    // Moving the aggregate to the Outlook calendar empties Google and fills Outlook through Graph.
    const moved = await call('PATCH', `/calendar/sync/${microsoft.id}`, { aggregate: true });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal((await listed(google.id)).caldav?.aggregate, false);
    let graphMark = outlook.requests.length;
    await syncAll();
    assert.equal((await listed(microsoft.id)).lastError, null);
    assert.deepEqual(names(), ['standup.ics']);
    assert.deepEqual(outlook.writes(graphMark).map(w => [w.method, w.path]), [['POST', 'me/calendars/AAMkCal1/events'], ['POST', 'me/calendars/AAMkCal1/events']]);
    assert.deepEqual(graphEvents().map(e => e.subject).sort(), ['例会', '周报', '评审（授权失效时改）'].sort());
    const [weekly] = graphEvents('周报');
    assert.equal(weekly!.type, 'seriesMaster');
    assert.equal(weekly!.isAllDay, true);
    const [reviewEvent] = graphEvents('评审（授权失效时改）');
    assert.deepEqual([reviewEvent!.start.ms, reviewEvent!.end.ms], [Date.parse('2026-03-06T02:00:00Z'), Date.parse('2026-03-06T03:00:00Z')]);
    // The Outlook calendar's own event stays in its own database; Graph's own names for events do not bring changes back.
    assert.deepEqual((await database(microsoft.databaseId)).rows.map(r => r.title), ['例会']);
    for (let i = 0; i < 2; i++) {
      graphMark = outlook.requests.length;
      state = await run(microsoft.id);
      assert.deepEqual([state.lastCounts?.created, state.lastCounts?.updated, state.lastCounts?.removed, state.lastCounts?.pushed,
        state.lastCounts?.conflicts], [0, 0, 0, 0, 0], JSON.stringify(state.lastCounts));
      assert.equal(outlook.writes(graphMark).length, 0);
    }
    assert.equal((await row(project, '评审（授权失效时改）')).properties[date.id], reviewValue);
    assert.equal((await row(project, '周报')).properties[date.id], '2026-03-02|rrule=FREQ=WEEKLY;COUNT=3');
    const aggregateItems = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM calendar_sync_items WHERE source_id = $1 AND database_id = $2',
      [microsoft.id, project]);
    assert.equal(aggregateItems.rows[0]!.n, 2);

    // An Outlook edit reaches the row; a local edit goes out as PATCH with If-Match and only the subject.
    outlook.update(reviewEvent!, { subject: '评审（Outlook 改）', location: 'Teams' });
    state = await run(microsoft.id);
    assert.equal(state.lastCounts?.updated, 1);
    let reviewRow = await row(project, '评审（Outlook 改）');
    assert.equal(reviewRow.properties[date.id], reviewValue);
    assert.deepEqual(Object.keys(reviewRow.properties), [date.id]);
    await patchRow(project, reviewRow.id, { title: '评审（本地）' });
    const etag = reviewEvent!.etag;
    graphMark = outlook.requests.length;
    state = await run(microsoft.id);
    assert.equal(state.lastCounts?.pushed, 1);
    const patch = outlook.writes(graphMark);
    assert.deepEqual(patch.map(w => [w.method, w.path, w.ifMatch, w.body]), [['PATCH', `me/events/${reviewEvent!.id}`, etag, { subject: '评审（本地）' }]]);
    assert.deepEqual([reviewEvent!.subject, reviewEvent!.location], ['评审（本地）', 'Teams']);

    // Both sides changed: a conflict, resolved for the Outlook side without writing anything.
    reviewRow = await row(project, '评审（本地）');
    await patchRow(project, reviewRow.id, { title: '评审（本地二）' });
    outlook.update(reviewEvent!, { subject: '评审（Outlook 二）' });
    graphMark = outlook.requests.length;
    state = await run(microsoft.id);
    assert.equal(state.lastCounts?.conflicts, 1);
    assert.equal(outlook.writes(graphMark).length, 0);
    const msConflicts = ((await call('GET', `/calendar/sync/${microsoft.id}/conflicts`)).json() as CalendarSyncConflictsResponse).conflicts;
    assert.deepEqual(msConflicts.map(c => [c.kind, c.rowId, c.local?.title, c.remote?.title, c.local?.value]),
      [['both-changed', reviewRow.id, '评审（本地二）', '评审（Outlook 二）', reviewValue]]);
    assert.equal((await row(project, '评审（Outlook 二）')).id, msConflicts[0]!.copyRowId);
    assert.equal((await call('POST', `/calendar/sync/${microsoft.id}/conflicts/${reviewRow.id}`, { choice: 'remote' })).statusCode, 200);
    assert.deepEqual((await database(project)).rows.filter(r => r.title.startsWith('评审')).map(r => r.title), ['评审（Outlook 二）']);
    graphMark = outlook.requests.length;
    state = await run(microsoft.id);
    assert.deepEqual([state.lastCounts?.pushed, state.lastCounts?.conflicts, outlook.writes(graphMark).length], [0, 0, 0]);

    // Attendees added in Outlook: the row stays editable here, but its changes are not written back.
    reviewEvent!.attendees = [{ type: 'required', emailAddress: { name: 'Carol', address: 'carol@example.test' } }];
    outlook.touch(reviewEvent!);
    await run(microsoft.id);
    reviewRow = await row(project, '评审（Outlook 二）');
    assert.equal((await database(project)).calendarSync, undefined);
    await patchRow(project, reviewRow.id, { title: '评审（有参会人）' });
    graphMark = outlook.requests.length;
    await run(microsoft.id);
    assert.equal(outlook.writes(graphMark).length, 0);
    assert.equal(reviewEvent!.subject, '评审（Outlook 二）');

    // New rows are created by POST; a cleared date deletes; a deletion in Outlook trashes the row.
    const releaseId = (await bulk(project, { operation: 'create', rows: [{ title: '发布', properties: { [date.id]: '2026-03-25' } }] })).rows[0]!.id;
    graphMark = outlook.requests.length;
    await run(microsoft.id);
    assert.deepEqual(outlook.writes(graphMark).map(w => w.method), ['POST']);
    let [release] = graphEvents('发布');
    assert.ok(release);
    await patchRow(project, releaseId, { properties: { [date.id]: null } });
    graphMark = outlook.requests.length;
    await run(microsoft.id);
    assert.deepEqual(outlook.writes(graphMark).map(w => [w.method, w.path]), [['DELETE', `me/events/${release!.id}`]]);
    assert.equal(graphEvents('发布').length, 0);
    await patchRow(project, releaseId, { properties: { [date.id]: '2026-03-26' } });
    await run(microsoft.id);
    [release] = graphEvents('发布');
    assert.ok(release);
    outlook.events.delete(release!.id);
    state = await run(microsoft.id);
    assert.equal(state.lastCounts?.removed, 1);
    assert.ok(!(await database(project)).rows.some(r => r.id === releaseId));

    // A changed occurrence in Outlook joins the series' database; trashing the series deletes it in Outlook with its occurrence.
    outlook.addException(weekly!, '2026-03-09', { subject: '周报（改期）' });
    state = await run(microsoft.id);
    assert.equal(state.lastCounts?.created, 1, JSON.stringify(state.lastCounts));
    assert.ok(await row(project, '周报（改期）'));
    assert.deepEqual((await database(microsoft.databaseId)).rows.map(r => r.title), ['例会']);
    graphMark = outlook.requests.length;
    await bulk(project, { operation: 'trash', ids: [(await row(project, '周报')).id] });
    await run(microsoft.id);
    assert.deepEqual(outlook.writes(graphMark).map(w => [w.method, w.path]), [['DELETE', `me/events/${weekly!.id}`]]);
    assert.ok(!(await database(project)).rows.some(r => r.title.startsWith('周报')));

    // A revoked Microsoft grant: the aggregate waits for authorization again, then continues.
    await bulk(project, { operation: 'create', rows: [{ title: '复盘', properties: { [date.id]: '2026-03-27' } }] });
    revoke('m-bob');
    graphMark = outlook.requests.length;
    state = await run(microsoft.id, 'AUTH_FAILED');
    assert.equal(state.caldav?.aggregate, true);
    assert.equal(outlook.writes(graphMark).length, 0);
    const msAgain = await authorizeMicrosoft({ sourceId: microsoft.id });
    assert.equal(msAgain.source?.id, microsoft.id);
    await syncAll();
    assert.equal((await listed(microsoft.id)).lastError, null);
    assert.equal(graphEvents('复盘').length, 1);

    // Turning the aggregate off deletes its events in Outlook; the rows and the calendar's own event stay.
    assert.equal((await call('PATCH', `/calendar/sync/${microsoft.id}`, { aggregate: false })).statusCode, 200);
    await syncAll();
    assert.deepEqual(graphEvents().map(e => e.subject), ['例会']);
    assert.deepEqual((await database(project)).rows.map(r => r.title).sort(), ['复盘', '草稿', '评审（有参会人）'].sort());
    const left = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM calendar_sync_items WHERE database_id IS NOT NULL');
    assert.equal(left.rows[0]!.n, 0);

    // The constraint admits account sources of every provider and still refuses imports and subscriptions.
    await db.query('UPDATE calendar_sync_sources SET aggregate_user_id = $2 WHERE id = $1', [google.id, owner.userId]);
    await db.query('UPDATE calendar_sync_sources SET aggregate_user_id = NULL WHERE id = $1', [google.id]);
    const ics = await call('POST', '/calendar/import', { clientMutationId: randomUUID(), target: { parentId: null, name: '导入' },
      ics: icsText([['UID:one', 'DTSTART;VALUE=DATE:20260401', 'SUMMARY:导入事件']]) });
    assert.ok(ics.statusCode === 200 || ics.statusCode === 201, ics.body);
    const icsId = (ics.json() as { source: CalendarSyncSource }).source.id;
    await assert.rejects(db.query('UPDATE calendar_sync_sources SET aggregate_user_id = $2 WHERE id = $1', [icsId, owner.userId]),
      /calendar_sync_sources_aggregate/);
    assert.equal((await call('PATCH', `/calendar/sync/${icsId}`, { aggregate: true })).json().error, 'SYNC_KIND_INVALID');
  } finally {
    await app?.close();
    await mock.close();
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
