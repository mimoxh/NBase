import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPersistentCalendarSource } from './persistentSource';

const respond = (payload: unknown, status = 200) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => payload }) as Response;

function makeSource(extra: { isRowOpen?: (id: string) => boolean; writeOpenRowDate?: (id: string, p: string, v: string) => Promise<boolean> } = {}) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
  const queue: ((input: RequestInfo | URL) => Promise<Response>)[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${String(input)}`);
    return next(input);
  });
  vi.stubGlobal('fetch', fetchMock);
  const source = createPersistentCalendarSource({
    workspaceId: 'w1', csrfToken: 'csrf-token', canWrite: true, context: { timeZone: 'UTC', weekStart: 1 },
    notice: () => undefined, openRow: () => undefined, openDatabase: () => undefined, openDailyNote: () => undefined, ...extra,
  });
  return { calls, queue, source };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('persistent calendar source requests', () => {
  it('reads sources and settings with GET', async () => {
    const { calls, queue, source } = makeSource();
    queue.push(() => Promise.resolve(respond({ databases: [] })));
    queue.push(() => Promise.resolve(respond({ sources: [], showDailyNotes: true, defaultDatabaseId: null })));
    await source.listDatabases();
    await source.loadSettings();
    expect(calls[0]).toMatchObject({ url: '/api/workspaces/w1/calendar/sources', method: 'GET' });
    expect(calls[1]).toMatchObject({ url: '/api/workspaces/w1/calendar/settings', method: 'GET' });
  });

  it('posts the events range with the reader context and CSRF token', async () => {
    const { calls, queue, source } = makeSource();
    queue.push(() => Promise.resolve(respond({ events: [], dailyNotes: [], truncated: [] })));
    await source.loadEvents('2026-11-01', '2026-11-30');
    expect(calls[0]).toMatchObject({ url: '/api/workspaces/w1/calendar/events', method: 'POST',
      body: { from: '2026-11-01', to: '2026-11-30', context: { timeZone: 'UTC', weekStart: 1 } } });
    expect(calls[0]!.headers['x-csrf-token']).toBe('csrf-token');
  });

  it('saves settings with PUT', async () => {
    const { calls, queue, source } = makeSource();
    queue.push(() => Promise.resolve(respond(undefined, 204)));
    const settings = { sources: [{ databaseId: 'd', propertyId: 'p', color: 'blue' as const, visible: true }],
      showDailyNotes: false, defaultDatabaseId: 'd' };
    await source.saveSettings(settings);
    expect(calls[0]).toMatchObject({ url: '/api/workspaces/w1/calendar/settings', method: 'PUT', body: settings });
  });

  it('writes a row date through the page API with the expected revision', async () => {
    const { calls, queue, source } = makeSource();
    queue.push(() => Promise.resolve(respond({ id: 'row-1', revision: '8' })));
    const ok = await source.writeRowDate({ rowId: 'row-1', propertyId: 'p-date', value: '2026-11-17', expectedRevision: '7' });
    expect(ok).toBe(true);
    expect(calls[0]!.url).toBe('/api/workspaces/w1/pages/row-1');
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toMatchObject({ expectedRevision: '7', properties: { 'p-date': '2026-11-17' } });
    expect(typeof (calls[0]!.body as { clientMutationId: string }).clientMutationId).toBe('string');
  });

  it('reports a 409 conflict as false without throwing', async () => {
    const { queue, source } = makeSource();
    queue.push(() => Promise.resolve(respond({ error: 'REVISION_CONFLICT', currentRevision: '9' }, 409)));
    expect(await source.writeRowDate({ rowId: 'row-1', propertyId: 'p', value: '2026-11-17', expectedRevision: '7' })).toBe(false);
  });

  it('answers a lost response from the mutation receipt', async () => {
    const { calls, queue, source } = makeSource();
    queue.push(() => Promise.reject(new TypeError('fetch failed')));
    queue.push(() => Promise.resolve(respond({ statusCode: 200, response: { id: 'row-1', revision: '8' } })));
    expect(await source.writeRowDate({ rowId: 'row-1', propertyId: 'p', value: '2026-11-17', expectedRevision: '7' })).toBe(true);
    expect(calls[1]!.url).toMatch(/^\/api\/workspaces\/w1\/mutations\//);
  });

  it('routes writes of an open row through the workbench', async () => {
    const written: [string, string, string][] = [];
    const { calls, source } = makeSource({
      isRowOpen: () => true,
      writeOpenRowDate: async (id, propertyId, value) => { written.push([id, propertyId, value]); return true; },
    });
    expect(await source.writeRowDate({ rowId: 'row-1', propertyId: 'p', value: '2026-11-17', expectedRevision: '7' })).toBe(true);
    expect(written).toEqual([['row-1', 'p', '2026-11-17']]);
    expect(calls).toHaveLength(0);
  });

  it('creates an event row under the database', async () => {
    const { calls, queue, source } = makeSource();
    queue.push(() => Promise.resolve(respond({ id: 'new-row', revision: '1' })));
    const id = await source.createEvent({ databaseId: 'db-1', propertyId: 'p-date', value: '2026-11-18' });
    expect(id).toBe('new-row');
    expect(calls[0]).toMatchObject({ url: '/api/workspaces/w1/pages', method: 'POST' });
    expect(calls[0]!.body).toMatchObject({ parentId: 'db-1', properties: { 'p-date': '2026-11-18' } });
  });

  it('builds the sync endpoints', async () => {
    const { calls, queue, source } = makeSource();
    queue.push(() => Promise.resolve(respond({ sources: [] })));
    queue.push(() => Promise.resolve(respond({ id: 's1' })));
    queue.push(() => Promise.resolve(respond(undefined, 204)));
    await source.sync!.list();
    await source.sync!.run('s1');
    await source.sync!.remove('s1');
    expect(calls.map(call => [call.method, call.url])).toEqual([
      ['GET', '/api/workspaces/w1/calendar/sync'],
      ['POST', '/api/workspaces/w1/calendar/sync/s1/run'],
      ['DELETE', '/api/workspaces/w1/calendar/sync/s1'],
    ]);
  });
});

const ids = { title: '11111111-1111-4111-8111-111111111111', date: '22222222-2222-4222-8222-222222222222',
  location: '33333333-3333-4333-8333-333333333333', description: '44444444-4444-4444-8444-444444444444',
  uid: '55555555-5555-4555-8555-555555555555', note: '66666666-6666-4666-8666-666666666666' };

describe('CalDAV requests', () => {
  it('posts discovery with JSON, the CSRF token and the account', async () => {
    const { calls, queue, source } = makeSource();
    queue.push(() => Promise.resolve(respond({ calendars: [{ url: 'https://caldav.example.com/cal/a/', name: '工作', color: '#ff0000', writable: true }] })));
    const result = await source.sync!.discoverCaldav({ serverUrl: 'https://caldav.feishu.cn', username: 'u', password: 'p' });
    expect(result.calendars).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/api/workspaces/w1/calendar/caldav/discover', method: 'POST',
      body: { serverUrl: 'https://caldav.feishu.cn', username: 'u', password: 'p' } });
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.headers['x-csrf-token']).toBe('csrf-token');
  });

  it('creates a CalDAV source and answers a lost response from the receipt of the same mutation', async () => {
    const { calls, queue, source } = makeSource();
    queue.push(() => Promise.reject(new TypeError('fetch failed')));
    queue.push(() => Promise.resolve(respond({ statusCode: 201, response: { id: 's-caldav', kind: 'caldav' } })));
    const body = { clientMutationId: '77777777-7777-4777-8777-777777777777', serverUrl: 'https://caldav.icloud.com', username: 'u',
      password: 'p', calendarUrl: 'https://caldav.icloud.com/1/calendars/home/', name: '家庭', parentId: null, intervalMinutes: 30 };
    const created = await source.sync!.createCaldav(body);
    expect(created).toMatchObject({ id: 's-caldav' });
    expect(calls[0]).toMatchObject({ url: '/api/workspaces/w1/calendar/caldav', method: 'POST', body });
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[1]!.url).toBe(`/api/workspaces/w1/mutations/${body.clientMutationId}`);
  });

  it('patches credentials, lists and resolves conflicts', async () => {
    const { calls, queue, source } = makeSource();
    queue.push(() => Promise.resolve(respond({ id: 's1' })));
    queue.push(() => Promise.resolve(respond({ conflicts: [] })));
    queue.push(() => Promise.resolve(respond({ source: { id: 's1' } })));
    await source.sync!.updateCredentials('s1', { username: 'u', password: 'new' });
    await source.sync!.conflicts('s1');
    await source.sync!.resolveConflict('s1', 'row 1', 'both');
    expect(calls.map(call => [call.method, call.url, call.body])).toEqual([
      ['PATCH', '/api/workspaces/w1/calendar/sync/s1', { credentials: { username: 'u', password: 'new' } }],
      ['GET', '/api/workspaces/w1/calendar/sync/s1/conflicts', undefined],
      ['POST', '/api/workspaces/w1/calendar/sync/s1/conflicts/row%201', { choice: 'both' }],
    ]);
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[2]!.headers['content-type']).toBe('application/json');
  });

  it('turns route errors into codes the dialog can explain', async () => {
    const { queue, source } = makeSource();
    queue.push(() => Promise.resolve(respond({ error: 'AUTH_FAILED' }, 422)));
    queue.push(() => Promise.resolve(respond({ error: 'CREDENTIALS_UNAVAILABLE' }, 503)));
    queue.push(() => Promise.resolve(respond({ error: 'SYNC_RUNNING' }, 409)));
    const account = { serverUrl: 'caldav.example.com', username: 'u', password: 'p' };
    await expect(source.sync!.discoverCaldav(account)).rejects.toMatchObject({ status: 422, code: 'AUTH_FAILED' });
    await expect(source.sync!.discoverCaldav(account)).rejects.toMatchObject({ status: 503, code: 'CREDENTIALS_UNAVAILABLE' });
    await expect(source.sync!.resolveConflict('s1', 'r1', 'local')).rejects.toMatchObject({ status: 409, code: 'SYNC_RUNNING' });
  });

  it('does not copy the external id or locked fields into a detached occurrence of a CalDAV row', async () => {
    const { calls, queue, source } = makeSource();
    const doc = { schemaRevision: '3', rows: [], page: { id: 'db-1', title: '日历', icon: null },
      properties: [{ id: ids.title, name: '名称', type: 'title' }, { id: ids.date, name: '时间', type: 'date' },
        { id: ids.location, name: '地点', type: 'text' }, { id: ids.description, name: '说明', type: 'text' },
        { id: ids.uid, name: '外部 ID', type: 'text' }, { id: ids.note, name: '备注', type: 'text' }],
      views: [{ id: '88888888-8888-4888-8888-888888888888', name: '表格', type: 'table', filters: [], sorts: [], hiddenPropertyIds: [], propertyOrder: [], widths: {} }],
      calendarSync: { kind: 'caldav', readOnlyPropertyIds: [ids.uid], readOnlyRowIds: [],
        fields: { titleId: ids.title, dateId: ids.date, locationId: ids.location, descriptionId: ids.description, uidId: ids.uid } } };
    const series = { id: 'row-1', title: '周会', icon: null, revision: '4', createdAt: '', updatedAt: '',
      properties: { [ids.date]: '2026-11-16|rrule=FREQ=WEEKLY', [ids.location]: '三楼', [ids.description]: '议程', [ids.uid]: 'abc@x', [ids.note]: '自己的' } };
    const route = (input: RequestInfo | URL) => Promise.resolve(respond(String(input).includes('/databases/') ? doc : series));
    queue.push(route, route);
    queue.push(() => Promise.resolve(respond({ id: 'new-row', revision: '1' })));
    await source.createDetachedRow({ databaseId: 'db-1', rowId: 'row-1', propertyId: ids.date, value: '2026-11-23' });
    const created = calls.find(call => call.method === 'POST')!;
    expect(created.body).toMatchObject({ parentId: 'db-1', title: '周会' });
    expect((created.body as { properties: Record<string, unknown> }).properties).toEqual({
      [ids.date]: '2026-11-23', [ids.location]: '三楼', [ids.description]: '议程', [ids.note]: '自己的' });
  });
});
