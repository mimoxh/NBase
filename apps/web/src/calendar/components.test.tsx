// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDateCell } from '@nbase/contracts';
import { AgendaList } from './AgendaList';
import { DateEditor } from './DateEditor';
import { buildEvents } from './model';
import { MonthGrid } from './MonthGrid';
import { TimeGrid } from './TimeGrid';

const tz = 'Asia/Shanghai';
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const events = (values: [string, string, boolean?][], from = '2026-10-26', to = '2026-12-06') =>
  buildEvents(values.map(([rowId, value, readOnly]) => ({ sourceId: 'd', rowId, title: rowId, value, readOnly })), { from, to }, tz);

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('month grid', () => {
  it('shows bars, opens from the keyboard and creates all-day events from a day', async () => {
    const onOpen = vi.fn();
    const onCreate = vi.fn();
    const list = events([['会议', '2026-11-16/2026-11-18|rrule=FREQ=MONTHLY|remind=-540'], ['只读', '2026-11-17', true]]);
    await act(() => root.render(<MonthGrid month="2026-11" weekStart={1} today="2026-11-17" timeZone={tz} events={list}
      onOpen={onOpen} onCreate={onCreate} onChange={() => undefined} />));
    const bars = [...host.querySelectorAll<HTMLElement>('.nb-cal-bar')];
    expect(bars.map(bar => bar.textContent)).toEqual(['会议🔁⏰', '只读']);
    expect(bars[0]!.querySelector('.nb-cal-resize')).not.toBeNull();
    expect(bars[1]!.querySelector('.nb-cal-resize')).toBeNull();
    expect(bars[0]!.style.gridColumn).toBe('1 / span 3');
    await act(() => { bars[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ rowId: '只读' }));
    const add = host.querySelector<HTMLButtonElement>('[aria-label="在2026年11月20日 周五新建"]')!;
    await act(() => { add.click(); });
    expect(onCreate).toHaveBeenCalledWith({ start: '2026-11-20', allDay: true });
    expect(host.querySelector('.nb-cal-today')?.getAttribute('data-cal-day')).toBe('2026-11-17');
  });

  it('collapses a full day into "还有 N 项"', async () => {
    const list = events([1, 2, 3, 4, 5].map(n => [`事${n}`, '2026-11-18'] as [string, string]));
    await act(() => root.render(<MonthGrid month="2026-11" weekStart={1} today="2026-11-01" timeZone={tz} events={list} onOpen={() => undefined} />));
    expect(host.querySelectorAll('.nb-cal-bar')).toHaveLength(2);
    expect(host.querySelector('.nb-cal-more-button')?.textContent).toBe('还有 3 项');
    expect(host.querySelector('.nb-cal-add')).toBeNull();
  });
});

describe('time grid', () => {
  it('places timed events by time and spanning ones in the all-day lane', async () => {
    const list = events([['早会', '2026-11-16T01:00:00Z/2026-11-16T01:30:00Z|tz=Asia/Shanghai'], ['出差', '2026-11-16/2026-11-17'],
      ['只读', '2026-11-17T06:00:00Z/2026-11-17T08:00:00Z', true]], '2026-11-16', '2026-11-22');
    const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
    await act(() => root.render(<TimeGrid days={days} today="2026-11-16" timeZone={tz} events={list} onOpen={() => undefined}
      onChange={() => undefined} onCreate={() => undefined} />));
    const blocks = [...host.querySelectorAll<HTMLElement>('.nb-cal-block')];
    expect(blocks.map(block => block.closest('[data-cal-col]')?.getAttribute('data-cal-col'))).toEqual(['2026-11-16', '2026-11-17']);
    expect(blocks[0]!.style.top).toBe(`${(9 * 60 / 1440) * 100}%`);
    expect(blocks[0]!.querySelector('.nb-cal-resize-y')).not.toBeNull();
    expect(blocks[1]!.querySelector('.nb-cal-resize-y')).toBeNull();
    expect(host.querySelector('.nb-cal-allday-lanes .nb-cal-bar')?.textContent).toBe('出差');
    expect(host.querySelectorAll('.nb-cal-now')).toHaveLength(1);
  });
});

describe('agenda', () => {
  it('lists days with events and offers more days', async () => {
    const onMore = vi.fn();
    const list = events([['甲', '2026-11-16T01:00:00Z/2026-11-16T02:00:00Z|tz=Asia/Shanghai'], ['乙', '2026-11-18']], '2026-11-16', '2026-12-15');
    await act(() => root.render(<AgendaList range={{ from: '2026-11-16', to: '2026-12-15' }} today="2026-11-16" timeZone={tz} events={list}
      onOpen={() => undefined} onMore={onMore} />));
    expect([...host.querySelectorAll('.nb-cal-agenda-head')].map(head => head.textContent)).toEqual(['11月16日 周一今天', '11月18日 周三']);
    expect(host.querySelector('.nb-cal-agenda-time')?.textContent).toBe('09:00–10:00');
    await act(() => { host.querySelector<HTMLButtonElement>('.nb-cal-agenda-more')!.click(); });
    expect(onMore).toHaveBeenCalled();
  });
});

describe('date editor', () => {
  it('saves a timed weekly value with a reminder in UTC', async () => {
    const onCommit = vi.fn();
    const onClose = vi.fn();
    await act(() => root.render(<DateEditor value="2026-11-16" label="日期" timeZone={tz} onCommit={onCommit} onClose={onClose} />));
    const query = <T extends Element>(selector: string) => document.body.querySelector<T>(selector)!;
    const includeTime = [...document.body.querySelectorAll<HTMLLabelElement>('.nb-cal-check')].find(label => label.textContent === '包含时间')!;
    await act(() => { includeTime.querySelector('input')!.click(); });
    await act(() => setValue(query<HTMLInputElement>('[aria-label="开始时间"]'), '14:30'));
    await act(() => setValue(query<HTMLSelectElement>('[aria-label="重复"]'), 'weekly'));
    await act(() => setValue(query<HTMLSelectElement>('[aria-label="添加提醒"]'), '10'));
    expect(document.body.querySelector('.nb-cal-hint')?.textContent).toBe('🔁 每周');
    await act(() => { [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '完成')!.click(); });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const cell = parseDateCell(onCommit.mock.calls[0]![0]);
    expect(cell).toMatchObject({ start: '2026-11-16T06:30:00Z', allDay: false, timeZone: tz, rrule: 'FREQ=WEEKLY', reminders: [10] });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps rules it cannot show and clears on request', async () => {
    const onCommit = vi.fn();
    const value = '2026-11-02|rrule=FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1';
    await act(() => root.render(<DateEditor value={value} label="日期" timeZone={tz} onCommit={onCommit} onClose={() => undefined} />));
    const repeat = document.body.querySelector<HTMLSelectElement>('[aria-label="重复"]')!;
    expect(repeat.value).toBe('kept');
    expect(repeat.selectedOptions[0]!.textContent).toContain('自定义规则');
    await act(() => { [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '清除')!.click(); });
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('does not write anything when closed untouched, and accepts typed text', async () => {
    const onCommit = vi.fn();
    const seed = vi.fn(() => '2026/11/20 9:15');
    await act(() => root.render(<DateEditor value={null} label="日期" timeZone={tz} seed={seed} onCommit={onCommit} onClose={() => undefined} />));
    const typed = document.body.querySelector<HTMLInputElement>('[aria-label="输入日期"]')!;
    expect(typed.value).toBe('2026/11/20 9:15');
    await act(() => { typed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onCommit).toHaveBeenCalledWith('2026-11-20T01:15:00Z|tz=Asia/Shanghai');
  });
});
