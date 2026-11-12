// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspaceGraphResponse } from '@nbase/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GraphView, LocalGraphView } from './GraphView';
import type { GraphSource } from './model';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no canvas; the view must still work as a list.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const node = (id: string, title: string, parentId: string | null = null) => ({ id, title, icon: null, kind: 'document' as const, parentId, tagIds: [] });
const linked: WorkspaceGraphResponse = { truncated: true, nodes: [node('a', '甲'), node('b', '乙', 'a'), node('c', '丙')],
  edges: [{ source: 'a', target: 'b', kind: 'page-reference', count: 2 }, { source: 'c', target: 'a', kind: 'page-reference', count: 1 }] };
const source = (value: WorkspaceGraphResponse | Error): GraphSource =>
  ({ load: vi.fn(() => value instanceof Error ? Promise.reject(value) : Promise.resolve(value)) });
const render = async (element: React.ReactElement) => { await act(async () => { root.render(element); }); };
// The first load runs on a zero-delay timer.
const loaded = () => act(async () => { await new Promise(done => setTimeout(done, 5)); });
const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.includes(label) || item.getAttribute('aria-label')?.includes(label));

it('shows loading, then the selected page\'s links, and opens through the host callback', async () => {
  const onOpen = vi.fn();
  let resolve!: (data: WorkspaceGraphResponse) => void;
  const pending: GraphSource = { load: () => new Promise(done => { resolve = done; }) };
  await render(<GraphView source={pending} currentPageId="a" onOpen={onOpen} />);
  expect(host.querySelector('[role=status]')?.textContent).toContain('正在读取关系图');
  await loaded();
  await act(async () => { resolve(linked); });
  expect(host.textContent).toContain('3 个页面 · 2 条连线');
  expect(host.textContent).toContain('只显示最近更新的 2000 个页面');
  expect(host.querySelector('canvas')?.getAttribute('aria-label')).toContain('3 个页面');
  // The open page starts selected: one outgoing and one incoming link, both operable by keyboard.
  expect(host.querySelector('.nb-graph-meta')?.textContent).toContain('链接到 1 个页面 · 被 1 个页面链接');
  const rows = [...host.querySelectorAll('.nb-graph-link')];
  expect(rows.map(row => row.textContent)).toEqual(['📄乙×2', '📄丙']);
  await act(async () => { (rows[0] as HTMLButtonElement).click(); });
  expect(onOpen).toHaveBeenCalledWith('b');
  await act(async () => { button('在图中选中「丙」')!.click(); });
  expect(host.querySelector('.nb-graph-side h3')?.textContent).toContain('丙');
  await act(async () => { button('以此为中心')!.click(); });
  expect(host.textContent).toContain('2 个页面 · 1 条连线');
  expect(host.querySelector('input[type=range]')).not.toBeNull();
});

it('filters by title and lists the most connected pages when nothing is selected', async () => {
  await render(<GraphView source={source(linked)} currentPageId={null} onOpen={() => undefined} />);
  await loaded();
  expect([...host.querySelectorAll('.nb-graph-link-title')].map(item => item.textContent)).toEqual(['甲', '丙', '乙']);
  const filter = host.querySelector<HTMLInputElement>('input[type=search]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter, '乙');
    filter.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.textContent).toContain('1 个页面 · 0 条连线');
});

it('explains how to create links when there are none, and reports empty and failed loads', async () => {
  await render(<GraphView source={source({ ...linked, truncated: false, edges: [] })} currentPageId={null} onOpen={() => undefined} />);
  await loaded();
  expect(host.textContent).toContain('还没有页面之间的链接');
  expect(host.textContent).toContain('输入 [[');
  await act(async () => { button('先看页面层级')!.click(); });
  expect(host.textContent).toContain('3 个页面 · 1 条连线');

  await render(<GraphView key="empty" source={source({ nodes: [], edges: [], truncated: false })} currentPageId={null} onOpen={() => undefined} />);
  await loaded();
  expect(host.textContent).toContain('还没有页面');
  expect(host.querySelector('canvas')).toBeNull();

  const failing = source(Object.assign(new Error('x'), { status: 401 }));
  await render(<GraphView key="error" source={failing} currentPageId={null} onOpen={() => undefined} />);
  await loaded();
  expect(host.querySelector('[role=alert]')?.textContent).toContain('登录已失效');
  await act(async () => { button('重试')!.click(); });
  await loaded();
  expect(failing.load).toHaveBeenCalledTimes(2);
});

it('local graph shows the neighbourhood, reloads after a save and keeps the old graph meanwhile', async () => {
  vi.useFakeTimers();
  const onOpen = vi.fn();
  const load = vi.fn<GraphSource['load']>().mockResolvedValueOnce(linked)
    .mockResolvedValueOnce({ ...linked, nodes: [...linked.nodes, node('d', '丁')], edges: [...linked.edges, { source: 'a', target: 'd', kind: 'page-reference', count: 1 }] });
  const local: GraphSource = { load };
  await render(<LocalGraphView source={local} pageId="a" refreshKey="1" onOpen={onOpen} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(host.textContent).toContain('2 个相关页面');
  const chips = () => [...host.querySelectorAll('.nb-graph-chips button')].map(item => item.textContent?.trim());
  expect(chips()).toEqual(['📄 丙', '📄 乙']);
  await render(<LocalGraphView source={local} pageId="a" refreshKey="2" onOpen={onOpen} />);
  expect(load).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('正在刷新');
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(load).toHaveBeenCalledTimes(2);
  expect(chips()).toEqual(['📄 丙', '📄 丁', '📄 乙']);
  await act(async () => { (host.querySelector('.nb-graph-chips button') as HTMLButtonElement).click(); });
  expect(onOpen).toHaveBeenCalledWith('c');

  await render(<LocalGraphView key="alone" source={source({ ...linked, edges: [] })} pageId="c" refreshKey="1" onOpen={onOpen} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(host.textContent).toContain('还没有与其他页面的已保存链接');
});
