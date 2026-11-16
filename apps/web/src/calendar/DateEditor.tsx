import { useRef, useState, type KeyboardEvent } from 'react';
import { dateCellLimits, parseDateCell, shiftCalendarDay } from '@nbase/contracts';
import { Popover } from '../components/Popover';
import { editorStateFrom, editorValue, reminderOptions, toggleWeekday, withCustom, withIncludeTime, withRepeat, withStartDay,
  type CustomRepeat, type DateEditorState, type RepeatChoice } from './editorState';
import { formatReminder, recurrenceSummary, ruleWeekdayLabel, weekdayLabel } from './format';
import { readerTimeZone, todayIn } from './model';
import { parseDateText } from './parse';
import './calendar.css';

export interface DateEditorProps {
  /** The stored value, or null for an empty cell. */
  value: string | null;
  label: string;
  timeZone?: string;
  className?: string;
  /** Text typed before the editor opened; read once. */
  seed?: (() => string | null) | undefined;
  /** Called with the new value, or null to clear, when it differs from `value`. */
  onCommit: (value: string | null) => void;
  /** The fields did not form a valid value when the editor closed; nothing was saved. */
  onInvalid?: ((message: string) => void) | undefined;
  onClose: () => void;
}

const freqLabels: [CustomRepeat['freq'], string][] = [['DAILY', '天'], ['WEEKLY', '周'], ['MONTHLY', '个月'], ['YEARLY', '年']];

function addHour(time: string): { time: string; nextDay: boolean } {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const total = (Number.isFinite(h) ? h : 9) * 60 + (Number.isFinite(m) ? m : 0) + 60;
  return { time: `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`, nextDay: total >= 1440 };
}

/**
 * Popover for a date value: start, optional end, time, repetition and reminders. Changes are saved when it
 * closes; times are shown and entered on the reader's clock and stored as UTC.
 */
export function DateEditor({ value, label, timeZone = readerTimeZone(), className = 'nb-cal-pop', seed, onCommit, onInvalid, onClose }: DateEditorProps) {
  const today = todayIn(timeZone);
  const [state, setState] = useState<DateEditorState>(() => editorStateFrom(value, timeZone, today));
  const [typed, setTyped] = useState(() => seed?.() ?? '');
  const [typedError, setTypedError] = useState('');
  const touched = useRef(false);
  const done = useRef(false);
  const result = editorValue(state);
  const update = (change: (current: DateEditorState) => DateEditorState) => { touched.current = true; setState(change); };

  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    if (next !== value) onCommit(next);
    onClose();
  };
  const close = () => {
    if (done.current) return;
    if (!touched.current) { done.current = true; onClose(); return; }
    if (!result.ok) { done.current = true; onInvalid?.(result.error); onClose(); return; }
    finish(result.value);
  };
  const typedKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key !== 'Enter') return;
    event.preventDefault();
    if (!typed.trim()) { close(); return; }
    const parsed = parseDateText(typed, timeZone);
    if (!parsed) { setTypedError('无法识别这个日期，可以输入 2026/11/16 或 2026-11-16 09:00'); return; }
    const from = editorStateFrom(parsed, timeZone, today);
    const merged = withIncludeTime({ ...state, ...from, repeat: state.repeat, custom: state.custom, ruleDirty: state.ruleDirty,
      reminders: state.reminders, original: state.original }, from.includeTime);
    const next = editorValue(merged);
    if (!next.ok) { setTypedError(next.error); return; }
    finish(next.value);
  };

  const allDay = !state.includeTime;
  const resultCell = result.ok ? parseDateCell(result.value) : null;
  const summary = resultCell?.rrule ? recurrenceSummary(resultCell.rrule, resultCell.allDay, timeZone, today) : '';
  const keptSummary = state.original?.rrule ? recurrenceSummary(state.original.rrule, state.original.allDay, timeZone, today) : '重复';
  const weekday = weekdayLabel(state.startDay);
  const [, month, day] = state.startDay.split('-').map(Number);
  const options = reminderOptions(allDay).filter(minutes => !state.reminders.includes(minutes));
  const toggleEnd = (on: boolean) => update(current => {
    if (!on) return { ...current, hasEnd: false };
    const end = addHour(current.startTime);
    return { ...current, hasEnd: true, endDay: end.nextDay && current.includeTime ? shiftCalendarDay(current.startDay, 1) : current.startDay, endTime: end.time };
  });

  return <Popover label={`编辑${label}`} className={className} portal width={300} onClose={close}>
    <div className="nb-cal-editor">
      <input className="nb-cal-input" autoFocus aria-label="输入日期" placeholder="输入日期，如 2026/11/16 9:00" value={typed}
        onChange={event => { setTyped(event.target.value); setTypedError(''); }} onKeyDown={typedKey} />
      {typedError && <p className="nb-cal-error" role="alert">{typedError}</p>}
      <div className="nb-cal-field">
        <span className="nb-cal-label">开始</span>
        <input type="date" className="nb-cal-input" aria-label="开始日期" value={state.startDay} required
          onChange={event => { const next = event.target.value; update(current => withStartDay(current, next)); }} />
        {state.includeTime && <input type="time" className="nb-cal-input nb-cal-time-input" aria-label="开始时间" value={state.startTime}
          onChange={event => { const next = event.target.value; update(current => ({ ...current, startTime: next })); }} />}
      </div>
      {state.hasEnd && <div className="nb-cal-field">
        <span className="nb-cal-label">结束</span>
        <input type="date" className="nb-cal-input" aria-label="结束日期" value={state.endDay} min={state.startDay}
          onChange={event => { const next = event.target.value; update(current => ({ ...current, endDay: next })); }} />
        {state.includeTime && <input type="time" className="nb-cal-input nb-cal-time-input" aria-label="结束时间" value={state.endTime}
          onChange={event => { const next = event.target.value; update(current => ({ ...current, endTime: next })); }} />}
      </div>}
      <div className="nb-cal-switches">
        <label className="nb-cal-check"><input type="checkbox" checked={state.hasEnd} onChange={event => toggleEnd(event.target.checked)} />结束日期</label>
        <label className="nb-cal-check"><input type="checkbox" checked={state.includeTime}
          onChange={event => { const next = event.target.checked; update(current => withIncludeTime(current, next)); }} />包含时间</label>
      </div>
      <div className="nb-cal-field">
        <span className="nb-cal-label">重复</span>
        <select className="nb-cal-select" aria-label="重复" value={state.repeat}
          onChange={event => { const next = event.target.value as RepeatChoice; update(current => withRepeat(current, next)); }}>
          {state.repeat === 'kept' && <option value="kept">{keptSummary}</option>}
          <option value="none">不重复</option>
          <option value="daily">每天</option>
          <option value="weekdays">工作日（周一至周五）</option>
          <option value="weekly">每周（{weekday}）</option>
          <option value="monthly">每月（{day} 日）</option>
          <option value="yearly">每年（{month}月{day}日）</option>
          <option value="custom">自定义…</option>
        </select>
      </div>
      {state.repeat === 'kept' && <p className="nb-cal-hint">这条规则来自导入或订阅，这里不能逐项修改，会原样保留。</p>}
      {state.repeat === 'custom' && <div className="nb-cal-custom">
        <div className="nb-cal-field">
          <span className="nb-cal-label">每</span>
          <input type="number" className="nb-cal-input nb-cal-number" aria-label="间隔" min={1} max={dateCellLimits.interval} value={state.custom.interval}
            onChange={event => { const next = Number(event.target.value); update(current => withCustom(current, { interval: next })); }} />
          <select className="nb-cal-select" aria-label="重复单位" value={state.custom.freq}
            onChange={event => { const next = event.target.value as CustomRepeat['freq']; update(current => withCustom(current, { freq: next })); }}>
            {freqLabels.map(([freq, text]) => <option key={freq} value={freq}>{text}</option>)}
          </select>
        </div>
        {state.custom.freq === 'WEEKLY' && <div className="nb-cal-weekday-picks" role="group" aria-label="在这些日子重复">
          {[0, 1, 2, 3, 4, 5, 6].map(index => <button key={index} type="button" aria-pressed={state.custom.weekdays.includes(index)}
            className={`nb-cal-pick ${state.custom.weekdays.includes(index) ? 'on' : ''}`} aria-label={`周${ruleWeekdayLabel(index)}`}
            onClick={() => update(current => toggleWeekday(current, index))}>{ruleWeekdayLabel(index)}</button>)}
        </div>}
        <div className="nb-cal-field">
          <span className="nb-cal-label">结束</span>
          <select className="nb-cal-select" aria-label="重复结束" value={state.custom.end}
            onChange={event => { const next = event.target.value as CustomRepeat['end']; update(current => withCustom(current, { end: next })); }}>
            <option value="never">永不</option>
            <option value="until">于某日</option>
            <option value="count">重复次数</option>
          </select>
          {state.custom.end === 'until' && <input type="date" className="nb-cal-input" aria-label="重复结束日期" value={state.custom.until} min={state.startDay}
            onChange={event => { const next = event.target.value; update(current => withCustom(current, { until: next })); }} />}
          {state.custom.end === 'count' && <><input type="number" className="nb-cal-input nb-cal-number" aria-label="重复次数" min={1} max={dateCellLimits.count}
            value={state.custom.count} onChange={event => { const next = Number(event.target.value); update(current => withCustom(current, { count: next })); }} />次</>}
        </div>
      </div>}
      {summary && state.repeat !== 'kept' && <p className="nb-cal-hint">🔁 {summary}</p>}
      <div className="nb-cal-field nb-cal-field-top">
        <span className="nb-cal-label">提醒</span>
        <div className="nb-cal-reminders">
          {state.reminders.map(minutes => <span key={minutes} className="nb-cal-chip">{formatReminder(minutes, allDay)}
            <button type="button" aria-label={`删除提醒：${formatReminder(minutes, allDay)}`}
              onClick={() => update(current => ({ ...current, reminders: current.reminders.filter(item => item !== minutes) }))}>×</button></span>)}
          {state.reminders.length < dateCellLimits.reminders && options.length > 0 && <select className="nb-cal-select" aria-label="添加提醒" value=""
            onChange={event => { const next = Number(event.target.value); update(current => ({ ...current, reminders: [...current.reminders, next].sort((a, b) => a - b) })); }}>
            <option value="">添加提醒</option>
            {options.map(minutes => <option key={minutes} value={minutes}>{formatReminder(minutes, allDay)}</option>)}
          </select>}
          {!state.reminders.length && !options.length && <span className="nb-cal-hint">无</span>}
        </div>
      </div>
      {state.includeTime && <p className="nb-cal-hint">时间按 {timeZone} 显示和填写</p>}
      {touched.current && !result.ok && <p className="nb-cal-error" role="alert">{result.error}</p>}
      <div className="nb-cal-editor-actions">
        {value !== null && <button type="button" className="nb-btn nb-btn-quiet" onClick={() => finish(null)}>清除</button>}
        <button type="button" className="nb-btn nb-btn-primary" disabled={touched.current && !result.ok} onClick={close}>完成</button>
      </div>
    </div>
  </Popover>;
}
