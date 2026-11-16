import type { ReactNode } from 'react';
import { calendarModes, type CalendarMode } from './layout';

export const calendarModeLabels: Record<CalendarMode, string> = { month: '月', week: '周', day: '日', agenda: '日程' };
const stepLabels: Record<CalendarMode, [string, string]> = {
  month: ['上个月', '下个月'], week: ['上一周', '下一周'], day: ['前一天', '后一天'], agenda: ['往前 30 天', '往后 30 天'],
};

export function CalendarHeader({ mode, title, onMode, onStep, onToday, children }: {
  mode: CalendarMode; title: string; onMode: (mode: CalendarMode) => void; onStep: (by: number) => void; onToday: () => void;
  /** Extra content between the title and the mode switch, such as notices. */
  children?: ReactNode;
}) {
  const [previous, next] = stepLabels[mode];
  return <div className="nb-cal-header">
    <div className="nb-cal-nav">
      <button className="nb-btn nb-cal-today-button" onClick={onToday}>今天</button>
      <button className="nb-cal-step" aria-label={previous} title={previous} onClick={() => onStep(-1)}>‹</button>
      <button className="nb-cal-step" aria-label={next} title={next} onClick={() => onStep(1)}>›</button>
      <h2 className="nb-cal-title" aria-live="polite">{title}</h2>
    </div>
    {children && <div className="nb-cal-extra">{children}</div>}
    <div className="nb-cal-modes" role="group" aria-label="日历视图">
      {calendarModes.map(item => <button key={item} className={`nb-cal-mode ${item === mode ? 'on' : ''}`} aria-pressed={item === mode}
        onClick={() => onMode(item)}>{calendarModeLabels[item]}</button>)}
    </div>
  </div>;
}
