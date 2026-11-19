// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SearchResponse, WorkspaceHistorySearchResponse, WorkspaceHistorySearchResult } from '@nbase/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, pageClient } from './client';
import { PersistentSearchDialog } from './PersistentSearchDialog';

vi.mock('../components/Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => <section>{children}</section> }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Element.prototype.scrollIntoView = () => {};
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
const type = async (element: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const historyResult = (pageId: string, title: string, currentMatches: boolean): WorkspaceHistorySearchResult => ({
  pageId, title, icon: null, parentId: null, matchingVersions: currentMatches ? 1 : 3, currentMatches,
  version: { revision: '4', title, savedAt: new Date(2026, 10, 1, 9, 30).toISOString(), operation: 'update', deleted: false,
    label: null, note: null, actor: { userId: 'u1', loginName: 'alice' }, snippet: '…旧的预算草稿…', matchField: 'content' },
});
const render = async (onOpenHistory?: (result: WorkspaceHistorySearchResult, phrase: string) => void, onAuthError = () => {}) => {
  await act(async () => root.render(<PersistentSearchDialog workspaceId="ws" pages={[]} recentPages={[]} onOpen={() => {}}
    onOpenHistory={onOpenHistory} onCommand={() => {}} onClose={() => {}} onAuthError={onAuthError} />));
};
const input = () => host.querySelector<HTMLInputElement>('input[aria-label="搜索标题或正文"]')!;
const historyToggle = () => [...host.querySelectorAll('label')].find(item => item.textContent === '同时搜索历史版本')
  ?.querySelector('input') ?? null;

it('searches history only when asked, lists history-only pages and opens the matching version', async () => {
  vi.spyOn(pageClient, 'search').mockResolvedValue({ results: [], truncated: false } satisfies SearchResponse);
  const history = vi.spyOn(pageClient, 'historySearch').mockResolvedValue({
    results: [historyResult('p1', '预算', false), historyResult('p2', '周报', true)], truncated: false, pendingVersions: 12,
  } satisfies WorkspaceHistorySearchResponse);
  const open = vi.fn();
  await render(open);
  await type(input(), '预算');
  await settle();
  expect(history).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('历史版本中');

  await act(async () => historyToggle()!.click());
  expect(host.textContent).toContain('正在搜索历史版本…');
  await settle();
  expect(history).toHaveBeenLastCalledWith('ws', '预算', expect.anything(), []);
  const options = [...host.querySelectorAll('[role="option"]')];
  expect(options).toHaveLength(2);
  expect(options[0]!.textContent).toContain('仅在历史版本中 · 3 个版本匹配');
  expect(options[0]!.textContent).toContain('修订 4');
  expect(options[0]!.textContent).toContain('alice');
  expect(options[0]!.querySelector('mark')?.textContent).toBe('预算');
  expect(options[1]!.textContent).toContain('当前版本仍包含');
  expect(host.querySelector('[role="note"]')?.textContent).toContain('还有 12 个较早的版本');

  await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ pageId: 'p1' }), '预算');
});

it('hides the history option without a handler and reports a failed history search apart from the page results', async () => {
  vi.spyOn(pageClient, 'search').mockResolvedValue({ results: [], truncated: false });
  await render();
  expect(historyToggle()).toBeNull();

  const onAuthError = vi.fn();
  const history = vi.spyOn(pageClient, 'historySearch').mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE'))
    .mockResolvedValue({ results: [], truncated: false, pendingVersions: 0 });
  await render(() => {}, onAuthError);
  await act(async () => historyToggle()!.click());
  await type(input(), '预算');
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('历史版本搜索暂时不可用');
  expect(host.textContent).toContain('当前页面中没有匹配的内容。');
  await act(async () => [...host.querySelectorAll('[role="alert"] button')][0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle();
  expect(history).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain('历史版本中没有匹配的内容。');
  expect(onAuthError).not.toHaveBeenCalled();
});
