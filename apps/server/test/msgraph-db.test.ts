import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { DatabaseDocument } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { syncCaldav } from '../src/calendar/caldav/sync.js';
import { createGraphCalendar, graphBase, graphCalendarUrl } from '../src/calendar/graph/adapter.js';
import { claimSource, createSyncDatabase, finishSource, insertSource, withWorkspaceLock } from '../src/calendar/sources.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';
import { MockGraph } from './msgraph-mock.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local integration password only';
const cst = (dateTime: string) => ({ dateTime, timeZone: 'China Standard Time' });
const utc = (dateTime: string) => ({ dateTime, timeZone: 'UTC' });

test('Microsoft Graph calendars sync both ways through the CalDAV engine', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const admin = new pg.Pool({ connectionString: sourceUrl, max: 2 });
  const name = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
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
    const pages = new PgPageRepository(db);

    const mock = new MockGraph();
    mock.addCalendar('cal1', '日历');
    const standup = mock.add('cal1', { subject: '站会', start: cst('2026-03-10T09:00:00'), end: cst('2026-03-10T09:30:00'), location: '一号会议室' });
    const review = mock.add('cal1', { subject: '评审会', start: utc('2026-03-11T06:00:00'), end: utc('2026-03-11T07:00:00'),
      attendees: [{ type: 'required', emailAddress: { name: 'Bob', address: 'bob@example.test' } }] });
    const trip = mock.add('cal1', { subject: '出差', isAllDay: true, start: cst('2026-03-12T00:00:00'), end: cst('2026-03-14T00:00:00') });
    const weekly = mock.add('cal1', { subject: '周会', start: cst('2026-03-02T09:00:00'), end: cst('2026-03-02T10:00:00'),
      recurrence: { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'], firstDayOfWeek: 'sunday' },
        range: { type: 'numbered', startDate: '2026-03-02', numberOfOccurrences: 4, recurrenceTimeZone: 'China Standard Time' } } });
    mock.addException(weekly, '2026-03-09', { subject: '周会（推迟）', start: cst('2026-03-09T10:00:00'), end: cst('2026-03-09T11:00:00') });
    const graph = createGraphCalendar({ transport: mock.transport, auth: { token: async () => mock.token, renew: async () => mock.token },
      timeZone: 'Asia/Shanghai' });

    const sync = await withWorkspaceLock(db, owner.workspaceId, owner.userId, async client => {
      const target = await createSyncDatabase(client, pages, owner.workspaceId, owner.userId, null, 'Outlook', randomUUID());
      return insertSource(client, { workspaceId: owner.workspaceId, databaseId: target.databaseId, kind: 'caldav', name: 'Outlook', url: null,
        intervalMinutes: 15, fields: target.fields, actorId: owner.userId, clientMutationId: randomUUID(), caldav: {
          config: { serverUrl: graphBase, calendarUrl: graphCalendarUrl('cal1'), calendarName: '日历', writable: true, color: null },
          cipher: Buffer.alloc(32, 1), keyId: '0123456789abcdef' } });
    });
    const fields = sync.fields_json;
    const run = async () => {
      const claimed = await claimSource(db, sync.id);
      assert.ok(claimed);
      const result = await syncCaldav(db, pages.snapshot.bind(pages), claimed, graph, { timeZone: 'Asia/Shanghai' });
      await finishSource(db, sync.id, { counts: result.counts, warnings: result.warnings,
        caldav: { syncToken: result.syncToken, ctag: result.ctag, writable: result.writable } });
      return result.counts;
    };

    app = await buildApp({ auth: { repository: new PgAuthRepository(db), publicOrigin: origin }, pages, notesPool: db, calendar: { scheduler: false } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { loginName: 'owner', password: ownerPassword } });
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const headers = { cookie, origin, 'x-csrf-token': login.json().csrfToken as string };
    const call = (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object) => app!.inject({ method,
      url: `/api/workspaces/${owner.workspaceId}${path}`, headers: method === 'GET' ? { cookie } : headers, ...(payload ? { payload } : {}) });
    const rows = async () => ((await call('GET', `/databases/${sync.database_id}`)).json() as DatabaseDocument).rows;
    const row = async (title: string) => {
      const found = (await rows()).find(r => r.title === title);
      assert.ok(found, `row ${title}`);
      return found;
    };
    const patchRow = async (target: { id: string; revision: number | string }, patch: Record<string, unknown>) => {
      const response = await call('PATCH', `/pages/${target.id}`, { clientMutationId: randomUUID(), expectedRevision: target.revision, ...patch });
      assert.equal(response.statusCode, 200, response.body);
    };
    const bulk = async (body: Record<string, unknown>) => {
      const response = await call('POST', `/databases/${sync.database_id}/rows/bulk`, { clientMutationId: randomUUID(), ...body });
      assert.equal(response.statusCode, 200, response.body);
    };
    const titles = async () => (await rows()).map(r => r.title).sort();

    // The first run reads every event; a changed occurrence becomes a row of its own, keyed by the iCalUId.
    let counts = await run();
    assert.equal(counts.created, 5, JSON.stringify(counts));
    assert.equal(counts.pushed, 0);
    assert.deepEqual(await titles(), ['出差', '周会', '周会（推迟）', '站会', '评审会'].sort());
    const standupRow = await row('站会');
    assert.equal(standupRow.properties[fields.uidId], standup.iCalUId);
    assert.equal(standupRow.properties[fields.dateId], '2026-03-10T01:00:00Z/2026-03-10T01:30:00Z|tz=Asia/Shanghai');
    assert.equal((await row('出差')).properties[fields.dateId], '2026-03-12/2026-03-13');
    assert.equal((await row('周会（推迟）')).properties[fields.uidId], `${weekly.iCalUId}#2026-03-09T01:00:00Z`);
    assert.equal((await row('周会')).properties[fields.dateId], '2026-03-02T01:00:00Z/2026-03-02T02:00:00Z|tz=Asia/Shanghai'
      + '|rrule=FREQ=WEEKLY;COUNT=4;BYDAY=MO;WKST=SU|exdate=2026-03-09T01:00:00Z');
    let mark = mock.requests.length;
    counts = await run();
    assert.deepEqual([counts.created, counts.updated, counts.removed, counts.pushed], [0, 0, 0, 0]);
    assert.equal(mock.writes(mark).length, 0);

    // A change in Outlook reaches the row.
    mock.update(review, { subject: '评审会（外部改）' });
    counts = await run();
    assert.equal(counts.updated, 1);
    assert.ok((await titles()).includes('评审会（外部改）'));

    // Local edits are sent as PATCH with If-Match; trashed rows are deleted; new rows are created by POST.
    await patchRow(await row('站会'), { title: '站会（改）' });
    await bulk({ operation: 'trash', ids: [(await row('出差')).id] });
    await bulk({ operation: 'create', rows: [{ title: '新事件', properties: { [fields.dateId]: '2026-03-20' } }] });
    const tripEtag = trip.etag;
    const standupEtag = standup.etag;
    mark = mock.requests.length;
    counts = await run();
    assert.equal(counts.pushed, 3, JSON.stringify(counts));
    const writes = mock.writes(mark);
    assert.deepEqual(writes.map(w => [w.method, w.path]).sort(), [['DELETE', `me/events/${trip.id}`], ['PATCH', `me/events/${standup.id}`],
      ['POST', 'me/calendars/cal1/events']].sort());
    const patch = writes.find(w => w.method === 'PATCH')!;
    assert.deepEqual(patch.body, { subject: '站会（改）' });
    assert.equal(patch.ifMatch, standupEtag);
    assert.equal(writes.find(w => w.method === 'DELETE')!.ifMatch, tripEtag);
    assert.ok(!mock.events.has(trip.id));
    const fresh = [...mock.events.values()].find(e => e.subject === '新事件');
    assert.ok(fresh);
    assert.equal(fresh.isAllDay, true);
    const newRow = await row('新事件');
    assert.equal(newRow.properties[fields.uidId], fresh.iCalUId);
    // Graph named the new event; the next runs neither create it again nor see changes of our own.
    for (let i = 0; i < 2; i++) {
      mark = mock.requests.length;
      counts = await run();
      assert.deepEqual([counts.created, counts.removed, counts.pushed, counts.conflicts], [0, 0, 0, 0], JSON.stringify(counts));
      assert.equal(mock.writes(mark).length, 0);
    }
    assert.equal([...mock.events.values()].filter(e => e.subject === '新事件').length, 1);
    assert.equal((await rows()).filter(r => r.title === '新事件').length, 1);

    // An event deleted in Outlook is trashed here.
    mock.events.delete(fresh.id);
    counts = await run();
    assert.equal(counts.removed, 1);
    assert.ok(!(await titles()).includes('新事件'));

    // Only this occurrence: a new exdate on the series cancels that occurrence in Outlook.
    const series = await row('周会');
    await patchRow(series, { properties: { [fields.dateId]: `${String(series.properties[fields.dateId])},2026-03-23T01:00:00Z` } });
    mark = mock.requests.length;
    counts = await run();
    assert.equal(counts.pushed, 1, JSON.stringify(counts));
    assert.deepEqual(mock.writes(mark).map(w => [w.method, w.path]), [['DELETE', `me/events/occ.${weekly.id}.2026-03-23`]]);
    assert.deepEqual([...weekly.cancelled], ['2026-03-23']);
    assert.equal(weekly.exceptions.size, 1);
    mark = mock.requests.length;
    counts = await run();
    assert.deepEqual([counts.updated, counts.pushed], [0, 0], JSON.stringify(counts));
    assert.equal(mock.writes(mark).length, 0);

    // Changed on both sides between reading and writing: Graph answers 412 and nothing is lost.
    let current = await row('站会（改）');
    await patchRow(current, { properties: { [fields.locationId]: '二号会议室' } });
    mock.beforeWrite = () => mock.update(standup, { subject: '站会（外部改）' });
    mark = mock.requests.length;
    counts = await run();
    const raced = mock.writes(mark);
    assert.equal(raced[0]?.method, 'PATCH');
    assert.equal(standup.subject, '站会（外部改）', 'the external title survives');
    assert.equal(counts.conflicts, 1, JSON.stringify(counts));
    assert.equal(raced.length, 1, 'writing waits for the conflict');
    assert.equal(standup.location, '一号会议室');
    const conflicted = (await rows()).filter(r => r.title.startsWith('站会'));
    assert.deepEqual(conflicted.map(r => [r.title, r.properties[fields.locationId]]).sort(), [['站会（外部改）', '一号会议室'], ['站会（改）', '二号会议室']]);

    // Attendee events are never written back.
    current = await row('评审会（外部改）');
    const refused = await call('PATCH', `/pages/${current.id}`, { clientMutationId: randomUUID(), expectedRevision: current.revision, title: 'x' });
    assert.equal(refused.statusCode, 422, refused.body);
    assert.ok(mock.events.has(review.id) && review.subject === '评审会（外部改）');
  } finally {
    await app?.close();
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
