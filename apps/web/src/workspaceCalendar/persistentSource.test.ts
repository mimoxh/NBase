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
    notice: () => undefined, openRow: () => undefined, openDailyNote: () => undefined, ...extra,
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
