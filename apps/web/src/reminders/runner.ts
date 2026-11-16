import { instantText, type CalendarReminderItem, type CalendarRemindersResponse } from '@nbase/contracts';
import { request, workspacePath } from '../persistence/client';
import { claimFire, planReminders, reminderKey, type FiredRecord } from './scheduler';

export interface ReminderRunnerOptions {
  workspaceId: string;
  csrfToken: string;
  /** Opens the row of a fired reminder (notification click, toast action). */
  openRow: (rowId: string) => void;
  /** In-page fallback when browser notifications are unavailable or denied. */
  toast: (text: string) => void;
  timeZone?: string;
  pollMs?: number;
  horizonMs?: number;
  storage?: Storage | null;
  now?: () => number;
}

export function reminderPermission(): 'granted' | 'denied' | 'default' | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export async function requestReminderPermission(): Promise<ReturnType<typeof reminderPermission>> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

const firedKey = (workspaceId: string) => `nbase.calendar.reminders-fired.${workspaceId}`;
const dayMs = 86_400_000;

function occurrenceText(item: CalendarReminderItem, timeZone: string): string {
  if (item.occurrenceStart.includes('T')) {
    const ms = Date.parse(item.occurrenceStart);
    if (!Number.isNaN(ms)) {
      return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone }).format(ms);
    }
  }
  return item.occurrenceStart;
}

/**
 * Polls the reminder window while the persistent workspace is open and fires each reminder once per
 * browser: the claim lives in localStorage, and a BroadcastChannel tells the other tabs to stand down.
 * Fired keys expire a day after their moment, so a reload does not repeat them.
 */
export function startReminderRunner(options: ReminderRunnerOptions): () => void {
  const now = options.now ?? (() => Date.now());
  const pollMs = options.pollMs ?? 5 * 60_000;
  const horizonMs = options.horizonMs ?? 20 * 60_000;
  const zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const storage = options.storage === undefined ? (() => { try { return localStorage; } catch { return null; } })() : options.storage;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const fired = new Set<string>();
  let stopped = false;
  const channel = typeof BroadcastChannel === 'undefined' ? null
    : new BroadcastChannel(`nbase.calendar.reminders.${options.workspaceId}`);

  const readFired = (): FiredRecord => {
    if (!storage) return {};
    try {
      const raw = storage.getItem(firedKey(options.workspaceId));
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed as FiredRecord : {};
    } catch { return {}; }
  };

  const notify = (item: CalendarReminderItem) => {
    const title = item.title || '未命名';
    const body = `开始于 ${occurrenceText(item, zone)}`;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const notification = new Notification(`提醒：${title}`, { body, tag: reminderKey(item) });
        notification.onclick = () => { window.focus(); options.openRow(item.rowId); notification.close(); };
        return;
      } catch { /* Notifications can throw when constructed outside a gesture; fall back to the toast. */ }
    }
    options.toast(`提醒：${title} · ${body}`);
  };

  const fire = (item: CalendarReminderItem) => {
    const key = reminderKey(item);
    timers.delete(key);
    if (fired.has(key)) return;
    const at = Date.parse(item.at);
    const expiry = (Number.isNaN(at) ? now() : at) + dayMs;
    if (storage && !claimFire(storage, firedKey(options.workspaceId), key, expiry, now())) return;
    fired.add(key);
    channel?.postMessage({ fired: key });
    notify(item);
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const response = await request<CalendarRemindersResponse>(`${workspacePath(options.workspaceId)}/calendar/reminders`, 'POST',
        { from: instantText(now()), to: instantText(now() + horizonMs), context: { timeZone: zone } }, options.csrfToken);
      if (stopped) return;
      const keys = new Set([...fired, ...Object.keys(readFired())]);
      for (const plan of planReminders(response.items, now(), keys, horizonMs)) {
        const key = reminderKey(plan.item);
        if (timers.has(key)) continue;
        timers.set(key, setTimeout(() => fire(plan.item), plan.delay));
      }
    } catch { /* The next poll retries. */ }
  };

  channel?.addEventListener('message', event => {
    const key = (event.data as { fired?: unknown } | null)?.fired;
    if (typeof key !== 'string') return;
    fired.add(key);
    const timer = timers.get(key);
    if (timer) { clearTimeout(timer); timers.delete(key); }
  });

  void poll();
  const interval = setInterval(() => void poll(), pollMs);
  return () => {
    stopped = true;
    clearInterval(interval);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    channel?.close();
  };
}
