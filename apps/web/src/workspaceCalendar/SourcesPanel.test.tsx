// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarDatabaseOption, CalendarSettings } from '@nbase/contracts';
import { SourcesPanel } from './SourcesPanel';

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
  vi.unstubAllGlobals();
});

const db = (id: string, hidden: boolean): CalendarDatabaseOption => ({ databaseId: id, title: `库 ${id}`, icon: null,
  dateProperties: [{ id: `${id}-p`, name: '日期', type: 'date' }], sync: null, hidden });
const settings: CalendarSettings = { sources: [], showDailyNotes: true, defaultDatabaseId: null };
const buttons = () => [...host.querySelectorAll('button')];
const checkbox = (label: string) => [...host.querySelectorAll('label')].find(l => l.textContent === label)!.querySelector('input')!;

async function show(props: Partial<Parameters<typeof SourcesPanel>[0]> = {}) {
  const onChange = vi.fn();
  await act(async () => {
    root.render(<SourcesPanel databases={[db('a', false), db('b', true)]} settings={settings} canWrite onChange={onChange} {...props} />);
  });
  return onChange;
}

describe('sources panel', () => {
  it('turns off adding new databases', async () => {
    const onChange = await show();
    expect(checkbox('新数据库自动显示').checked).toBe(true);
    await act(async () => { checkbox('新数据库自动显示').click(); });
    expect(onChange).toHaveBeenCalledWith({ ...settings, autoAdd: false });
  });

  it('offers to show a left-behind sync database in the page tree', async () => {
    let finish = () => undefined as void;
    const onReveal = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await show({ onReveal });
    const reveal = buttons().filter(b => b.textContent === '显示到页面树');
    expect(reveal).toHaveLength(1);
    expect(reveal[0]!.closest('.nb-wcal-source')!.textContent).toContain('库 b');
    await act(async () => { reveal[0]!.click(); });
    expect(onReveal).toHaveBeenCalledWith('b');
    expect(buttons().find(b => b.textContent === '正在显示…')?.disabled).toBe(true);
    await act(async () => { finish(); });
    expect(buttons().find(b => b.textContent === '显示到页面树')?.disabled).toBe(false);
  });

  it('shows no reveal button without the API, for viewers, or while the database still syncs', async () => {
    await show();
    expect(buttons().some(b => b.textContent === '显示到页面树')).toBe(false);
    await show({ onReveal: vi.fn(async () => undefined), canWrite: false });
    expect(buttons().some(b => b.textContent === '显示到页面树')).toBe(false);
    const synced = { ...db('b', true), sync: { id: 's', kind: 'ics-url', status: 'idle', readOnlyPropertyIds: [] } } as unknown as CalendarDatabaseOption;
    await show({ onReveal: vi.fn(async () => undefined), databases: [synced] });
    expect(buttons().some(b => b.textContent === '显示到页面树')).toBe(false);
  });
});
