// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FolderImportDialog } from './FolderImportDialog';
import * as runner from './folderBatchRunner';
import { folderBatchStore, newFolderBatch, type FolderImportBatch } from './folderBatchStore';
import * as planner from './folderPlan';

vi.mock('../components/Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => <section>{children}</section> }));

const props = { userId: 'account', workspaceId: 'workspace', csrfToken: 'csrf', pages: [],
  parseMarkdown: () => ({ content: { schemaVersion: 1, editorState: { root: {} } }, tagNames: [], warnings: [] }),
  onOpenPage: async () => {}, onImported: async () => {}, onClose: () => {} };
const plan: planner.FolderImportPlan = {
  rootName: '本机目录', parentId: null, knownPageIds: [], inputFileCount: 1, inputBytes: 10, attachments: [], issues: [],
  pages: [{ key: 'file:a.md', path: 'a.md', sourcePath: 'a.md', parentKey: null, title: '正文', createId: 'create-id', updateId: 'update-id',
    tagNames: [], pageDependencies: [], attachmentPaths: [] }],
};
const mounts: { root: Root; host: HTMLDivElement }[] = [];
async function mount(overrides: Partial<typeof props> = {}) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); mounts.push({ root, host });
  await act(async () => root.render(<FolderImportDialog {...props} {...overrides} />));
  return { root, host };
}
function button(host: HTMLElement, label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label && !item.disabled)!;
}
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(folderBatchStore, 'list').mockResolvedValue([]); });
afterEach(async () => {
  for (const { root, host } of mounts.splice(0)) { await act(() => root.unmount()); host.remove(); }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('offers both directory selection and scoped durable batches, and resumes a refreshed batch by the saved ID', async () => {
  const batch = newFolderBatch(props, plan);
  batch.pages[0]!.skeleton = { id: 'created-page', revision: '1' };
  vi.mocked(folderBatchStore.list).mockResolvedValue(batch ? [JSON.parse(JSON.stringify(batch)) as FolderImportBatch] : []);
  const run = vi.spyOn(runner, 'runFolderBatch').mockImplementation(async (_scope, _id, _csrf, options) => {
    const completed = { ...batch, pages: [{ ...batch.pages[0]!, status: 'success' as const }] };
    options.onProgress?.(completed); return completed;
  });
  const imported = vi.fn();
  const { host } = await mount({ onImported: imported });
  expect(folderBatchStore.list).toHaveBeenCalledWith({ userId: props.userId, workspaceId: props.workspaceId });
  expect(host.querySelector('input[type=file]')?.hasAttribute('webkitdirectory')).toBe(true);
  expect(host.textContent).toContain('本机批次');
  expect(host.textContent).toContain('打开 正文');
  await act(async () => button(host, '恢复 / 重试未完成项').click());
  expect(run).toHaveBeenCalledWith({ userId: props.userId, workspaceId: props.workspaceId }, batch.id, 'csrf', expect.any(Object));
  expect(imported).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('本批次已完成');
  expect(host.textContent).toContain('已完成 1');
});

it('persists original files and operation IDs before starting requests, preserving preview after quota failure', async () => {
  const source = new File(['正文'], 'a.md');
  vi.spyOn(planner, 'scanMarkdownFolder').mockResolvedValue({ plan, sources: [{ path: 'a.md', file: source }] });
  const save = vi.spyOn(folderBatchStore, 'create').mockRejectedValueOnce(new Error('浏览器空间不足'));
  const run = vi.spyOn(runner, 'runFolderBatch').mockImplementation(async () => { throw new Error('should not start'); });
  const { host } = await mount();
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: [source] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  expect(host.textContent).toContain('导入预览');
  await act(async () => button(host, '保存批次并导入').click());
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ plan }), [{ path: 'a.md', file: source }]);
  expect(run).not.toHaveBeenCalled();
  expect(host.textContent).toContain('浏览器空间不足');
  expect(host.textContent).toContain('导入预览');
});

it('keeps cancel separate from pause and renders durable cancellation with a created skeleton', async () => {
  const batch = newFolderBatch(props, plan);
  batch.pages[0]!.skeleton = { id: 'skeleton', revision: '1' };
  vi.mocked(folderBatchStore.list).mockResolvedValue([batch]);
  const run = vi.spyOn(runner, 'runFolderBatch').mockImplementation(async (_scope, _id, _csrf, options) => {
    expect(options.shouldCancel?.()).toBe(true);
    expect(options.shouldPause?.()).toBe(false);
    return { ...batch, pages: [{ ...batch.pages[0]!, status: 'cancelled' }], paused: '已取消未开始项。' };
  });
  const { host } = await mount();
  await act(async () => button(host, '取消未开始项').click());
  expect(run).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('已取消 1');
  expect(host.textContent).toContain('打开 正文');
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '恢复 / 重试未完成项')?.disabled).toBe(true);
});

it('exports a refreshed batch report and only forgets local records', async () => {
  const batch = newFolderBatch(props, plan);
  vi.mocked(folderBatchStore.list).mockResolvedValue([batch]);
  const remove = vi.spyOn(folderBatchStore, 'remove').mockResolvedValue();
  const createUrl = vi.fn(() => 'blob:report');
  vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const { host } = await mount();
  await act(() => button(host, '导出报告').click());
  expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
  await act(async () => button(host, '清除本机记录').click());
  expect(remove).toHaveBeenCalledWith({ userId: props.userId, workspaceId: props.workspaceId }, batch.id);
  expect(host.textContent).toContain('已创建的页面仍保留');
});
