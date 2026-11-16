import { calendarSourceLimit, type CalendarDatabaseOption, type CalendarSettings, type CalendarSourceSetting,
  type OptionColor } from '@nbase/contracts';

/** Source id of the daily-note markers; real sources are `<databaseId>:<propertyId>`. */
export const dailyNotesSourceId = 'daily-notes';

const palette: OptionColor[] = ['blue', 'green', 'orange', 'purple', 'pink', 'yellow', 'brown', 'red', 'gray', 'default'];

export function defaultColorFor(index: number): OptionColor {
  return palette[((index % palette.length) + palette.length) % palette.length]!;
}

export const optionColorLabels: Record<OptionColor, string> = {
  default: '默认', gray: '灰', brown: '棕', orange: '橙', yellow: '黄', green: '绿', blue: '蓝', purple: '紫', pink: '粉', red: '红',
};

/** The setting a database gets the first time it is switched on: first date property, palette color. */
export function defaultsForDatabase(database: CalendarDatabaseOption, color: OptionColor): CalendarSourceSetting | null {
  const property = database.dateProperties.find(p => p.type === 'date') ?? database.dateProperties[0];
  return property ? { databaseId: database.databaseId, propertyId: property.id, color, visible: true } : null;
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

/** First run: every database visible with its defaults, the first writable one as the creation target. */
export function defaultSettingsFor(databases: readonly CalendarDatabaseOption[]): CalendarSettings {
  const sources = databases.flatMap((db, index) => {
    const setting = defaultsForDatabase(db, defaultColorFor(index));
    return setting ? [setting] : [];
  });
  const settings: CalendarSettings = { sources, showDailyNotes: true, defaultDatabaseId: null };
  return { ...settings, defaultDatabaseId: creationTarget(databases, settings)?.databaseId ?? null };
}
