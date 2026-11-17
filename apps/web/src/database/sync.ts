import type { DatabaseDocument } from '@nbase/contracts';

export const syncedReadOnlyHint = '由外部日历同步，只读';

type SyncDoc = Pick<DatabaseDocument, 'calendarSync' | 'properties'> | null | undefined;

/** Properties rows may not change by hand because a calendar sync source writes them; the title is included when its field is. */
export function lockedPropertyIds(doc: SyncDoc): ReadonlySet<string> {
  const sync = doc?.calendarSync;
  if (!sync) return new Set();
  const ids = new Set(sync.readOnlyPropertyIds);
  if (ids.has(sync.fields.titleId)) for (const def of doc.properties) if (def.type === 'title') ids.add(def.id);
  return ids;
}

/** Rows of a CalDAV database whose title and synced fields are read-only although the calendar is writable (events with attendees). */
export function lockedRowIds(doc: SyncDoc): ReadonlySet<string> {
  return new Set(doc?.calendarSync?.readOnlyRowIds ?? []);
}

/** Title and synced fields: what a row listed in `readOnlyRowIds` may not change. */
function rowLockedFields(doc: NonNullable<SyncDoc>): ReadonlySet<string> {
  const sync = doc.calendarSync;
  if (!sync) return new Set();
  const { titleId, dateId, locationId, descriptionId, uidId } = sync.fields;
  const ids = new Set([titleId, dateId, locationId, descriptionId, uidId].filter(Boolean));
  for (const def of doc.properties) if (def.type === 'title') ids.add(def.id);
  return ids;
}

/** Properties one row may not change: the database-wide locks, plus title and synced fields for a read-only row. */
export function lockedPropertyIdsForRow(doc: SyncDoc, rowId: string): ReadonlySet<string> {
  const columns = lockedPropertyIds(doc);
  if (!doc || !lockedRowIds(doc).has(rowId)) return columns;
  return new Set([...columns, ...rowLockedFields(doc)]);
}

/**
 * Lookup of synced locks. Without a row id only database-wide locks count; with one, a read-only row also
 * locks its title and synced fields. A plain `ReadonlySet<string>` fits the same shape.
 */
export interface SyncLocks { has(propertyId: string, rowId?: string): boolean }

export function syncLocks(doc: SyncDoc): SyncLocks & { rows: ReadonlySet<string> } {
  const columns = lockedPropertyIds(doc);
  const rows = lockedRowIds(doc);
  const rowFields = doc && rows.size ? rowLockedFields(doc) : new Set<string>();
  return {
    rows,
    has: (propertyId, rowId) => columns.has(propertyId) || (rowId !== undefined && rows.has(rowId) && rowFields.has(propertyId)),
  };
}

/** Whether a row's title is read-only: the source keeps the title, or the row is one of the read-only rows. */
export function isTitleLocked(doc: SyncDoc, rowId: string): boolean {
  const title = doc?.properties.find(def => def.type === 'title');
  return !!doc?.calendarSync && !!title && lockedPropertyIdsForRow(doc, rowId).has(title.id);
}
