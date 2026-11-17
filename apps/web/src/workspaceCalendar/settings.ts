import { calendarPaletteColor, calendarSourceLimit, defaultCalendarSource, type CalendarDatabaseOption, type CalendarSettings,
  type CalendarSourceSetting, type OptionColor } from '@nbase/contracts';

/** Source id of the daily-note markers; real sources are `<databaseId>:<propertyId>`. */
export const dailyNotesSourceId = 'daily-notes';

/** The color a database gets by its position in the sources list, as the server picks it. */
export const defaultColorFor = calendarPaletteColor;

export const optionColorLabels: Record<OptionColor, string> = {
  default: '默认', gray: '灰', brown: '棕', orange: '橙', yellow: '黄', green: '绿', blue: '蓝', purple: '紫', pink: '粉', red: '红',
};

/** The setting a database gets the first time it is switched on: first date property, palette color. */
export function defaultsForDatabase(database: CalendarDatabaseOption, color: OptionColor): CalendarSourceSetting | null {
  const setting = defaultCalendarSource(database.databaseId, database.dateProperties, 0);
  return setting ? { ...setting, color } : null;
}

/** Adds or replaces the one source entry of a database; unconfigured databases start from their defaults. */
export function upsertSource(settings: CalendarSettings, database: CalendarDatabaseOption, colorIndex: number,
  patch: Partial<Omit<CalendarSourceSetting, 'databaseId'>>): CalendarSettings {
  const existing = settings.sources.find(s => s.databaseId === database.databaseId);
  const base = existing ?? defaultsForDatabase(database, defaultColorFor(colorIndex));
  if (!base) return settings;
  const next: CalendarSourceSetting = { ...base, ...patch, databaseId: database.databaseId };
  const sources = existing ? settings.sources.map(s => (s.databaseId === database.databaseId ? next : s)) : [...settings.sources, next];
  return { ...settings, sources: sources.slice(0, calendarSourceLimit) };
}

export function setShowDailyNotes(settings: CalendarSettings, showDailyNotes: boolean): CalendarSettings {
  return { ...settings, showDailyNotes };
}

export function setAutoAdd(settings: CalendarSettings, autoAdd: boolean): CalendarSettings {
  return { ...settings, autoAdd };
}

export function setDefaultDatabase(settings: CalendarSettings, defaultDatabaseId: string | null): CalendarSettings {
  return { ...settings, defaultDatabaseId };
}

/** Where a created event goes: the chosen default, else the first database with a writable date property. */
export function creationTarget(databases: readonly CalendarDatabaseOption[], settings: CalendarSettings):
  { databaseId: string; propertyId: string } | null {
  const writable = (db: CalendarDatabaseOption, propertyId: string): string | null => {
    const property = db.dateProperties.find(p => p.id === propertyId);
    return property?.type === 'date' && !db.sync?.readOnlyPropertyIds.includes(property.id) ? property.id : null;
  };
  const forDatabase = (db: CalendarDatabaseOption) => {
    const configured = settings.sources.find(s => s.databaseId === db.databaseId)?.propertyId;
    if (configured) { const ok = writable(db, configured); if (ok) return { databaseId: db.databaseId, propertyId: ok }; }
    const first = db.dateProperties.find(p => writable(db, p.id));
    return first ? { databaseId: db.databaseId, propertyId: first.id } : null;
  };
  if (settings.defaultDatabaseId) {
    const chosen = databases.find(db => db.databaseId === settings.defaultDatabaseId);
    const target = chosen && forDatabase(chosen);
    if (target) return target;
  }
  for (const db of databases) { const target = forDatabase(db); if (target) return target; }
  return null;
}
