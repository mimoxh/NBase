import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { CalendarEventsResponse, CalendarImportResponse, CalendarRemindersResponse, CalendarSourcesResponse, CalendarSyncListResponse,
  CalendarSyncSource, DatabaseDocument } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import type { CalendarFetcher } from '../src/calendar/fetch.js';
import { claimDueSource, runSubscription } from '../src/calendar/scheduler.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local integration password only';

const ics = (events: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
  ...events.flatMap(lines => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n') + '\r\n';

test('calendar import, subscription sync, read-only fields and calendar reads', {
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
    await runMigrations(pool);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(ownerPassword), '测试');

    let version = 1;
    let feed = ics([
      ['UID:standup@example.test', 'DTSTART:20260310T010000Z', 'DTEND:20260310T013000Z', 'SUMMARY:站会', 'LOCATION:一号会议室'],
      ['UID:trip@example.test', 'DTSTART;VALUE=DATE:20260312', 'DTEND;VALUE=DATE:20260314', 'SUMMARY:出差'],
    ]);
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const fetcher: CalendarFetcher = async (target, headers) => {
      requests.push({ url: target.toString(), headers });
      const etag = `"v${version}"`;
      if (headers['If-None-Match'] === etag) return { status: 304, headers: {}, body: Buffer.alloc(0) };
      return { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8', etag }, body: Buffer.from(feed, 'utf8') };
    };
    const pages = new PgPageRepository(pool);
    app = await buildApp({ auth: { repository: new PgAuthRepository(pool), publicOrigin: origin }, pages, notesPool: pool,
      calendar: { fetcher, scheduler: false } });
    const instance = app;
    const base = `/api/workspaces/${owner.workspaceId}`;
    const login = await instance.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { loginName: 'owner', password: ownerPassword } });
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const read = { cookie };
    const write = { cookie, origin, 'x-csrf-token': login.json().csrfToken as string };
    const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown) =>
      instance.inject({ method, url: `${base}${path}`, headers: method === 'GET' ? read : write, ...(method === 'GET' ? {} : { payload: (payload ?? {}) as object }) });
    const database = async (id: string) => (await call('GET', `/databases/${id}`)).json() as DatabaseDocument;
    const syncAll = async () => {
      for (let source = await claimDueSource(db); source; source = await claimDueSource(db)) {
        await runSubscription(db, pages, source, { fetchEnabled: true, fetcher });
      }
    };

    // Settings default, then round trip.
    assert.deepEqual((await call('GET', '/calendar/settings')).json(), { sources: [], showDailyNotes: true, defaultDatabaseId: null });
    assert.equal((await call('PUT', '/calendar/settings', { sources: 1, showDailyNotes: true, defaultDatabaseId: null })).statusCode, 400);

    // A file import creates an editable database with the calendar fields.
    const importId = randomUUID();
    const importBody = { clientMutationId: importId, target: { parentId: null, name: '导入日历' }, ics: feed };
    const imported = await call('POST', '/calendar/import', importBody);
    assert.equal(imported.statusCode, 201, imported.body);
    const importResult = imported.json() as CalendarImportResponse;
    assert.equal(importResult.counts.created, 2);
    assert.equal(importResult.source.kind, 'ics-file');
    assert.deepEqual(importResult.source.readOnlyPropertyIds, []);
    assert.deepEqual((await call('POST', '/calendar/import', importBody)).json(), importResult);
    const fileDb = importResult.source.databaseId;
    const fileDoc = await database(fileDb);
    assert.deepEqual(fileDoc.properties.map(p => p.name), ['名称', '时间', '地点', '说明', '外部 ID']);
    assert.deepEqual(fileDoc.views.map(v => [v.name, v.type]), [['日历', 'calendar'], ['表格', 'table']]);
    assert.ok(fileDoc.views.every(v => v.hiddenPropertyIds.includes(importResult.source.fields.uidId)));
    assert.equal(fileDoc.calendarSync?.id, importResult.source.id);
    assert.equal(fileDoc.page.parentId, null);
    const fields = importResult.source.fields;
    const standup = fileDoc.rows.find(row => row.title === '站会')!;
    assert.equal(standup.properties[fields.dateId], '2026-03-10T01:00:00Z/2026-03-10T01:30:00Z');
    assert.equal(standup.properties[fields.locationId], '一号会议室');
    assert.equal(standup.properties[fields.uidId], 'standup@example.test');

    // Imported rows stay editable; a re-import keeps the edit and adds the changed event as a second row.
    const edited = await call('PATCH', `/pages/${standup.id}`, { clientMutationId: randomUUID(), expectedRevision: standup.revision, title: '站会（改）',
      properties: { [fields.dateId]: '2026-03-10T01:00:00Z/2026-03-10T01:30:00Z|remind=15' } });
    assert.equal(edited.statusCode, 200, edited.body);
    const changedFeed = feed.replace('SUMMARY:站会', 'SUMMARY:站会二');
    const again = await call('POST', '/calendar/import', { clientMutationId: randomUUID(), target: { databaseId: fileDb }, ics: changedFeed });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().counts.conflicts, 1);
    assert.equal(again.json().counts.unchanged, 1);
    assert.deepEqual((await database(fileDb)).rows.map(row => row.title).sort(), ['出差', '站会二', '站会（改）'].sort());
    const repeat = await call('POST', '/calendar/import', { clientMutationId: randomUUID(), target: { databaseId: fileDb }, ics: changedFeed });
    assert.equal(repeat.json().counts.unchanged, 2, repeat.body);
    assert.equal((await database(fileDb)).rows.length, 3);
    assert.equal((await call('POST', '/calendar/import', { clientMutationId: randomUUID(), target: { parentId: null, name: 'x' }, ics: 'hello' })).json().error, 'NOT_CALENDAR');
    const plainDb = (await call('POST', '/databases', { clientMutationId: randomUUID(), parentId: null, title: '普通表' })).json() as DatabaseDocument;
    assert.equal((await call('POST', '/calendar/import', { clientMutationId: randomUUID(), target: { databaseId: plainDb.page.id }, ics: feed })).json().error,
      'IMPORT_TARGET_INVALID');
    assert.equal((await call('PATCH', `/calendar/sync/${importResult.source.id}`, { intervalMinutes: 60 })).json().error, 'SYNC_KIND_INVALID');
    assert.equal((await call('PATCH', `/calendar/sync/${importResult.source.id}`, { name: '改名' })).json().name, '改名');

    // Subscriptions: blocked addresses are refused; webcal becomes https; the first sync runs in the background.
    assert.equal((await call('POST', '/calendar/subscriptions', { clientMutationId: randomUUID(), url: 'http://127.0.0.1/feed.ics', name: '本机',
      parentId: null, intervalMinutes: 60 })).json().error, 'URL_BLOCKED');
    const subscribed = await call('POST', '/calendar/subscriptions', { clientMutationId: randomUUID(),
      url: 'webcal://calendar.example.test/feed.ics?token=secret', name: '订阅', parentId: null, intervalMinutes: 60 });
    assert.equal(subscribed.statusCode, 201, subscribed.body);
    const subscription = subscribed.json() as CalendarSyncSource;
    assert.equal(subscription.urlHost, 'calendar.example.test');
    assert.ok(!subscribed.body.includes('secret'));
    assert.equal(subscription.readOnlyPropertyIds.length, 5);
    await syncAll();
    assert.equal(requests[0]?.url, 'https://calendar.example.test/feed.ics?token=secret');
    const subDb = subscription.databaseId;
    let subDoc = await database(subDb);
    assert.equal(subDoc.rows.length, 2);
    assert.equal(subDoc.calendarSync?.lastCounts?.created, 2);
    assert.equal(subDoc.calendarSync?.status, 'idle');
    assert.equal((await call('POST', '/calendar/import', { clientMutationId: randomUUID(), target: { databaseId: subDb }, ics: feed })).json().error,
      'IMPORT_TARGET_INVALID');

    // Conditional GET: an unchanged feed answers 304 and nothing is written.
    assert.equal((await call('POST', `/calendar/sync/${subscription.id}/run`)).statusCode, 202);
    await syncAll();
    assert.equal(requests[1]?.headers['If-None-Match'], '"v1"');
    assert.deepEqual((await database(subDb)).rows.map(row => row.revision), subDoc.rows.map(row => row.revision));

    // Kept fields refuse hand edits everywhere; other fields stay editable.
    const row = subDoc.rows.find(r => r.title === '站会')!;
    const synced = async (response: Awaited<ReturnType<typeof call>>) => {
      assert.equal(response.statusCode, 422, response.body);
      assert.deepEqual(response.json(), { error: 'PROPERTY_INVALID', reason: 'property-synced' });
    };
    await synced(await call('PATCH', `/pages/${row.id}`, { clientMutationId: randomUUID(), expectedRevision: row.revision, title: '改' }));
    await synced(await call('PATCH', `/pages/${row.id}`, { clientMutationId: randomUUID(), expectedRevision: row.revision,
      properties: { [subscription.fields.locationId]: '别处' } }));
    await synced(await call('POST', `/databases/${subDb}/rows/bulk`, { clientMutationId: randomUUID(), operation: 'patch',
      items: [{ id: row.id, properties: { [subscription.fields.dateId]: '2026-03-11' } }] }));
    await synced(await call('POST', `/databases/${subDb}/rows/bulk`, { clientMutationId: randomUUID(), operation: 'create', rows: [{ title: '手写', properties: {} }] }));
    await synced(await call('POST', `/databases/${subDb}/rows/bulk`, { clientMutationId: randomUUID(), operation: 'duplicate', ids: [row.id] }));
    await synced(await call('POST', '/pages', { clientMutationId: randomUUID(), parentId: subDb, title: '手写',
      content: { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [] } } }, properties: {} }));
    const note = { id: randomUUID(), name: '备注', type: 'text' as const };
    const schema = await call('PATCH', `/databases/${subDb}`, { clientMutationId: randomUUID(), expectedRevision: subDoc.schemaRevision,
      properties: [...subDoc.properties, note], views: subDoc.views });
    assert.equal(schema.statusCode, 200, schema.body);
    const own = await call('PATCH', `/pages/${row.id}`, { clientMutationId: randomUUID(), expectedRevision: row.revision,
      properties: { [note.id]: '自己的备注', [subscription.fields.locationId]: '一号会议室' } });
    assert.equal(own.statusCode, 200, own.body);
    subDoc = await database(subDb);
    for (const change of [{ type: 'number' }, { deletedAt: new Date().toISOString() }]) {
      const properties = subDoc.properties.map(p => p.id === subscription.fields.dateId ? { ...p, ...change } : p);
      const refused = await call('PATCH', `/databases/${subDb}`, { clientMutationId: randomUUID(), expectedRevision: subDoc.schemaRevision, properties, views: subDoc.views });
      assert.equal(refused.statusCode, 422, refused.body);
      assert.equal(refused.json().error, 'DATABASE_SCHEMA_INVALID');
    }
    // A file import's fields are editable but still may not be removed.
    const fileNow = await database(fileDb);
    const fileRemoved = await call('PATCH', `/databases/${fileDb}`, { clientMutationId: randomUUID(), expectedRevision: fileNow.schemaRevision,
      properties: fileNow.properties.map(p => p.id === fields.locationId ? { ...p, deletedAt: new Date().toISOString() } : p), views: fileNow.views });
    assert.equal(fileRemoved.statusCode, 422, fileRemoved.body);

    // The sync writes through the lock, keeps hand-added values, and moves events gone from the feed to the trash.
    version += 1;
    feed = ics([['UID:standup@example.test', 'DTSTART:20260310T020000Z', 'DTEND:20260310T023000Z', 'SUMMARY:站会（推迟）', 'LOCATION:一号会议室']]);
    await call('POST', `/calendar/sync/${subscription.id}/run`);
    await syncAll();
    subDoc = await database(subDb);
    assert.deepEqual(subDoc.rows.map(r => r.title), ['站会（推迟）']);
    assert.equal(subDoc.rows[0]!.properties[note.id], '自己的备注');
    assert.equal(subDoc.calendarSync?.lastCounts?.removed, 1);
    const trash = (await call('GET', '/trash')).json() as { pages: { title: string }[] };
    assert.ok(trash.pages.some(p => p.title === '出差'));
    version += 1;
    feed = ics([['UID:standup@example.test', 'DTSTART:20260310T020000Z', 'DTEND:20260310T023000Z', 'SUMMARY:站会（推迟）', 'LOCATION:一号会议室'],
      ['UID:trip@example.test', 'DTSTART;VALUE=DATE:20260312', 'DTEND;VALUE=DATE:20260314', 'SUMMARY:出差']]);
    await call('POST', `/calendar/sync/${subscription.id}/run`);
    await syncAll();
    assert.equal((await database(subDb)).rows.length, 2);

    // Fetch failures and the off switch are recorded on the source.
    await call('POST', `/calendar/sync/${subscription.id}/run`);
    const claimed = await claimDueSource(db);
    assert.ok(claimed);
    await runSubscription(db, pages, claimed, { fetchEnabled: false });
    assert.equal((await database(subDb)).calendarSync?.lastError, 'DISABLED');
    await call('POST', `/calendar/sync/${subscription.id}/run`);
    const broken = await claimDueSource(db);
    await runSubscription(db, pages, broken!, { fetchEnabled: true, fetcher: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>') }) });
    assert.equal((await database(subDb)).calendarSync?.lastError, 'NOT_CALENDAR');
    assert.equal((await database(subDb)).rows.length, 2);

    // Lists and calendar reads.
    const list = (await call('GET', '/calendar/sync')).json() as CalendarSyncListResponse;
    assert.deepEqual(list.sources.map(s => s.kind), ['ics-file', 'ics-url']);
    const sources = (await call('GET', '/calendar/sources')).json() as CalendarSourcesResponse;
    assert.ok(sources.databases.some(d => d.databaseId === subDb && d.sync?.id === subscription.id));
    const settings = { sources: [{ databaseId: subDb, propertyId: subscription.fields.dateId, color: 'blue', visible: true },
      { databaseId: fileDb, propertyId: fields.dateId, color: 'green', visible: true }], showDailyNotes: true, defaultDatabaseId: fileDb };
    assert.deepEqual((await call('PUT', '/calendar/settings', settings)).json(), settings);
    assert.deepEqual((await call('GET', '/calendar/settings')).json(), settings);
    const events = (await call('POST', '/calendar/events', { from: '2026-03-01', to: '2026-03-31', context: { timeZone: 'Asia/Shanghai' } })).json() as CalendarEventsResponse;
    assert.equal(events.events.filter(e => e.databaseId === subDb).length, 2);
    assert.ok(events.events.filter(e => e.databaseId === subDb).every(e => e.readOnly));
    assert.ok(events.events.filter(e => e.databaseId === fileDb).every(e => !e.readOnly));
    assert.equal(events.events.filter(e => e.databaseId === fileDb).length, 3);
    assert.deepEqual(events.truncated, []);
    const outside = (await call('POST', '/calendar/events', { from: '2026-04-01', to: '2026-04-30' })).json() as CalendarEventsResponse;
    assert.equal(outside.events.length, 0);
    assert.equal((await call('POST', '/calendar/events', { from: '2026-03-31', to: '2026-03-01' })).statusCode, 400);
    const reminders = (await call('POST', '/calendar/reminders', { from: '2026-03-10T00:00:00Z', to: '2026-03-11T00:00:00Z' })).json() as CalendarRemindersResponse;
    assert.deepEqual(reminders.items.map(item => [item.title, item.at, item.minutes]), [['站会（改）', '2026-03-10T00:45:00.000Z', 15]]);

    // Synced databases are flagged for clients and stay out of search and the graph; they still open by id.
    type Summary = { id: string; calendarSync?: true };
    const tree = async () => new Map(((await call('GET', '/page-tree')).json() as { pages: Summary[] }).pages.map(p => [p.id, p]));
    const search = async (q: string) => ((await call('GET', `/search?q=${encodeURIComponent(q)}`)).json() as { results: { pageId: string }[] })
      .results.map(r => r.pageId);
    const graphIds = async () => ((await call('GET', '/graph')).json() as { nodes: { id: string }[] }).nodes.map(n => n.id);
    let listed = await tree();
    assert.equal(listed.get(subDb)?.calendarSync, true);
    assert.equal(listed.get(fileDb)?.calendarSync, true);
    assert.ok(listed.has(plainDb.page.id) && !('calendarSync' in listed.get(plainDb.page.id)!));
    const fileDbPage = (await call('GET', `/pages/${fileDb}`)).json() as Summary & { revision: string };
    assert.equal(fileDbPage.calendarSync, true);
    const renamedDb = await call('PATCH', `/pages/${fileDb}`, { clientMutationId: randomUUID(), expectedRevision: fileDbPage.revision, title: '导入日历（改）' });
    assert.equal(renamedDb.statusCode, 200, renamedDb.body);
    assert.equal(renamedDb.json().calendarSync, true);
    assert.deepEqual(await search('站会'), []);
    assert.deepEqual(await search('导入日历'), []);
    assert.deepEqual(await search('普通表'), [plainDb.page.id]);
    const nodes = await graphIds();
    assert.ok(nodes.includes(plainDb.page.id));
    assert.ok(!nodes.includes(subDb) && !nodes.includes(fileDb));

    // Removing the subscription unlocks the fields; the database and rows stay.
    assert.equal((await call('DELETE', `/calendar/sync/${subscription.id}`)).statusCode, 204);
    assert.equal((await call('DELETE', `/calendar/sync/${subscription.id}`)).statusCode, 404);
    // ...and the database becomes an ordinary one again, at the top level where the sync created it.
    listed = await tree();
    assert.ok(listed.has(subDb) && !('calendarSync' in listed.get(subDb)!));
    assert.equal(listed.get(fileDb)?.calendarSync, true);
    assert.equal((await search('推迟')).length, 1);
    assert.deepEqual(await search('站会（改）'), []);
    assert.ok((await graphIds()).includes(subDb));
    const unlocked = await database(subDb);
    assert.equal(unlocked.calendarSync, undefined);
    assert.equal(unlocked.rows.length, 2);
    const freed = unlocked.rows.find(r => r.title === '站会（推迟）')!;
    const renamed = await call('PATCH', `/pages/${freed.id}`, { clientMutationId: randomUUID(), expectedRevision: freed.revision, title: '自己的站会' });
    assert.equal(renamed.statusCode, 200, renamed.body);

    // Viewers read but do not write.
    await pool.query(`UPDATE workspace_memberships SET role = 'viewer' WHERE user_id = $1`, [owner.userId]);
    assert.equal((await call('POST', '/calendar/import', { clientMutationId: randomUUID(), target: { parentId: null, name: 'x' }, ics: feed })).statusCode, 403);
    assert.equal((await call('POST', '/calendar/events', { from: '2026-03-01', to: '2026-03-31' })).statusCode, 200);
    assert.equal((await call('PUT', '/calendar/settings', settings)).statusCode, 200);
  } finally {
    await app?.close();
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
