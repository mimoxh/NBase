import { describe, expect, it, vi } from 'vitest';
import type { Page, Workspace } from '../workspace/model';
import { setShowDailyNotes, upsertSource } from './settings';
import { createDemoCalendarSource } from './demoSource';

const page = (partial: Partial<Page> & Pick<Page, 'id' | 'title' | 'parentId'>): Page =>
  ({ markdown: '', icon: null, cover: null, starred: false, deleted: false, dirty: false, ...partial });

const dbA = page({ id: 'db-a', title: '任务', parentId: null, kind: 'database', database: { revision: 1,
  properties: [
    { id: 'pa-title', name: '名称', type: 'title' },
    { id: 'pa-date', name: '日期', type: 'date' },
    { id: 'pa-text', name: '备注', type: 'text' },
  ],
  views: [{ id: 'va', name: '全部', type: 'table', filters: [], sorts: [], hiddenPropertyIds: [], propertyOrder: [], widths: {} }] } });
const dbB = page({ id: 'db-b', title: '页面库', parentId: null, kind: 'database', database: { revision: 1,
  properties: [
    { id: 'pb-title', name: '名称', type: 'title' },
    { id: 'pb-created', name: '创建时间', type: 'created_time' },
  ],
  views: [{ id: 'vb', name: '全部', type: 'table', filters: [], sorts: [], hiddenPropertyIds: [], propertyOrder: [], widths: {} }] } });
const rows: Page[] = [
  page({ id: 'r1', title: '评审', parentId: 'db-a', kind: 'row', revision: 3,
    properties: { 'pa-date': '2026-11-16', 'pa-text': '带上材料' }, createdAt: '2026-11-01T08:00:00.000Z' }),
  page({ id: 'r2', title: '发布', parentId: 'db-a', kind: 'row', revision: 1, properties: { 'pa-date': '2026-11-20' } }),
  page({ id: 'r3', title: '记录', parentId: 'db-b', kind: 'row', revision: 1, properties: {}, createdAt: '2026-11-15T08:00:00.000Z' }),
];

function host(pages: Page[] = [dbA, dbB, ...rows]) {
  const state = { current: { pages, currentId: null, view: 'overview', recent: [] } as Workspace };
  const opened: string[] = [];
  const source = createDemoCalendarSource({ state, dispatch: vi.fn(), openPage: id => opened.push(id), notice: vi.fn() });
  return { state, opened, source };
}

describe('demo calendar source', () => {
  it('lists databases with their date-like properties', async () => {
    const { source } = host();
    const { databases } = await source.listDatabases();
    expect(databases.map(db => db.databaseId)).toEqual(['db-a', 'db-b']);
    expect(databases[0]!.dateProperties).toEqual([{ id: 'pa-date', name: '日期', type: 'date' }]);
    expect(databases[1]!.dateProperties).toEqual([{ id: 'pb-created', name: '创建时间', type: 'created_time' }]);
  });

  it('derives events of visible sources with revisions and read-only flags', async () => {
    const { source } = host();
    const events = await source.loadEvents('2026-11-01', '2026-11-30');
    expect(events.events.map(item => [item.rowId, item.propertyId, item.revision, item.readOnly])).toEqual([
      ['r1', 'pa-date', '3', false],
      ['r2', 'pa-date', '1', false],
      ['r3', 'pb-created', '1', true],
    ]);
    expect(events.truncated).toEqual([]);
  });

  it('hides sources switched off in the settings', async () => {
    const { source } = host();
    const settings = await source.loadSettings();
    const db = (await source.listDatabases()).databases[0]!;
    await source.saveSettings(upsertSource(settings, db, 0, { visible: false }));
    const events = await source.loadEvents('2026-11-01', '2026-11-30');
    expect(events.events.map(item => item.rowId)).toEqual(['r3']);
  });

  it('adds databases created later unless new databases are kept out', async () => {
    const { state, source } = host([dbA, ...rows]);
    expect((await source.loadSettings()).sources.map(s => s.databaseId)).toEqual(['db-a']);
    state.current = { ...state.current, pages: [...state.current.pages, dbB] };
    expect((await source.loadSettings()).sources.map(s => s.databaseId)).toEqual(['db-a', 'db-b']);
    const dbC = page({ id: 'db-c', title: '日程', parentId: null, kind: 'database', database: { ...dbA.database!,
      properties: [{ id: 'pc-date', name: '日期', type: 'date' }] } });
    await source.saveSettings({ ...(await source.loadSettings()), autoAdd: false });
    state.current = { ...state.current, pages: [...state.current.pages, dbC] };
    expect((await source.loadSettings()).sources.map(s => s.databaseId)).toEqual(['db-a', 'db-b']);
    expect((await source.listDatabases()).databases.every(db => !db.hidden)).toBe(true);
  });

  it('writes a date value with the expected revision and rejects a stale one', async () => {
    const { state, source } = host();
    expect(await source.writeRowDate({ rowId: 'r1', propertyId: 'pa-date', value: '2026-11-17', expectedRevision: '2' })).toBe(false);
    expect(await source.writeRowDate({ rowId: 'r1', propertyId: 'pa-date', value: '2026-11-17', expectedRevision: '3' })).toBe(true);
    const row = state.current.pages.find(p => p.id === 'r1')!;
    expect(row.properties!['pa-date']).toBe('2026-11-17');
    expect(row.revision).toBe(4);
  });

  it('creates events and detached rows that copy the series row', async () => {
    const { state, source } = host();
    const created = await source.createEvent({ databaseId: 'db-a', propertyId: 'pa-date', value: '2026-11-21' });
    expect(created).toBeTruthy();
    expect(state.current.pages.find(p => p.id === created)).toMatchObject({ kind: 'row', parentId: 'db-a' });

    const detached = await source.createDetachedRow({ databaseId: 'db-a', rowId: 'r1', propertyId: 'pa-date', value: '2026-11-18' });
    const copy = state.current.pages.find(p => p.id === detached)!;
    expect(copy.title).toBe('评审');
    expect(copy.properties).toEqual({ 'pa-date': '2026-11-18', 'pa-text': '带上材料' });
  });

  it('creates a daily note once per day and opens it afterwards', async () => {
    const { state, opened, source } = host();
    source.openDailyNote('2026-11-16');
    expect(opened).toHaveLength(1);
    const note = state.current.pages.find(p => p.id === opened[0])!;
    expect(note.title).toBe('2026-11-16');

    source.openDailyNote('2026-11-16');
    expect(opened).toEqual([note.id, note.id]);
    expect(state.current.pages.filter(p => p.title === '2026-11-16')).toHaveLength(1);

    const settings = setShowDailyNotes(await source.loadSettings(), true);
    await source.saveSettings(settings);
    const events = await source.loadEvents('2026-11-01', '2026-11-30');
    expect(events.dailyNotes).toEqual([{ date: '2026-11-16', pageId: note.id, title: '2026-11-16' }]);
  });

  it('offers no sync endpoints, so the dialog explains that CalDAV needs a server', () => {
    const { source } = host();
    expect(source.persistent).toBe(false);
    expect(source.sync).toBeUndefined();
  });
});
