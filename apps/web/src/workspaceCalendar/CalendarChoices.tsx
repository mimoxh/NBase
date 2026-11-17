import { useMemo, useState } from 'react';
import { calendarConnectLimit, type CalDavCalendarOption, type CalendarConnectChoice } from '@nbase/contracts';

export const colorOf = (color: string | null) => (color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined);

/**
 * A name the server accepts for a database a sync creates: text inputs keep pasted tabs, which the server rejects
 * like other control characters, and the limit counts code points. Empty when nothing is left.
 */
export function databaseName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\p{Cs}/gu, '').trim();
  return [...cleaned].slice(0, 100).join('').trim();
}

const calendarLabel = (option: CalDavCalendarOption) => option.name.trim() || '未命名日历';

interface CalendarPick { checked: boolean; name: string }
type Picks = Record<string, CalendarPick>;

function initialPicks(calendars: readonly CalDavCalendarOption[]): Picks {
  return Object.fromEntries(calendars.map((option, index) => [option.url, { checked: index === 0, name: option.name }]));
}

/**
 * Which of an account's calendars to connect, each with the name of its database (by default the calendar's).
 * The first calendar starts checked. `reset` starts over with a new list.
 */
export function useCalendarChoices(fallbackName: string, initial: readonly CalDavCalendarOption[] = []) {
  const [calendars, setCalendars] = useState<CalDavCalendarOption[]>(() => [...initial]);
  const [picks, setPicks] = useState<Picks>(() => initialPicks(initial));
  const reset = (next: readonly CalDavCalendarOption[]) => { setCalendars([...next]); setPicks(initialPicks(next)); };
  const update = (url: string, change: (pick: CalendarPick) => CalendarPick) => setPicks(current => {
    const pick = current[url];
    return pick ? { ...current, [url]: change(pick) } : current;
  });
  const toggle = (url: string) => update(url, pick => ({ ...pick, checked: !pick.checked }));
  const rename = (url: string, name: string) => update(url, pick => ({ ...pick, name }));
  const chosen = useMemo(() => calendars.filter(option => picks[option.url]?.checked), [calendars, picks]);
  const choices: CalendarConnectChoice[] = chosen.map(option => ({ calendarUrl: option.url,
    name: databaseName(picks[option.url]?.name ?? '') || databaseName(option.name) || fallbackName }));
  return { calendars, picks, chosen, choices, reset, toggle, rename, tooMany: chosen.length > calendarConnectLimit };
}

export type CalendarChoices = ReturnType<typeof useCalendarChoices>;

/** Checkbox list of the calendars; a checked calendar shows the name of the database it gets. */
export function CalendarChoiceList({ choices, disabled }: { choices: CalendarChoices; disabled: boolean }) {
  const { calendars, picks, chosen, toggle, rename, tooMany } = choices;
  const readOnly = chosen.filter(option => !option.writable);
  return <>
    <fieldset className="nb-wcal-caldav-list" disabled={disabled}>
      <legend className="field-label">选择日历</legend>
      {calendars.map(option => {
        const pick = picks[option.url];
        return <div key={option.url} className="nb-wcal-caldav-option">
          <label className="nb-wcal-caldav-pick">
            <input type="checkbox" value={option.url} checked={!!pick?.checked} onChange={() => toggle(option.url)} />
            <span className="nb-wcal-swatch" aria-hidden="true" style={{ background: colorOf(option.color) }} />
            <span className="nb-wcal-source-title">{calendarLabel(option)}</span>
            {!option.writable && <span className="nb-wcal-sync-badge">只读</span>}
          </label>
          {pick?.checked && <input type="text" className="nb-wcal-caldav-dbname" aria-label={`「${calendarLabel(option)}」的数据库名称`}
            value={pick.name} maxLength={100} placeholder="数据库名称" onChange={event => rename(option.url, event.target.value)} />}
        </div>;
      })}
    </fieldset>
    {calendars.length > 1 && <p className="dialog-description nb-wcal-caldav-hint">每个选中的日历各建一个数据库，右侧是数据库名称。</p>}
    {readOnly.length > 0 && <p className="dialog-description">
      {readOnly.length === 1 && chosen.length === 1 ? '这个日历只读' : `${readOnly.map(option => `「${calendarLabel(option)}」`).join('')}只读`}
      ：只会把外部的变化同步到 NBase，NBase 中不能修改同步来的内容。</p>}
    {tooMany && <p className="dialog-description" role="alert">一次最多连接 {calendarConnectLimit} 个日历。</p>}
  </>;
}

/** The start button's label for the checked calendars. */
export const startText = (count: number) => (count > 1 ? `开始同步 ${count} 个日历` : '开始同步');
