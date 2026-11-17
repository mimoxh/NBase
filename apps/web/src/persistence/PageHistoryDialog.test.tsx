// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PageHistoryResponse, PageVersion, PageVersionSummary } from '@nbase/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, pageClient } from './client';
import { PageHistoryDialog } from './PageRecoveryDialogs';

vi.mock('../components/Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => <section>{children}</section> }));
vi.mock('../editor/DocumentEditor', () => ({ DocumentEditor: ({ documentId }: { documentId: string }) => <div data-preview={documentId} /> }));
vi.mock('../whiteboard/lazy', () => ({ LazyWhiteboard: () => null }));

const doc = (...texts: string[]) => ({ schemaVersion: 1 as const, editorState: { root: { type: 'root', version: 1,
  children: texts.map(text => ({ type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text }] })) } } });
const minute = (value: number) => new Date(Date.now() - value * 60_000).toISOString();
const summaries: PageVersionSummary[] = [
  { revision: '6', title: '计划', savedAt: minute(1), operation: 'update', deleted: false, label: null, note: null },
  { revision: '5', title: '计划', savedAt: minute(3), operation: 'update', deleted: false, label: null, note: null },
  { revision: '4', title: '计划', savedAt: minute(4), operation: 'update', deleted: false, label: null, note: null },
  { revision: '3', title: '计划', savedAt: minute(30), operation: 'update', deleted: false, label: '评审稿', note: '第一轮' },
  { revision: '2', title: '计划', savedAt: minute(31), operation: 'update', deleted: false, label: null, note: null },
];
const contents: Record<string, string[]> = { '1': ['甲'], '2': ['甲', '乙'], '3': ['甲', '乙', '丙'], '4': ['甲', '丙'],
  '5': ['甲', '丙', '丁'], '6': ['甲', '丙', '丁', '戊'] };
const full = (revision: string): PageVersion => ({
  ...(summaries.find(item => item.revision === revision) ?? { revision, title: '计划', savedAt: minute(60), operation: 'create',
    deleted: false, label: null, note: null }),
  pageId: 'page', parentId: null, icon: null, cover: null, content: doc(...contents[revision]!),
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const mockHistory = () => vi.spyOn(pageClient, 'history').mockImplementation(async (_w, _p, options = {}) => {
  let list = summaries.filter(item => !options.named || item.label);
  if (options.before) list = [...list, full('1')].filter(item => BigInt(item.revision) < BigInt(options.before!));
  const limit = options.limit ?? 30;
  return { versions: list.slice(0, limit), nextBeforeRevision: list.length > limit ? list[limit - 1]!.revision : null } satisfies PageHistoryResponse;
});
const render = async (props: Partial<Parameters<typeof PageHistoryDialog>[0]> = {}) => {
  await act(async () => root.render(<PageHistoryDialog workspaceId="ws" pageId="page" currentRevision="6" busy={false} canWrite
    csrfToken="csrf" onRestore={() => {}} onClose={() => {}} {...props} />));
};
const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.includes(text))!;
const listed = () => [...host.querySelectorAll('[aria-label="版本列表"] .nb-hist-item strong')].map(item => item.textContent);
const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

it('folds a run of close saves, keeps named versions apart and filters to named versions', async () => {
  const history = mockHistory();
  vi.spyOn(pageClient, 'version').mockImplementation(async (_w, _p, revision) => full(revision));
  await render();
  expect(listed().map(text => text?.replace(/^.* · /, ''))).toEqual(['修订 6当前', '修订 3', '修订 2']);
  expect(host.querySelector('.nb-hist-label')?.textContent).toBe('评审稿');
  await act(async () => button('另外 2 次连续保存').click());
  expect(listed()).toHaveLength(5);
  await act(async () => button('已命名').click());
  expect(history).toHaveBeenLastCalledWith('ws', 'page', { before: undefined, named: true }, expect.anything());
  expect(listed().map(text => text?.replace(/^.* · /, ''))).toEqual(['修订 3']);
});

it('opens the name form for the requested revision, saves cleaned text and reports a failed save', async () => {
  mockHistory();
  vi.spyOn(pageClient, 'version').mockImplementation(async (_w, _p, revision) => full(revision));
  const label = vi.spyOn(pageClient, 'labelVersion')
    .mockRejectedValueOnce(new ApiError(401, 'AUTH_REQUIRED'))
    .mockImplementation(async (_w, _p, revision, body) => ({ ...summaries.find(item => item.revision === revision)!, ...body }));
  const onAuthError = vi.fn();
  await render({ nameRevision: '6', onAuthError });
  const name = host.querySelector<HTMLInputElement>('input[aria-label="版本名称"]')!;
  const note = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="版本备注"]')!;
  expect(name.value).toBe('');
  await type(name, '  定稿\t前  ');
  await type(note, ' 备注\r\n第二行 ');
  await act(async () => button('保存名称').click());
  expect(label).toHaveBeenLastCalledWith('ws', 'page', '6', { label: '定稿 前', note: '备注\n第二行' }, 'csrf');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('登录已失效');
  expect(onAuthError).toHaveBeenCalledTimes(1);
  expect(name.value).toBe('  定稿\t前  ');
  await act(async () => button('保存名称').click());
  expect(host.querySelector('input[aria-label="版本名称"]')).toBeNull();
  expect(host.querySelector('.nb-hist-meta-main strong')?.textContent).toBe('定稿 前');
  expect(host.querySelector('.nb-hist-note')?.textContent).toBe('备注\n第二行');
  expect(host.querySelector('[aria-label="版本列表"] .nb-hist-label')?.textContent).toBe('定稿 前');
});

it('compares any two versions in revision order and finds the previous version beyond the loaded list', async () => {
  const history = mockHistory();
  const version = vi.spyOn(pageClient, 'version').mockImplementation(async (_w, _p, revision) => full(revision));
  await render();
  await act(async () => button('修订 2').click());
  await act(async () => host.querySelector<HTMLInputElement>('.nb-hist-toggle input')!.click());
  expect(history).toHaveBeenLastCalledWith('ws', 'page', { before: '2', limit: 1 }, expect.anything());
  expect(host.querySelector('.nb-hist-range')?.textContent).toContain('修订 1');
  expect(host.querySelector('.nb-diff-block-add')?.textContent).toBe('乙');

  const select = host.querySelector<HTMLSelectElement>('select[aria-label="对比版本"]')!;
  await act(async () => { select.value = 'current'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(version).toHaveBeenCalledWith('ws', 'page', '6', expect.anything());
  const range = host.querySelector('.nb-hist-range')!.textContent!;
  expect(range.indexOf('修订 2')).toBeLessThan(range.indexOf('修订 6'));
  expect([...host.querySelectorAll('.nb-diff-block-add')].map(item => item.textContent)).toEqual(['丙', '丁', '戊']);
  expect([...host.querySelectorAll('.nb-diff-block-del')].map(item => item.textContent)).toEqual(['乙']);

  await act(async () => { select.value = 'revision:3'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.querySelector('.nb-hist-range .nb-diff-add-tag')?.textContent).toBe('评审稿');
  expect([...host.querySelectorAll('.nb-diff-block-add')].map(item => item.textContent)).toEqual(['丙']);
});

it('lets a viewer browse and compare but not name or restore', async () => {
  mockHistory();
  vi.spyOn(pageClient, 'version').mockImplementation(async (_w, _p, revision) => full(revision));
  await render({ canWrite: false });
  await act(async () => button('修订 3').click());
  expect(host.querySelector('.nb-hist-meta-main strong')?.textContent).toBe('评审稿');
  expect(button('命名此版本')).toBeUndefined();
  expect(button('编辑名称')).toBeUndefined();
  expect(button('恢复此版本').disabled).toBe(true);
});
