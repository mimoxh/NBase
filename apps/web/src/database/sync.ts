import type { DatabaseDocument } from '@nbase/contracts';

export const syncedReadOnlyHint = '由订阅同步，只读';

/** Properties rows may not change by hand because a calendar subscription writes them; the title is included when its field is. */
export function lockedPropertyIds(doc: Pick<DatabaseDocument, 'calendarSync' | 'properties'> | null | undefined): ReadonlySet<string> {
  const sync = doc?.calendarSync;
  if (!sync) return new Set();
  const ids = new Set(sync.readOnlyPropertyIds);
  if (ids.has(sync.fields.titleId)) for (const def of doc.properties) if (def.type === 'title') ids.add(def.id);
  return ids;
}
