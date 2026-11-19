// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import { AppearanceSettings, SettingsDialog } from './SettingsDialog';
import type { ReadingPrefs } from './readingPrefs';
import type { ThemePreference } from './theme';

vi.mock('../components/Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => <section role="dialog">{children}</section> }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent === text);
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

it('keeps a visited section mounted, with its input, while another section is shown', async () => {
  await act(async () => root.render(<SettingsDialog onClose={() => {}} sections={[
    { key: 'one', label: '第一', icon: 'sun', content: <input aria-label="草稿" /> },
    { key: 'two', label: '第二', icon: 'users', content: <p>第二项内容</p> },
  ]} />));
  expect(host.querySelectorAll('[role="tabpanel"]').length).toBe(1);
  type(host.querySelector<HTMLInputElement>('[aria-label="草稿"]')!, '未保存');
  await act(async () => button('第二')!.click());
  const panels = [...host.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
  expect(panels.map(panel => panel.hidden)).toEqual([true, false]);
  expect(button('第二')!.getAttribute('aria-selected')).toBe('true');
  await act(async () => button('第一')!.click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="草稿"]')!.value).toBe('未保存');
});

it('changes theme and reading preferences from the appearance section', async () => {
  const seen: { theme: ThemePreference; reading: ReadingPrefs }[] = [];
  function Harness() {
    const [theme, setTheme] = useState<ThemePreference>('system');
    const [reading, setReading] = useState<ReadingPrefs>({ focus: false, wide: false, size: 'normal' });
    seen.push({ theme, reading });
    return <AppearanceSettings theme={theme} onTheme={setTheme} reading={reading} onReading={patch => setReading(value => ({ ...value, ...patch }))} />;
  }
  await act(async () => root.render(<Harness />));
  expect(button('跟随系统')!.getAttribute('aria-checked')).toBe('true');
  await act(async () => button('深色')!.click());
  await act(async () => button('大')!.click());
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="全宽页面"]')!.click());
  expect(seen.at(-1)).toEqual({ theme: 'dark', reading: { focus: false, wide: true, size: 'large' } });
  expect(button('深色')!.getAttribute('aria-checked')).toBe('true');
});

const sidebarProps = {
  workspaceName: '团队', loginName: 'owner', onLogout: () => {}, onSearch: () => {}, onTrash: () => {},
  createBusy: false, pages: [], activeId: null, favorites: new Set<string>(), recentPages: [], favoritePages: [],
  treeLoading: false, treeError: '', onTreeRetry: () => {}, open: false, onClose: () => {},
  treeActions: { onOpen: () => {} } as never,
};

it('groups creation under the "+" menu and opens settings from the footer and the account menu', async () => {
  const settings = vi.fn();
  const database = vi.fn();
  await act(async () => root.render(<Sidebar {...sidebarProps} onSettings={settings} onNewPage={() => {}} onNewDatabase={database}
    onImport={() => {}} />));
  expect(button('新建页面')).toBeUndefined();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="新建"]')!.click());
  expect([...host.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['新建页面', '新建数据库', '导入 Markdown']);
  await act(async () => button('新建数据库')!.click());
  expect(database).toHaveBeenCalledOnce();
  await act(async () => button('设置')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="工作区菜单"]')!.click());
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === '设置')!.click());
  expect(settings).toHaveBeenCalledTimes(2);
});

it('has no create menu for members who cannot write', async () => {
  await act(async () => root.render(<Sidebar {...sidebarProps} onSettings={() => {}} onNewPage={() => {}} canCreate={false} />));
  expect(host.querySelector('[aria-label="新建"]')).toBeNull();
  expect(button('回收站')).toBeTruthy();
});
