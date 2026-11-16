import { describe, expect, it } from 'vitest';
import type { CalendarDatabaseOption, CalendarSettings } from '@nbase/contracts';
import { creationTarget, defaultColorFor, defaultSettingsFor, defaultsForDatabase, setDefaultDatabase,
  setShowDailyNotes, upsertSource } from './settings';

const db = (id: string, types: ('date' | 'created_time' | 'updated_time')[], readOnly: string[] = []): CalendarDatabaseOption => ({
  databaseId: id,
  title: `库 ${id}`,
  icon: null,
  dateProperties: types.map((type, index) => ({ id: `${id}-p${index}`, name: `字段${index}`, type })),
  sync: readOnly.length ? {
    id: 'sync-1', databaseId: id, kind: 'ics-url', name: '订阅', urlHost: 'example.com', intervalMinutes: 60,
    status: 'idle', lastSyncedAt: null, lastError: null, lastCounts: null, warnings: [], eventCount: 0,
    fields: { titleId: 't', dateId: `${id}-p0`, locationId: 'l', descriptionId: 'd', uidId: 'u' }, readOnlyPropertyIds: readOnly,
  } : null,
});

const empty: CalendarSettings = { sources: [], showDailyNotes: true, defaultDatabaseId: null };

describe('defaultsForDatabase', () => {
  it('picks the first date property over created/updated time', () => {
    expect(defaultsForDatabase(db('a', ['created_time', 'date']), 'blue'))
      .toEqual({ databaseId: 'a', propertyId: 'a-p1', color: 'blue', visible: true });
    expect(defaultsForDatabase(db('a', []), 'blue')).toBeNull();
  });
});

describe('upsertSource', () => {
  it('adds an unconfigured database with its defaults, then patches it', () => {
    const database = db('a', ['date', 'date']);
    const added = upsertSource(empty, database, 3, {});
    expect(added.sources).toEqual([{ databaseId: 'a', propertyId: 'a-p0', color: defaultColorFor(3), visible: true }]);
    const patched = upsertSource(added, database, 3, { propertyId: 'a-p1', visible: false, color: 'red' });
    expect(patched.sources).toEqual([{ databaseId: 'a', propertyId: 'a-p1', color: 'red', visible: false }]);
  });

  it('keeps other sources and the rest of the settings untouched', () => {
    const a = upsertSource(empty, db('a', ['date']), 0, {});
    const both = upsertSource(a, db('b', ['date']), 1, {});
    const patched = upsertSource(both, db('a', ['date']), 0, { color: 'green' });
    expect(patched.sources.map(s => s.databaseId)).toEqual(['a', 'b']);
    expect(patched.showDailyNotes).toBe(true);
  });
});

describe('creationTarget', () => {
  it('uses the default database when it has a writable date property', () => {
    const databases = [db('a', ['created_time']), db('b', ['date'])];
    const settings = setDefaultDatabase(empty, 'b');
    expect(creationTarget(databases, settings)).toEqual({ databaseId: 'b', propertyId: 'b-p0' });
  });

  it('falls back to the first writable database and skips read-only sync fields', () => {
    const databases = [db('a', ['date'], ['a-p0']), db('b', ['created_time', 'date'])];
    expect(creationTarget(databases, empty)).toEqual({ databaseId: 'b', propertyId: 'b-p1' });
    expect(creationTarget([db('a', ['created_time'])], empty)).toBeNull();
  });

  it('honors the configured property of the default database', () => {
    const database = db('a', ['date', 'date']);
    const settings = setDefaultDatabase(upsertSource(empty, database, 0, { propertyId: 'a-p1' }), 'a');
    expect(creationTarget([database], settings)).toEqual({ databaseId: 'a', propertyId: 'a-p1' });
  });
});

describe('defaultSettingsFor', () => {
  it('makes every database visible and picks a creation target', () => {
    const settings = defaultSettingsFor([db('a', ['created_time']), db('b', ['date'])]);
    expect(settings.sources).toHaveLength(2);
    expect(settings.sources.every(s => s.visible)).toBe(true);
    expect(settings.defaultDatabaseId).toBe('b');
    expect(settings.showDailyNotes).toBe(true);
  });

  it('has no creation target without writable date fields', () => {
    expect(defaultSettingsFor([db('a', ['created_time'])]).defaultDatabaseId).toBeNull();
  });
});

describe('toggles', () => {
  it('updates daily notes and the default database', () => {
    expect(setShowDailyNotes(empty, false).showDailyNotes).toBe(false);
    expect(setDefaultDatabase(empty, 'a').defaultDatabaseId).toBe('a');
  });
});
