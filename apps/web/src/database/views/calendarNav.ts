import { useState } from 'react';
import type { DayRange } from '@nbase/contracts';
import { agendaMaxDays, agendaPageDays, anchorForMode, isCalendarMode, visibleRange, type CalendarMode, type WeekStart } from '../../calendar/layout';
import { todayIn } from '../../calendar/model';

const storageKey = (viewId: string) => `nbase.calendar.mode.${viewId}`;

function storedMode(viewId: string): CalendarMode {
  try { const value = localStorage.getItem(storageKey(viewId)); return isCalendarMode(value) ? value : 'month'; } catch { return 'month'; }
}

export interface CalendarNav {
  mode: CalendarMode;
  anchor: string;
  agendaDays: number;
  /** Inclusive days on screen, which the query asks for. */
  range: DayRange;
  today: string;
  setMode: (mode: CalendarMode) => void;
  setAnchor: (day: string) => void;
  loadMore: () => void;
}

/** Which days a calendar view shows. The mode is remembered per view in this browser. */
export function useCalendarNav(viewId: string | undefined, timeZone: string, weekStart: WeekStart): CalendarNav {
  const today = todayIn(timeZone);
  const [modes, setModes] = useState<Record<string, CalendarMode>>({});
  const [anchor, setAnchorState] = useState(today);
  const [agendaDays, setAgendaDays] = useState(agendaPageDays);
  const mode = viewId ? modes[viewId] ?? storedMode(viewId) : 'month';
  const setMode = (next: CalendarMode) => {
    if (!viewId || next === mode) return;
    setModes(current => ({ ...current, [viewId]: next }));
    try { localStorage.setItem(storageKey(viewId), next); } catch { /* View preference only. */ }
    setAnchorState(anchorForMode(mode, anchor, weekStart, today, agendaDays));
    setAgendaDays(agendaPageDays);
  };
  const setAnchor = (day: string) => { setAnchorState(day); setAgendaDays(agendaPageDays); };
  const loadMore = () => setAgendaDays(days => Math.min(agendaMaxDays, days + agendaPageDays));
  return { mode, anchor, agendaDays, range: visibleRange(mode, anchor, weekStart, agendaDays), today, setMode, setAnchor, loadMore };
}
