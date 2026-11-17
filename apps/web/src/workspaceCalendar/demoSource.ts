import { activeProperties, calendarSourceRowCap, defaultCalendarSettings, isCalendarProperty, rowValueProblem, withAutoAddedSources,
  type CalendarDatabaseOption, type CalendarEventItem, type CalendarEventsResponse, type CalendarSettings, type RowProperties } from '@nbase/contracts';
import { workspaceReducer, type Action, type Page, type Workspace } from '../workspace/model';
import { copiedProperties } from '../database/views/CalendarView';
import type { WorkspaceCalendarSource } from './source';

const isRowPage = (page: Page) => page.kind === 'row' && !page.deleted;

/**
 * Session-only calendar storage for the demo workspace. Databases and rows come from the in-memory
 * workspace; settings and daily notes live in this closure. Writes run the reducer on a local copy
 * first, so a read right after a write sees the change before React re-renders.
 */
export function createDemoCalendarSource(options: {
  state: { current: Workspace };
  dispatch: (action: Action) => void;
  openPage: (id: string) => void;
  notice: (text: string) => void;
}): WorkspaceCalendarSource {
  let stored: CalendarSettings = defaultCalendarSettings;
  /** Like the server: databases the settings do not mention join while `autoAdd` is on. */
  const effective = () => withAutoAddedSources(stored, databases());
  const dailyNotes = new Map<string, string>();

  const apply = (action: Action) => {
    options.state.current = workspaceReducer(options.state.current, action);
    options.dispatch(action);
  };
  const databases = (): CalendarDatabaseOption[] => options.state.current.pages
    .filter(page => page.kind === 'database' && !page.deleted && page.database)
    .map(page => ({
      databaseId: page.id,
      title: page.title,
      icon: page.icon,
      dateProperties: activeProperties(page.database!.properties).filter(isCalendarProperty)
        .map(def => ({ id: def.id, name: def.name, type: def.type as 'date' | 'created_time' | 'updated_time' })),
      sync: null,
      hidden: false,
    }))
    .filter(db => db.dateProperties.length > 0);
  const databasePage = (id: string) => {
    const page = options.state.current.pages.find(p => p.id === id && p.kind === 'database' && !p.deleted && p.database);
    if (!page) throw new Error('数据库不存在或已移入回收站。');
    return page;
  };
  const rowPage = (id: string) => {
    const page = options.state.current.pages.find(p => p.id === id && isRowPage(p));
    if (!page) throw new Error('这一行已不存在。');
    return page;
  };
  const insertRow = (databaseId: string, title: string, properties: RowProperties): string => {
    const database = databasePage(databaseId);
    for (const [key, value] of Object.entries(properties)) {
      if (rowValueProblem(database.database!.properties, key, value)) throw new Error('这个值不符合字段设置，未保存。');
    }
    const now = new Date().toISOString();
    const page: Page = { id: crypto.randomUUID(), title, parentId: databaseId, markdown: '', icon: null, cover: null,
      starred: false, deleted: false, dirty: true, kind: 'row', properties,
      revision: 1, createdAt: now, updatedAt: now };
    apply({ type: 'insert', page });
    return page.id;
  };

  return {
    persistent: false,
    canWrite: true,
    listDatabases: async () => ({ databases: databases() }),
    loadSettings: async () => structuredClone(effective()),
    saveSettings: async next => { stored = structuredClone(next); },
    loadEvents: async (from, to) => {
      const settings = effective();
      const events: CalendarEventItem[] = [];
      const truncated: string[] = [];
      for (const source of settings.sources) {
        if (!source.visible) continue;
        const db = options.state.current.pages.find(p => p.id === source.databaseId && p.kind === 'database' && !p.deleted && p.database);
        if (!db) continue;
        const def = activeProperties(db.database!.properties).find(p => p.id === source.propertyId && isCalendarProperty(p));
        if (!def) continue;
        const rows = options.state.current.pages.filter(p => p.parentId === db.id && isRowPage(p));
        let kept = 0;
        for (const row of rows) {
          const raw = def.type === 'date' ? row.properties?.[def.id] : def.type === 'created_time' ? row.createdAt : row.updatedAt;
          if (raw === undefined || raw === null || raw === '') continue;
          kept += 1;
          if (kept > calendarSourceRowCap) { truncated.push(db.id); break; }
          events.push({ databaseId: db.id, propertyId: def.id, rowId: row.id, title: row.title, icon: row.icon,
            value: String(raw), revision: String(row.revision ?? 1), readOnly: def.type !== 'date' });
        }
      }
      const notes = [...dailyNotes.entries()].filter(([date]) => date >= from && date <= to)
        .flatMap(([date, pageId]) => {
          const page = options.state.current.pages.find(p => p.id === pageId && !p.deleted);
          return page ? [{ date, pageId, title: page.title }] : [];
        });
      const response: CalendarEventsResponse = { events, dailyNotes: notes, truncated };
      return structuredClone(response);
    },
    writeRowDate: async ({ rowId, propertyId, value, expectedRevision }) => {
      const row = rowPage(rowId);
      if (String(row.revision ?? 1) !== expectedRevision) return false;
      const database = databasePage(row.parentId!);
      if (rowValueProblem(database.database!.properties, propertyId, value)) throw new Error('这个值不符合字段设置，未保存。');
      apply({ type: 'row-update', id: rowId, at: new Date().toISOString(), properties: { [propertyId]: value } });
      return true;
    },
    createEvent: async ({ databaseId, propertyId, value }) => insertRow(databaseId, '', { [propertyId]: value }),
    createDetachedRow: async ({ databaseId, rowId, propertyId, value }) => {
      const series = rowPage(rowId);
      const database = databasePage(databaseId);
      const copied = copiedProperties(
        { id: series.id, title: series.title, icon: series.icon, properties: series.properties ?? {},
          revision: String(series.revision ?? 1), createdAt: series.createdAt ?? '', updatedAt: series.updatedAt ?? '' },
        database.database!.properties, new Set());
      return insertRow(databaseId, series.title, { ...copied, [propertyId]: value });
    },
    openRow: options.openPage,
    openDatabase: options.openPage,
    openDailyNote: (date, pageId) => {
      const existing = pageId ?? dailyNotes.get(date);
      const page = existing ? options.state.current.pages.find(p => p.id === existing && !p.deleted) : undefined;
      if (page) { options.openPage(page.id); return; }
      const created: Page = { id: crypto.randomUUID(), title: date, parentId: null, markdown: '', icon: '📓', cover: null,
        starred: false, deleted: false, dirty: true };
      apply({ type: 'insert', page: created });
      dailyNotes.set(date, created.id);
      options.openPage(created.id);
    },
    notice: options.notice,
  };
}
