import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { CalendarSettings, CalendarSourcesResponse, CalendarSyncConflictsResponse, CalendarSyncListResponse, CalendarSyncSource,
  CreateCalendarSourcesResponse, DatabaseDocument, PropertyDefinition } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { claimDueSource, runSource, type CalendarSyncOptions } from '../src/calendar/scheduler.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';
import { credentialKeyFromText } from '../src/secrets/credentials.js';
import { icsText, MockCalDav } from './caldav-mock.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local integration password only';
const key = credentialKeyFromText(Buffer.alloc(32, 7).toString('base64'));

test('aggregate calendar: ordinary databases with dates sync both ways through one CalDAV calendar', {
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
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    const db = pool;
    await runMigrations(pool);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(ownerPassword), '测试');

    const work = mock.addCalendar('work', { name: '工作', writable: true });
    const home = mock.addCalendar('home', { name: '家庭', writable: true });
    const holidays = mock.addCalendar('holidays', { name: '节假日', writable: false });
    mock.set(work, 'standup.ics', icsText([['UID:standup', 'DTSTART:20260310T010000Z', 'DTEND:20260310T013000Z', 'SUMMARY:站会']]));
    mock.set(holidays, 'newyear.ics', icsText([['UID:newyear', 'DTSTART;VALUE=DATE:20260101', 'DTEND;VALUE=DATE:20260102', 'SUMMARY:元旦']]));
    await mock.start();

    const pages = new PgPageRepository(pool);
    app = await buildApp({ auth: { repository: new PgAuthRepository(pool), publicOrigin: origin }, pages, notesPool: pool,
      calendar: { scheduler: false, credentialKey: key, caldavPrivate: true } });
    const instance = app;
    const login = await instance.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { loginName: 'owner', password: ownerPassword } });
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const write = { cookie, origin, 'x-csrf-token': login.json().csrfToken as string };
    const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown) =>
      instance.inject({ method, url: `/api/workspaces/${owner.workspaceId}${path}`, headers: method === 'GET' ? { cookie } : write,
        ...(method === 'GET' ? {} : { payload: (payload ?? {}) as object }) });
    const syncOptions: CalendarSyncOptions = { fetchEnabled: true, credentialKey: key, caldavPrivate: true };
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
    const patchRow = async (databaseId: string, id: string, patch: { title?: string; properties?: Record<string, unknown> }) =>
      bulk(databaseId, { operation: 'patch', items: [{ id, ...patch }] });
    const listed = async (id: string) => ((await call('GET', '/calendar/sync')).json() as CalendarSyncListResponse).sources.find(s => s.id === id)!;
    const syncAll = async () => {
      for (let due = await claimDueSource(db); due; due = await claimDueSource(db)) await runSource(db, pages, due, syncOptions);
    };
    const run = async (id: string) => {
      assert.equal((await call('POST', `/calendar/sync/${id}/run`)).statusCode, 202);
      await syncAll();
      const state = await listed(id);
      assert.equal(state.lastError, null, JSON.stringify(state));
      return state;
    };
    const writes = (from: number) => mock.requests.slice(from).filter(r => r.method === 'PUT' || r.method === 'DELETE');
    const names = (calendar: string) => [...mock.calendars.get(calendar)!.resources.keys()].sort();
    const bodies = (calendar: string) => [...mock.calendars.get(calendar)!.resources.values()].map(r => r.body);
    const holding = (calendar: string, summary: string) => names(calendar).filter(n => mock.body(calendar, n)!.includes(`SUMMARY:${summary}\r\n`));
    const settings = async () => (await call('GET', '/calendar/settings')).json() as CalendarSettings;
    const saveSettings = async (next: CalendarSettings) => {
      const response = await call('PUT', '/calendar/settings', next);
      assert.equal(response.statusCode, 200, response.body);
      return response.json() as CalendarSettings;
    };
    const makeDatabase = async (title: string, withDate: boolean) => {
      const doc = (await call('POST', '/databases', { clientMutationId: randomUUID(), parentId: null, title })).json() as DatabaseDocument;
      const date: PropertyDefinition = { id: randomUUID(), name: '日期', type: 'date' };
      if (withDate) {
        const saved = await call('PATCH', `/databases/${doc.page.id}`, { clientMutationId: randomUUID(), expectedRevision: doc.schemaRevision,
          properties: [...doc.properties, date], views: doc.views });
        assert.equal(saved.statusCode, 200, saved.body);
      }
      return { id: doc.page.id, dateId: date.id };
    };
    const account = { serverUrl: mock.origin, username: mock.username, password: mock.password };
    const connectAll = async (chosen: [calendar: string, title: string][]) => {
      const response = await call('POST', '/calendar/caldav', { ...account, clientMutationId: randomUUID(), parentId: null, intervalMinutes: 60,
        calendars: chosen.map(([calendar, title]) => ({ calendarUrl: mock.url(calendar), name: title })) });
      assert.equal(response.statusCode, 201, response.body);
      const { sources } = response.json() as CreateCalendarSourcesResponse;
      assert.deepEqual(sources.map(s => s.name), chosen.map(([, title]) => title));
      return sources;
    };
    const connect = async (calendar: string, title: string) => (await connectAll([[calendar, title]]))[0]!;

    // New databases with a date field join the workspace calendar on their own; ones without stay out.
    const project = await makeDatabase('项目', true);
    const notes = await makeDatabase('笔记', false);
    await bulk(project.id, { operation: 'create', rows: [
      { title: '交付', properties: { [project.dateId]: '2026-03-05' } },
      { title: '周报', properties: { [project.dateId]: '2026-03-02|rrule=FREQ=WEEKLY;COUNT=3' } },
      { title: '草稿', properties: {} },
    ] });
    let current = await settings();
    assert.deepEqual(current.sources, [{ databaseId: project.id, propertyId: project.dateId, color: 'blue', visible: true }]);
    assert.ok(!current.sources.some(s => s.databaseId === notes.id));

    // Databases made by a sync stay hidden; only a writable CalDAV calendar may hold the aggregate.
    // Two calendars of one account connected together get a database each.
    const [workSource, holidaySource] = await connectAll([[work, '工作'], [holidays, '节假日']]) as [CalendarSyncSource, CalendarSyncSource];
    assert.notEqual(workSource.databaseId, holidaySource.databaseId);
    assert.deepEqual([workSource.caldav?.writable, holidaySource.caldav?.writable], [true, false]);
    await syncAll();
    const options = new Map(((await call('GET', '/calendar/sources')).json() as CalendarSourcesResponse).databases.map(d => [d.databaseId, d]));
    assert.equal(options.get(workSource.databaseId)?.hidden, true);
    assert.equal(options.get(project.id)?.hidden, false);
    assert.equal((await call('PATCH', `/calendar/sync/${holidaySource.id}`, { aggregate: true })).json().error, 'SYNC_KIND_INVALID');
    assert.equal(writes(0).length, 0);
    const enabled = await call('PATCH', `/calendar/sync/${workSource.id}`, { aggregate: true });
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.equal((enabled.json() as CalendarSyncSource).caldav?.aggregate, true);

    // Turning it on writes every row that has a date; the source's own rows and other sources' databases are not copied.
    let mark = mock.requests.length;
    let state = await run(workSource.id);
    assert.equal(state.lastCounts?.pushed, 2, JSON.stringify(state.lastCounts));
    assert.ok(writes(mark).every(r => r.method === 'PUT' && r.ifNoneMatch === '*'));
    assert.equal(names(work).length, 3);
    const [delivery] = holding(work, '交付');
    assert.ok(delivery);
    assert.match(mock.body(work, delivery)!, /DTSTART;VALUE=DATE:20260305/);
    assert.match(mock.body(work, holding(work, '周报')[0]!)!, /RRULE:FREQ=WEEKLY;COUNT=3/);
    assert.ok(!bodies(work).some(b => b!.includes('元旦')));
    assert.ok(!bodies(work).some(b => b!.includes('草稿')));
    assert.deepEqual((await database(workSource.databaseId)).rows.map(r => r.title), ['站会']);
    const items = await db.query<{ database_id: string | null; property_id: string | null }>(
      'SELECT database_id, property_id FROM calendar_sync_items WHERE source_id = $1 ORDER BY database_id NULLS FIRST', [workSource.id]);
    assert.deepEqual(items.rows, [{ database_id: null, property_id: null }, { database_id: project.id, property_id: project.dateId },
      { database_id: project.id, property_id: project.dateId }]);
    // The ordinary database gets no external ID field written.
    assert.deepEqual(Object.keys((await row(project.id, '交付')).properties), [project.dateId]);
    // Our own writes do not come back.
    mark = mock.requests.length;
    state = await run(workSource.id);
    assert.deepEqual([state.lastCounts?.created, state.lastCounts?.updated, state.lastCounts?.removed, state.lastCounts?.pushed], [0, 0, 0, 0]);
    assert.equal(writes(mark).length, 0);

    // External edits reach the row: title and date. Fields the database does not have stay outside.
    const deliveryUid = /UID:([^\r]+)/.exec(mock.body(work, delivery)!)![1]!;
    mock.set(work, delivery, icsText([[`UID:${deliveryUid}`, 'DTSTART;VALUE=DATE:20260306', 'DTEND;VALUE=DATE:20260307', 'SUMMARY:交付（外部改）',
      'LOCATION:外部地点']]));
    state = await run(workSource.id);
    assert.equal(state.lastCounts?.updated, 1);
    let deliveryRow = await row(project.id, '交付（外部改）');
    assert.equal(deliveryRow.properties[project.dateId], '2026-03-06');
    // A local edit is written back and keeps the external location; editing the row brings the aggregate run forward.
    await db.query(`UPDATE calendar_sync_sources SET next_run_at = now() + interval '1 hour' WHERE id = $1`, [workSource.id]);
    await patchRow(project.id, deliveryRow.id, { title: '交付（本地）' });
    const soon = await db.query<{ soon: boolean }>(`SELECT next_run_at <= now() + interval '31 seconds' AS soon FROM calendar_sync_sources WHERE id = $1`,
      [workSource.id]);
    assert.equal(soon.rows[0]!.soon, true);
    mark = mock.requests.length;
    state = await run(workSource.id);
    assert.equal(state.lastCounts?.pushed, 1);
    assert.equal(writes(mark)[0]?.ifMatch !== undefined, true);
    assert.match(mock.body(work, delivery)!, /SUMMARY:交付（本地）/);
    assert.match(mock.body(work, delivery)!, /LOCATION:外部地点/);
    assert.match(mock.body(work, delivery)!, /DTSTART;VALUE=DATE:20260306/);

    // Both sides changed: the row keeps the NBase version, a copy in the same database holds the external one.
    deliveryRow = await row(project.id, '交付（本地）');
    await patchRow(project.id, deliveryRow.id, { title: '交付（本地二）' });
    mock.set(work, delivery, mock.body(work, delivery)!.replace('SUMMARY:交付（本地）', 'SUMMARY:交付（外部二）'));
    mark = mock.requests.length;
    state = await run(workSource.id);
    assert.equal(state.lastCounts?.conflicts, 1);
    assert.equal(writes(mark).length, 0);
    const conflicts = ((await call('GET', `/calendar/sync/${workSource.id}/conflicts`)).json() as CalendarSyncConflictsResponse).conflicts;
    assert.deepEqual(conflicts.map(c => [c.kind, c.rowId, c.local?.title, c.local?.value, c.remote?.title]),
      [['both-changed', deliveryRow.id, '交付（本地二）', '2026-03-06', '交付（外部二）']]);
    const copy = await row(project.id, '交付（外部二）');
    assert.equal(copy.id, conflicts[0]!.copyRowId);
    assert.equal(copy.properties[project.dateId], '2026-03-06');
    const resolved = await call('POST', `/calendar/sync/${workSource.id}/conflicts/${deliveryRow.id}`, { choice: 'local' });
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.ok(!(await database(project.id)).rows.some(r => r.id === copy.id));
    state = await run(workSource.id);
    assert.equal(state.lastCounts?.pushed, 1);
    assert.match(mock.body(work, delivery)!, /SUMMARY:交付（本地二）/);

    // A cleared date removes the external event; a date set again writes a new one.
    await patchRow(project.id, deliveryRow.id, { properties: { [project.dateId]: null } });
    mark = mock.requests.length;
    state = await run(workSource.id);
    assert.deepEqual(writes(mark).map(r => r.method), ['DELETE']);
    assert.equal(mock.body(work, delivery), undefined);
    await patchRow(project.id, deliveryRow.id, { properties: { [project.dateId]: '2026-03-08' } });
    state = await run(workSource.id);
    assert.equal(state.lastCounts?.pushed, 1);
    assert.equal(holding(work, '交付（本地二）').length, 1);
    // A row that gets its first date is written too.
    const draft = await row(project.id, '草稿');
    await patchRow(project.id, draft.id, { properties: { [project.dateId]: '2026-03-20' } });
    state = await run(workSource.id);
    assert.equal(state.lastCounts?.pushed, 1);
    const [draftName] = holding(work, '草稿');
    assert.ok(draftName);

    // External deletion trashes the row; a trashed row deletes the external event.
    mock.remove(work, draftName);
    state = await run(workSource.id);
    assert.equal(state.lastCounts?.removed, 1);
    assert.ok(!(await database(project.id)).rows.some(r => r.id === draft.id));
    await bulk(project.id, { operation: 'trash', ids: [deliveryRow.id] });
    mark = mock.requests.length;
    state = await run(workSource.id);
    assert.deepEqual(writes(mark).map(r => r.method), ['DELETE']);
    assert.equal(holding(work, '交付（本地二）').length, 0);

    // A changed occurrence of an aggregate series becomes a row in the series' database.
    const [weeklyName] = holding(work, '周报');
    const weeklyUid = /UID:([^\r]+)/.exec(mock.body(work, weeklyName!)!)![1]!;
    mock.set(work, weeklyName!, mock.body(work, weeklyName!)!.replace('END:VCALENDAR', ['BEGIN:VEVENT', `UID:${weeklyUid}`,
      'RECURRENCE-ID;VALUE=DATE:20260309', 'DTSTART;VALUE=DATE:20260310', 'DTEND;VALUE=DATE:20260311', 'SUMMARY:周报（改期）', 'END:VEVENT',
      'END:VCALENDAR'].join('\r\n')));
    state = await run(workSource.id);
    assert.equal(state.lastCounts?.created, 1, JSON.stringify(state.lastCounts));
    assert.equal((await row(project.id, '周报（改期）')).properties[project.dateId], '2026-03-10');
    assert.deepEqual((await database(workSource.databaseId)).rows.map(r => r.title), ['站会']);

    // Switching the database off on the workspace calendar removes its events; switching it on writes them again.
    current = await settings();
    await saveSettings({ ...current, sources: current.sources.map(s => s.databaseId === project.id ? { ...s, visible: false } : s) });
    mark = mock.requests.length;
    state = await run(workSource.id);
    assert.deepEqual(writes(mark).map(r => r.method), ['DELETE']);
    assert.deepEqual(names(work), ['standup.ics']);
    assert.equal((await database(project.id)).rows.length, 2);
    current = await settings();
    await saveSettings({ ...current, sources: current.sources.map(s => s.databaseId === project.id ? { ...s, visible: true } : s) });
    state = await run(workSource.id);
    assert.equal(state.lastCounts?.pushed, 2);
    assert.equal(holding(work, '周报').length, 1);
    assert.equal(holding(work, '周报（改期）').length, 1);

    // A database added later joins while autoAdd is on; with it off, new databases wait to be switched on.
    const meetings = await makeDatabase('会议', true);
    await bulk(meetings.id, { operation: 'create', rows: [{ title: '评审', properties: { [meetings.dateId]: '2026-03-12' } }] });
    state = await run(workSource.id);
    assert.equal(state.lastCounts?.pushed, 1);
    assert.equal(holding(work, '评审').length, 1);
    current = await settings();
    assert.equal(current.sources.find(s => s.databaseId === meetings.id)?.visible, true);
    await saveSettings({ ...current, autoAdd: false });
    const trips = await makeDatabase('旅行', true);
    await bulk(trips.id, { operation: 'create', rows: [{ title: '出差', properties: { [trips.dateId]: '2026-03-15' } }] });
    state = await run(workSource.id);
    assert.equal(state.lastCounts?.pushed, 0);
    assert.ok(!(await settings()).sources.some(s => s.databaseId === trips.id));

    // Moving the aggregate to another calendar empties the first one there and fills the second.
    const homeSource = await connect(home, '家庭');
    await syncAll();
    const moved = await call('PATCH', `/calendar/sync/${homeSource.id}`, { aggregate: true });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal((await listed(workSource.id)).caldav?.aggregate, false);
    await syncAll();
    assert.deepEqual(names(work), ['standup.ics']);
    assert.equal(names(home).length, 3);
    assert.equal(holding(home, '评审').length, 1);
    assert.deepEqual((await database(project.id)).rows.map(r => r.title).sort(), ['周报', '周报（改期）'].sort());
    // Turning it off removes the aggregate events; the rows stay.
    assert.equal((await call('PATCH', `/calendar/sync/${homeSource.id}`, { aggregate: false })).statusCode, 200);
    await syncAll();
    assert.deepEqual(names(home), []);
    assert.equal((await database(meetings.id)).rows.length, 1);
    const left = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM calendar_sync_items WHERE database_id IS NOT NULL');
    assert.equal(left.rows[0]!.n, 0);
  } finally {
    await app?.close();
    await mock.close();
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
