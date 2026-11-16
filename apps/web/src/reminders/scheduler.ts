import type { CalendarReminderItem } from '@nbase/contracts';

/** Identity of one reminder: the same row, occurrence and lead time must fire only once. */
export function reminderKey(item: Pick<CalendarReminderItem, 'rowId' | 'occurrenceStart' | 'minutes'>): string {
  return `${item.rowId}${item.occurrenceStart}${item.minutes}`;
}

/** Fired reminder keys with the time after which the record may be forgotten. */
export type FiredRecord = Record<string, number>;

export interface ScheduledReminder { item: CalendarReminderItem; at: number; delay: number }

/**
 * Picks the reminders of a fetch window that still need a timer: due in [now - lateMs, now + horizonMs),
 * deduped by key, skipping keys that already fired. Items past the slack are treated as missed and dropped.
 */
export function planReminders(items: readonly CalendarReminderItem[], now: number, fired: ReadonlySet<string>,
  horizonMs: number, lateMs = 60_000): ScheduledReminder[] {
  const seen = new Set<string>();
  const out: ScheduledReminder[] = [];
  for (const item of items) {
    const key = reminderKey(item);
    if (seen.has(key) || fired.has(key)) continue;
    seen.add(key);
    const at = Date.parse(item.at);
    if (Number.isNaN(at) || at < now - lateMs || at >= now + horizonMs) continue;
    out.push({ item, at, delay: Math.max(0, at - now) });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function pruneFired(record: FiredRecord, now: number): FiredRecord {
  const out: FiredRecord = {};
  for (const [key, expiry] of Object.entries(record)) if (expiry > now) out[key] = expiry;
  return out;
}

/**
 * Claims the right to fire a reminder across tabs. The whole record lives under one key, so the read,
 * check and write inside one synchronous call cannot interleave with another tab's claim.
 */
export function claimFire(storage: Pick<Storage, 'getItem' | 'setItem'>, storageKey: string, key: string,
  expiry: number, now: number): boolean {
  let record: FiredRecord = {};
  try {
    const raw = storage.getItem(storageKey);
    if (raw) { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === 'object') record = parsed as FiredRecord; }
  } catch { record = {}; }
  record = pruneFired(record, now);
  if (record[key] !== undefined) return false;
  record[key] = expiry;
  try { storage.setItem(storageKey, JSON.stringify(record)); } catch { return false; }
  return true;
}
