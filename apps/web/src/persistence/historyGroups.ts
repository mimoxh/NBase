import type { PageVersionSummary } from '@nbase/contracts';

/** Saves this close together with nothing named between them read as one stretch of editing. */
export const historyRunGapMs = 5 * 60_000;

export interface HistoryEntry {
  /** Newest version of the run, shown in the list. */
  version: PageVersionSummary;
  /** Older versions of the same run, newest first; collapsed until expanded. */
  hidden: PageVersionSummary[];
}

export interface HistoryDay {
  key: string;
  label: string;
  entries: HistoryEntry[];
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function dayLabel(date: Date, now: Date): string {
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(now)) return '今天';
  if (dayKey(date) === dayKey(yesterday)) return '昨天';
  return date.getFullYear() === now.getFullYear() ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function collapsible(version: PageVersionSummary): boolean {
  return version.operation === 'update' && version.label === null;
}

/**
 * Groups versions (newest first) by local day and folds runs of plain saves, each within `gapMs` of the next.
 * Named versions and other operations always stand alone.
 */
export function groupHistory(versions: PageVersionSummary[], now: Date, gapMs = historyRunGapMs): HistoryDay[] {
  const days: HistoryDay[] = [];
  let last: PageVersionSummary | null = null;
  for (const version of versions) {
    const saved = new Date(version.savedAt);
    const key = dayKey(saved);
    let day = days.at(-1);
    if (!day || day.key !== key) {
      day = { key, label: dayLabel(saved, now), entries: [] };
      days.push(day);
      last = null;
    }
    const entry = day.entries.at(-1);
    if (entry && last && collapsible(entry.version) && collapsible(version)
      && new Date(last.savedAt).getTime() - saved.getTime() <= gapMs) {
      entry.hidden.push(version);
    } else {
      day.entries.push({ version, hidden: [] });
    }
    last = version;
  }
  return days;
}
