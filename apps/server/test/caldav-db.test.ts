import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { CalDavDiscoverResponse, CalendarEventsResponse, CalendarSyncConflictsResponse, CalendarSyncListResponse, CalendarSyncSource,
  CreateCalendarSourcesResponse, DatabaseDocument, ResolveCalendarConflictResponse } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { claimDueSource, runCaldav, runSource, type CalendarSyncOptions } from '../src/calendar/scheduler.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';
import { credentialKeyFromText } from '../src/secrets/credentials.js';
import { icsText, MockCalDav } from './caldav-mock.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local integration password only';
const key = credentialKeyFromText(Buffer.alloc(32, 3).toString('base64'));
const otherKey = credentialKeyFromText(Buffer.alloc(32, 5).toString('base64'));

test('CalDAV sources: discovery, two-way sync, conflicts, attendee and read-only locks, credentials', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const admin = new pg.Pool({ connectionString: sourceUrl, max: 2 });
  const name = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  const mock = new MockCalDav();
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

    const work = mock.addCalendar('work', { name: '工作', writable: true, color: '#3366FF' });
    const holidays = mock.addCalendar('holidays', { name: '节假日', writable: false });
    mock.set(work, 'standup.ics', icsText([['UID:standup', 'DTSTART:20260310T010000Z', 'DTEND:20260310T013000Z', 'SUMMARY:站会', 'LOCATION:一号会议室']]));
    mock.set(work, 'trip.ics', icsText([['UID:trip', 'DTSTART;VALUE=DATE:20260312', 'DTEND;VALUE=DATE:20260314', 'SUMMARY:出差']]));
    mock.set(work, 'review.ics', icsText([['UID:review', 'DTSTART:20260311T060000Z', 'DTEND:20260311T070000Z', 'SUMMARY:评审会',
      'ORGANIZER:mailto:carol@example.test', 'ATTENDEE;CN=Bob:mailto:bob@example.test']]));
    mock.set(work, 'weekly.ics', icsText([
      ['UID:weekly', 'DTSTART:20260302T010000Z', 'DTEND:20260302T020000Z', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:周会'],
      ['UID:weekly', 'RECURRENCE-ID:20260309T010000Z', 'DTSTART:20260309T020000Z', 'DTEND:20260309T030000Z', 'SUMMARY:周会（推迟）'],
    ]));
    mock.set(holidays, 'newyear.ics', icsText([['UID:newyear', 'DTSTART;VALUE=DATE:20260101', 'DTEND;VALUE=DATE:20260102', 'SUMMARY:元旦']]));
    await mock.start();

    const pages = new PgPageRepository(pool);
    const auth = new PgAuthRepository(pool);
    const appWith = async (calendar: NonNullable<NonNullable<Parameters<typeof buildApp>[0]>['calendar']>) => {
      const instance = await buildApp({ auth: { repository: auth, publicOrigin: origin }, pages, notesPool: db, calendar });
      apps.push(instance);
      const login = await instance.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { loginName: 'owner', password: ownerPassword } });
      const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
      const write = { cookie, origin, 'x-csrf-token': login.json().csrfToken as string };
      return (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown) =>
        instance.inject({ method, url: `/api/workspaces/${owner.workspaceId}${path}`, headers: method === 'GET' ? { cookie } : write,
          ...(method === 'GET' ? {} : { payload: (payload ?? {}) as object }) });
    };
    const call = await appWith({ scheduler: false, credentialKey: key, caldavPrivate: true });
    const syncOptions: CalendarSyncOptions = { fetchEnabled: true, credentialKey: key, caldavPrivate: true };
    const database = async (id: string) => (await call('GET', `/databases/${id}`)).json() as DatabaseDocument;
    const row = async (databaseId: string, title: string) => {
      const found = (await database(databaseId)).rows.find(r => r.title === title);
      assert.ok(found, `row ${title}`);
      return found;
    };
    const patchRow = (target: { id: string; revision: number | string }, patch: Record<string, unknown>) =>
      call('PATCH', `/pages/${target.id}`, { clientMutationId: randomUUID(), expectedRevision: target.revision, ...patch });
    const bulk = (databaseId: string, body: Record<string, unknown>) =>
      call('POST', `/databases/${databaseId}/rows/bulk`, { clientMutationId: randomUUID(), ...body });
    const listed = async (id: string) => ((await call('GET', '/calendar/sync')).json() as CalendarSyncListResponse).sources.find(s => s.id === id)!;
    const syncAll = async (options = syncOptions) => {
      for (let due = await claimDueSource(db); due; due = await claimDueSource(db)) await runSource(db, pages, due, options);
    };
    const run = async (id: string, options = syncOptions) => {
      assert.equal((await call('POST', `/calendar/sync/${id}/run`)).statusCode, 202);
      await syncAll(options);
      return listed(id);
    };
    const writes = (from: number) => mock.requests.slice(from).filter(r => r.method === 'PUT' || r.method === 'DELETE');
    const synced = (response: Awaited<ReturnType<typeof call>>) => {
      assert.equal(response.statusCode, 422, response.body);
      assert.deepEqual(response.json(), { error: 'PROPERTY_INVALID', reason: 'property-synced' });
    };
    const account = { serverUrl: mock.origin, username: mock.username, password: mock.password };

    // Without a credential key the CalDAV routes refuse to store anything.
    const keyless = await appWith({ scheduler: false, caldavPrivate: true });
    const noKey = await keyless('POST', '/calendar/caldav/discover', account);
    assert.equal(noKey.statusCode, 503, noKey.body);
    assert.equal(noKey.json().error, 'CREDENTIALS_UNAVAILABLE');

    // Discovery lists the event calendars with what the account may do.
    assert.equal((await call('POST', '/calendar/caldav/discover', { ...account, password: 'wrong' })).json().error, 'AUTH_FAILED');
    assert.equal((await call('POST', '/calendar/caldav/discover', { ...account, extra: 1 })).statusCode, 400);
    const discovered = await call('POST', '/calendar/caldav/discover', account);
    assert.equal(discovered.statusCode, 200, discovered.body);
    const calendars = (discovered.json() as CalDavDiscoverResponse).calendars;
    assert.deepEqual(calendars.map(c => [c.name, c.writable, c.color]), [['工作', true, '#3366ff'], ['节假日', false, null]]);

    // Creating sources checks every calendar against the account and makes all or none; retries replay the first answer.
    const sourceCount = async () => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM calendar_sync_sources')).rows[0]!.n;
    const workChoice = { calendarUrl: calendars[0]!.url, name: '工作日历' };
    assert.equal((await call('POST', '/calendar/caldav', { ...account, clientMutationId: randomUUID(), parentId: null, intervalMinutes: 15,
      calendars: [workChoice, { calendarUrl: mock.url('/dav/calendars/alice/none/'), name: 'x' }] })).json().error, 'CALENDAR_NOT_FOUND');
    assert.equal((await call('POST', '/calendar/caldav', { ...account, clientMutationId: randomUUID(), parentId: null, intervalMinutes: 15,
      calendars: [workChoice, { ...workChoice, name: '又一个' }] })).statusCode, 400);
    assert.equal((await call('POST', '/calendar/caldav', { ...account, clientMutationId: randomUUID(), parentId: null, intervalMinutes: 15,
      calendarUrl: workChoice.calendarUrl, name: workChoice.name })).statusCode, 400);
    assert.equal(await sourceCount(), 0);
    const createBody = { ...account, clientMutationId: randomUUID(), calendars: [workChoice], parentId: null, intervalMinutes: 15 };
    const createdSource = await call('POST', '/calendar/caldav', createBody);
    assert.equal(createdSource.statusCode, 201, createdSource.body);
    assert.ok(!createdSource.body.includes(mock.password) && !createdSource.body.includes(mock.username));
    const createdSources = (createdSource.json() as CreateCalendarSourcesResponse).sources;
    assert.equal(createdSources.length, 1);
    const caldav = createdSources[0]!;
    assert.equal(caldav.kind, 'caldav');
    assert.deepEqual(caldav.caldav, { provider: 'caldav', account: null, serverHost: '127.0.0.1', calendarName: '工作', writable: true, credentialsOk: true, conflictCount: 0, aggregate: false });
    assert.deepEqual(caldav.readOnlyPropertyIds, [caldav.fields.uidId]);
    const replay = await call('POST', '/calendar/caldav', createBody);
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.json(), { sources: [caldav] });
    const stored = await db.query<{ credential_cipher: Buffer; credential_key_id: string }>(
      'SELECT credential_cipher, credential_key_id FROM calendar_sync_sources WHERE id = $1', [caldav.id]);
    assert.equal(stored.rows[0]!.credential_key_id, key.id);
    assert.ok(!stored.rows[0]!.credential_cipher.includes(Buffer.from(mock.password)));
    const receipts = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM page_mutation_receipts WHERE response_json::text LIKE $1`,
      [`%${mock.password}%`]);
    assert.equal(receipts.rows[0]!.n, 0);
    const workDb = caldav.databaseId;
    const fields = caldav.fields;

    // The first run reads every event; a changed occurrence becomes a row of its own.
    let state = await run(caldav.id);
    assert.equal(state.lastError, null);
    assert.equal(state.lastCounts?.created, 5, JSON.stringify(state));
    assert.equal(state.lastCounts?.pushed, 0);
    let doc = await database(workDb);
    assert.deepEqual(doc.rows.map(r => r.title).sort(), ['出差', '周会', '周会（推迟）', '站会', '评审会'].sort());
    const review = await row(workDb, '评审会');
    assert.equal(review.properties[fields.uidId], 'review');
    assert.deepEqual(doc.calendarSync?.readOnlyRowIds, [review.id]);
    assert.equal((await row(workDb, '周会（推迟）')).properties[fields.uidId], 'weekly#2026-03-09T01:00:00Z');

    // Events with attendees keep their synced fields; the external ID is never edited by hand.
    synced(await patchRow(review, { title: '评审会（改）' }));
    synced(await bulk(workDb, { operation: 'patch', items: [{ id: review.id, properties: { [fields.dateId]: '2026-03-12' } }] }));
    let standup = await row(workDb, '站会');
    synced(await patchRow(standup, { properties: { [fields.uidId]: 'other' } }));
    await call('PUT', '/calendar/settings', { sources: [{ databaseId: workDb, propertyId: fields.dateId, color: 'blue', visible: true }],
      showDailyNotes: false, defaultDatabaseId: workDb });
    const events = (await call('POST', '/calendar/events', { from: '2026-03-01', to: '2026-03-31' })).json() as CalendarEventsResponse;
    assert.equal(events.events.find(e => e.rowId === review.id)?.readOnly, true);
    assert.equal(events.events.find(e => e.rowId === standup.id)?.readOnly, false);

    // Local edits, deletions and new rows are written back; an edit brings the next run forward.
    const edited = await patchRow(standup, { title: '站会（改）' });
    assert.equal(edited.statusCode, 200, edited.body);
    const soon = await db.query<{ soon: boolean }>(`SELECT next_run_at <= now() + interval '31 seconds' AS soon FROM calendar_sync_sources WHERE id = $1`,
      [caldav.id]);
    assert.equal(soon.rows[0]!.soon, true);
    const trip = await row(workDb, '出差');
    const moved = await row(workDb, '周会（推迟）');
    assert.equal((await bulk(workDb, { operation: 'trash', ids: [trip.id, moved.id] })).statusCode, 200);
    const added = await bulk(workDb, { operation: 'create', rows: [{ title: '新事件', properties: { [fields.dateId]: '2026-03-20' } }] });
    assert.equal(added.statusCode, 200, added.body);
    let mark = mock.requests.length;
    state = await run(caldav.id);
    assert.equal(state.lastError, null);
    assert.equal(state.lastCounts?.pushed, 4, JSON.stringify(state.lastCounts));
    assert.deepEqual(writes(mark).map(r => r.method).sort(), ['DELETE', 'PUT', 'PUT', 'PUT']);
    assert.match(mock.body(work, 'standup.ics')!, /SUMMARY:站会（改）/);
    assert.match(mock.body(work, 'standup.ics')!, /SEQUENCE:1/);
    assert.equal(mock.body(work, 'trip.ics'), undefined);
    const weekly = mock.body(work, 'weekly.ics')!;
    assert.match(weekly, /EXDATE:20260309T010000Z/);
    assert.doesNotMatch(weekly, /RECURRENCE-ID/);
    const fresh = [...mock.calendars.get(work)!.resources.keys()].filter(n => !['standup.ics', 'review.ics', 'weekly.ics'].includes(n));
    assert.equal(fresh.length, 1);
    const freshBody = mock.body(work, fresh[0]!)!;
    assert.match(freshBody, /SUMMARY:新事件/);
    assert.match(freshBody, /DTSTART;VALUE=DATE:20260320/);
    const newRow = await row(workDb, '新事件');
    assert.equal(newRow.properties[fields.uidId], /UID:([^\r]+)/.exec(freshBody)![1]);
    assert.match(String(newRow.properties[fields.uidId]), /^[0-9a-f-]{36}@nbase$/);
    const put = writes(mark).find(r => r.path.endsWith(fresh[0]!));
    assert.equal(put?.ifNoneMatch, '*');
    assert.ok(writes(mark).filter(r => r !== put).every(r => r.ifMatch));

    // Our own writes do not come back as changes.
    mark = mock.requests.length;
    state = await run(caldav.id);
    assert.deepEqual([state.lastCounts?.created, state.lastCounts?.updated, state.lastCounts?.removed, state.lastCounts?.pushed], [0, 0, 0, 0]);
    assert.equal(writes(mark).length, 0);
    assert.ok(!mock.requests.slice(mark).some(r => r.method === 'REPORT' && r.body.includes('calendar-multiget')));

    // External edits and deletions reach the rows.
    mock.set(work, 'review.ics', mock.body(work, 'review.ics')!.replace('SUMMARY:评审会', 'SUMMARY:评审会（外部改）'));
    mock.remove(work, fresh[0]!);
    state = await run(caldav.id);
    assert.equal(state.lastCounts?.updated, 1);
    assert.equal(state.lastCounts?.removed, 1);
    doc = await database(workDb);
    assert.deepEqual(doc.rows.map(r => r.title).sort(), ['周会', '站会（改）', '评审会（外部改）'].sort());

    // Both sides changed: the row keeps the NBase version, a copy holds the external one, writing pauses.
    standup = await row(workDb, '站会（改）');
    assert.equal((await patchRow(standup, { properties: { [fields.locationId]: '二号会议室' } })).statusCode, 200);
    mock.set(work, 'standup.ics', mock.body(work, 'standup.ics')!.replace('SUMMARY:站会（改）', 'SUMMARY:站会（外部改）'));
    mark = mock.requests.length;
    state = await run(caldav.id);
    assert.equal(state.lastCounts?.conflicts, 1);
    assert.equal(state.caldav?.conflictCount, 1);
    assert.equal(writes(mark).length, 0);
    let conflicts = ((await call('GET', `/calendar/sync/${caldav.id}/conflicts`)).json() as CalendarSyncConflictsResponse).conflicts;
    assert.equal(conflicts.length, 1);
    const conflict = conflicts[0]!;
    assert.equal(conflict.kind, 'both-changed');
    assert.equal(conflict.rowId, standup.id);
    assert.equal(conflict.local?.location, '二号会议室');
    assert.equal(conflict.remote?.title, '站会（外部改）');
    const copy = (await database(workDb)).rows.find(r => r.id === conflict.copyRowId);
    assert.equal(copy?.title, '站会（外部改）');
    // Writing waits for the conflict: further local edits stay local.
    mark = mock.requests.length;
    state = await run(caldav.id);
    assert.equal(writes(mark).length, 0);
    assert.equal(state.caldav?.conflictCount, 1);
    assert.equal((await call('POST', `/calendar/sync/${caldav.id}/conflicts/${randomUUID()}`, { choice: 'local' })).statusCode, 404);
    assert.equal((await call('POST', `/calendar/sync/${caldav.id}/conflicts/${standup.id}`, { choice: 'nope' })).statusCode, 400);
    await db.query(`UPDATE calendar_sync_sources SET status = 'running', running_since = now() WHERE id = $1`, [caldav.id]);
    assert.equal((await call('POST', `/calendar/sync/${caldav.id}/conflicts/${standup.id}`, { choice: 'local' })).json().error, 'SYNC_RUNNING');
    await db.query(`UPDATE calendar_sync_sources SET status = 'idle', running_since = NULL WHERE id = $1`, [caldav.id]);
    const resolved = await call('POST', `/calendar/sync/${caldav.id}/conflicts/${standup.id}`, { choice: 'local' });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal((resolved.json() as ResolveCalendarConflictResponse).source.caldav?.conflictCount, 0);
    assert.equal((await database(workDb)).rows.some(r => r.id === conflict.copyRowId), false);
    state = await run(caldav.id);
    assert.equal(state.lastCounts?.pushed, 1);
    assert.match(mock.body(work, 'standup.ics')!, /SUMMARY:站会（改）/);
    assert.match(mock.body(work, 'standup.ics')!, /LOCATION:二号会议室/);

    // The server changed the event meanwhile (412): it is read again, and the write retried with what it kept.
    standup = await row(workDb, '站会（改）');
    assert.equal((await patchRow(standup, { properties: { [fields.descriptionId]: '带上电脑' } })).statusCode, 200);
    mock.beforeWrite = () => mock.set(work, 'standup.ics', mock.body(work, 'standup.ics')!.replace('END:VEVENT', 'X-NOTE:外部备注\r\nEND:VEVENT'));
    mark = mock.requests.length;
    state = await run(caldav.id);
    assert.equal(state.lastError, null);
    assert.equal(state.lastCounts?.conflicts, 0);
    assert.equal(writes(mark).filter(r => r.path.endsWith('standup.ics')).length, 2);
    assert.match(mock.body(work, 'standup.ics')!, /X-NOTE:外部备注/);
    assert.match(mock.body(work, 'standup.ics')!, /DESCRIPTION:带上电脑/);

    // Trashed here, changed there: taking the external version brings the row back.
    standup = await row(workDb, '站会（改）');
    assert.equal((await bulk(workDb, { operation: 'trash', ids: [standup.id] })).statusCode, 200);
    mock.set(work, 'standup.ics', mock.body(work, 'standup.ics')!.replace('SUMMARY:站会（改）', 'SUMMARY:站会（又改）'));
    state = await run(caldav.id);
    assert.equal(state.lastCounts?.conflicts, 1);
    assert.ok(mock.body(work, 'standup.ics'));
    conflicts = ((await call('GET', `/calendar/sync/${caldav.id}/conflicts`)).json() as CalendarSyncConflictsResponse).conflicts;
    assert.deepEqual(conflicts.map(c => [c.kind, c.local, c.remote?.title]), [['local-deleted', null, '站会（又改）']]);
    assert.equal((await call('POST', `/calendar/sync/${caldav.id}/conflicts/${standup.id}`, { choice: 'both' })).json().error, 'CONFLICT_CHOICE_INVALID');
    assert.equal((await call('POST', `/calendar/sync/${caldav.id}/conflicts/${standup.id}`, { choice: 'remote' })).statusCode, 200);
    const back = await row(workDb, '站会（又改）');
    assert.equal(back.id, standup.id);
    assert.equal(back.properties[fields.descriptionId], '带上电脑');
    mark = mock.requests.length;
    state = await run(caldav.id);
    assert.equal(writes(mark).length, 0);

    // Keeping both: the copy becomes an event of its own.
    let current = await row(workDb, '站会（又改）');
    assert.equal((await patchRow(current, { title: '站会（本地）' })).statusCode, 200);
    mock.set(work, 'standup.ics', mock.body(work, 'standup.ics')!.replace('SUMMARY:站会（又改）', 'SUMMARY:站会（外部）'));
    state = await run(caldav.id);
    assert.equal(state.lastCounts?.conflicts, 1);
    assert.equal((await call('POST', `/calendar/sync/${caldav.id}/conflicts/${current.id}`, { choice: 'both' })).statusCode, 200);
    const before = new Set(mock.calendars.get(work)!.resources.keys());
    state = await run(caldav.id);
    assert.equal(state.lastCounts?.pushed, 2);
    assert.match(mock.body(work, 'standup.ics')!, /SUMMARY:站会（本地）/);
    const split = [...mock.calendars.get(work)!.resources.keys()].filter(n => !before.has(n));
    assert.equal(split.length, 1);
    assert.match(mock.body(work, split[0]!)!, /SUMMARY:站会（外部）/);
    assert.match(String((await row(workDb, '站会（外部）')).properties[fields.uidId]), /@nbase$/);

    // Changed here, deleted there: keeping the NBase version writes it back as a new event.
    current = await row(workDb, '站会（本地）');
    assert.equal((await patchRow(current, { properties: { [fields.locationId]: '三号会议室' } })).statusCode, 200);
    mock.remove(work, 'standup.ics');
    state = await run(caldav.id);
    assert.equal(state.lastCounts?.conflicts, 1);
    conflicts = ((await call('GET', `/calendar/sync/${caldav.id}/conflicts`)).json() as CalendarSyncConflictsResponse).conflicts;
    assert.deepEqual(conflicts.map(c => [c.kind, c.local?.location, c.remote]), [['remote-deleted', '三号会议室', null]]);
    assert.equal((await call('POST', `/calendar/sync/${caldav.id}/conflicts/${current.id}`, { choice: 'local' })).statusCode, 200);
    state = await run(caldav.id);
    assert.equal(state.lastCounts?.pushed, 1);
    const rewritten = await row(workDb, '站会（本地）');
    assert.equal(rewritten.id, current.id);
    assert.notEqual(rewritten.properties[fields.uidId], 'standup');
    const rewrittenName = `${String(rewritten.properties[fields.uidId]).replace('@nbase', '')}.ics`;
    assert.match(mock.body(work, rewrittenName)!, /LOCATION:三号会议室/);
    // Deleting the whole series here deletes it there.
    const series = await row(workDb, '周会');
    assert.equal((await bulk(workDb, { operation: 'trash', ids: [series.id] })).statusCode, 200);
    state = await run(caldav.id);
    assert.equal(state.lastCounts?.pushed, 1);
    assert.equal(mock.body(work, 'weekly.ics'), undefined);

    // A read-only calendar behaves like a subscription.
    const readOnly = await call('POST', '/calendar/caldav', { ...account, clientMutationId: randomUUID(),
      calendars: [{ calendarUrl: calendars[1]!.url, name: '节假日' }], parentId: null, intervalMinutes: 60 });
    assert.equal(readOnly.statusCode, 201, readOnly.body);
    const holidaySource = (readOnly.json() as CreateCalendarSourcesResponse).sources[0]!;
    assert.equal(holidaySource.caldav?.writable, false);
    assert.equal(holidaySource.readOnlyPropertyIds.length, 5);
    await syncAll();
    const newyear = await row(holidaySource.databaseId, '元旦');
    synced(await patchRow(newyear, { title: '新年' }));
    synced(await bulk(holidaySource.databaseId, { operation: 'create', rows: [{ title: '手写', properties: {} }] }));
    assert.equal((await bulk(holidaySource.databaseId, { operation: 'trash', ids: [newyear.id] })).statusCode, 200);
    mark = mock.requests.length;
    state = await run(holidaySource.id);
    assert.equal(writes(mark).length, 0);
    assert.ok(mock.body(holidays, 'newyear.ics'));

    // A changed password stops the sync until new credentials are entered; they are checked before they are kept.
    mock.password = 'new-app-password';
    state = await run(caldav.id);
    assert.equal(state.lastError, 'AUTH_FAILED');
    assert.equal(state.status, 'error');
    const refused = await call('PATCH', `/calendar/sync/${caldav.id}`, { credentials: { username: mock.username, password: 'wrong' } });
    assert.equal(refused.json().error, 'AUTH_FAILED');
    const renewed = await call('PATCH', `/calendar/sync/${caldav.id}`, { credentials: { username: mock.username, password: mock.password } });
    assert.equal(renewed.statusCode, 200, renewed.body);
    assert.ok(!renewed.body.includes(mock.password));
    await syncAll();
    assert.equal((await listed(caldav.id)).lastError, null);

    // Credentials sealed with another key are not usable; the switch for outgoing requests also stops CalDAV.
    const otherCall = await appWith({ scheduler: false, credentialKey: otherKey, caldavPrivate: true });
    const otherList = (await otherCall('GET', '/calendar/sync')).json() as CalendarSyncListResponse;
    assert.equal(otherList.sources.find(s => s.id === caldav.id)?.caldav?.credentialsOk, false);
    assert.equal((await keyless('GET', '/calendar/sync')).json().sources.find((s: CalendarSyncSource) => s.id === caldav.id).caldav.credentialsOk, false);
    await call('POST', `/calendar/sync/${caldav.id}/run`);
    let claimed = await claimDueSource(db);
    assert.equal(claimed?.id, caldav.id);
    await runCaldav(db, pages, claimed!, { ...syncOptions, credentialKey: otherKey });
    assert.equal((await listed(caldav.id)).lastError, 'CREDENTIALS_UNAVAILABLE');
    await call('POST', `/calendar/sync/${caldav.id}/run`);
    claimed = await claimDueSource(db);
    await runCaldav(db, pages, claimed!, { ...syncOptions, fetchEnabled: false });
    assert.equal((await listed(caldav.id)).lastError, 'DISABLED');
    state = await run(caldav.id);
    assert.equal(state.lastError, null);

    // Removing the source deletes credentials, items, resources and conflicts; the database and rows stay.
    const rowsBefore = (await database(workDb)).rows.length;
    assert.equal((await call('DELETE', `/calendar/sync/${caldav.id}`)).statusCode, 204);
    for (const table of ['calendar_sync_items', 'calendar_sync_resources', 'calendar_sync_conflicts']) {
      const left = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE source_id = $1`, [caldav.id]);
      assert.equal(left.rows[0]!.n, 0, table);
    }
    const unlocked = await database(workDb);
    assert.equal(unlocked.calendarSync, undefined);
    assert.equal(unlocked.rows.length, rowsBefore);

    // Viewers do not connect accounts.
    await db.query(`UPDATE workspace_memberships SET role = 'viewer' WHERE user_id = $1`, [owner.userId]);
    assert.equal((await call('POST', '/calendar/caldav/discover', account)).statusCode, 403);
  } finally {
    for (const instance of apps) await instance.close();
    await mock.close();
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
