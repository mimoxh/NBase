// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SourceEditorDialog, type SourceEditorDialogProps } from './SourceEditorDialog';
import { createContentFromMarkdown } from './markdown';
import { parseSourceEdit, prepareSourceEdit } from './sourceEditing';
import { sourceDraftKey, sourceDraftStore, sameSourceDraftVersion, SourceDraftConflict, type SourceDraft, type SourceDraftScope } from './sourceDrafts';
import type { DocumentEditorProps } from './types';

vi.mock('../components/Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => <section>{children}</section> }));
vi.mock('./sourceEditing', () => ({ parseSourceEdit: vi.fn(), prepareSourceEdit: vi.fn() }));
vi.mock('./DocumentEditor', () => ({ DocumentEditor: ({ readOnly, initialContent, workspaceId }: DocumentEditorProps) =>
  <div data-source-preview data-readonly={String(readOnly)} data-workspace={workspaceId}>{JSON.stringify(initialContent)}</div> }));

const scope = { userId: 'account', workspaceId: 'workspace', pageId: 'page', instanceId: 'editor', baseRevision: '7' };
const original = createContentFromMarkdown('原正文');
let props: SourceEditorDialogProps;
let drafts: Map<string, SourceDraft>;
let root: Root;
let host: HTMLDivElement;
const clone = <T,>(value: T): T => structuredClone(value);

function draft(draftScope: SourceDraftScope = { ...scope, instanceId: 'old-editor' }): SourceDraft {
  return { ...draftScope, key: sourceDraftKey(draftScope), pageKey: JSON.stringify([draftScope.userId, draftScope.workspaceId, draftScope.pageId]),
    source: '恢复的源码', baseContent: createContentFromMarkdown('旧原正文'), baseRevision: '2', sequence: 5, updatedAt: '2026-11-05T09:00:00.000Z' };
}
function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
}
const textarea = () => host.querySelector<HTMLTextAreaElement>('#nbase-source-text')!;
async function edit(text: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), text);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function render(overrides: Partial<SourceEditorDialogProps> = {}) {
  props = { ...props, ...overrides };
  await act(async () => root.render(<SourceEditorDialog {...props} />));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  drafts = new Map();
  props = { scope, initialContent: original, attachmentWorkspaceId: scope.workspaceId,
    onApply: vi.fn(async () => {}), onSaveCopy: vi.fn(async () => {}), onClose: vi.fn() };
  vi.mocked(prepareSourceEdit).mockReturnValue({ source: '原正文', diagnostics: [], canApply: true });
  vi.mocked(parseSourceEdit).mockImplementation(source => ({ content: createContentFromMarkdown(source), diagnostics: [] }));
  vi.spyOn(sourceDraftStore, 'list').mockImplementation(async page => [...drafts.values()]
    .filter(item => item.userId === page.userId && item.workspaceId === page.workspaceId && item.pageId === page.pageId).map(clone));
  vi.spyOn(sourceDraftStore, 'put').mockImplementation(async (value, expected) => {
    const current = drafts.get(value.key);
    if (expected ? !sameSourceDraftVersion(current, expected) : current !== undefined) throw new SourceDraftConflict();
    drafts.set(value.key, clone(value));
  });
  vi.spyOn(sourceDraftStore, 'removeIfVersion').mockImplementation(async version => {
    if (!sameSourceDraftVersion(drafts.get(version.key), version)) return false;
    return drafts.delete(version.key);
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  // Failed source saves deliberately keep a refresh guard until explicit abandonment.
  const discard = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '放弃当前草稿');
  if (discard && !discard.disabled) await act(async () => discard.click());
  await act(() => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('opens and cancels an unchanged session without writing a draft or applying', async () => {
  await render();
  expect(textarea().value).toBe('原正文');
  expect(sourceDraftStore.list).toHaveBeenCalledWith(expect.objectContaining({ userId: scope.userId, workspaceId: scope.workspaceId, pageId: scope.pageId }));
  expect(sourceDraftStore.put).not.toHaveBeenCalled();
  await act(async () => button('取消').click());
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(props.onApply).not.toHaveBeenCalled();
  expect(sourceDraftStore.removeIfVersion).not.toHaveBeenCalled();
});

it('flushes the final rapid input before apply and cleans only the committed source version', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const put = vi.mocked(sourceDraftStore.put).getMockImplementation()!;
  vi.mocked(sourceDraftStore.put).mockImplementationOnce(async (value, expected) => { await held; await put(value, expected); });
  await render();
  await edit('中文'); await edit('中文输入完成');
  const refresh = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(refresh);
  expect(refresh.defaultPrevented).toBe(true);
  await act(() => button('应用').click());
  expect(props.onApply).not.toHaveBeenCalled();
  await act(async () => { release(); await held; });
  expect(props.onApply).toHaveBeenCalledWith(createContentFromMarkdown('中文输入完成'), original, '7');
  expect(sourceDraftStore.removeIfVersion).toHaveBeenCalledWith(expect.objectContaining({ source: '中文输入完成', sequence: 2 }));
  expect(drafts.size).toBe(0);
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it('waits for local persistence when cancelling and keeps the recoverable source record', async () => {
  let release!: () => void;
  const put = vi.mocked(sourceDraftStore.put).getMockImplementation()!;
  vi.mocked(sourceDraftStore.put).mockImplementationOnce(async (value, expected) => {
    await new Promise<void>(resolve => { release = resolve; }); await put(value, expected);
  });
  await render(); await edit('取消仍保留');
  await act(() => button('取消').click());
  expect(props.onClose).not.toHaveBeenCalled();
  await act(async () => release());
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(drafts.get(sourceDraftKey(scope))?.source).toBe('取消仍保留');
  expect(sourceDraftStore.removeIfVersion).not.toHaveBeenCalled();
});

it('preserves input and clipboard access after a local storage failure and blocks apply/close', async () => {
  vi.mocked(sourceDraftStore.put).mockRejectedValueOnce(new Error('QuotaExceededError'));
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await render(); await edit('不能丢失的输入');
  expect(host.textContent).toContain('QuotaExceededError');
  expect(textarea().value).toBe('不能丢失的输入');
  expect(button('应用').disabled).toBe(true);
  await act(async () => button('复制源码').click());
  expect(writeText).toHaveBeenCalledWith('不能丢失的输入');
  await act(async () => button('取消').click());
  expect(props.onClose).not.toHaveBeenCalled();
  expect(props.onApply).not.toHaveBeenCalled();
  await act(async () => button('重试本机保存').click());
  expect(drafts.get(sourceDraftKey(scope))?.source).toBe('不能丢失的输入');
  expect(button('应用').disabled).toBe(false);
});

it('restores another instance explicitly with its original baseline and can save a copy after stale apply', async () => {
  const old = draft(); drafts.set(old.key, old);
  const onApply = vi.fn(async () => { throw new Error('源正文已有更新'); });
  await render({ onApply });
  expect(textarea().value).toBe('原正文');
  expect(sourceDraftStore.put).not.toHaveBeenCalled();
  await act(async () => button('恢复此草稿').click());
  expect(textarea().value).toBe(old.source);
  expect(drafts.get(old.key)).toEqual(old);
  expect(drafts.get(sourceDraftKey(scope))).toMatchObject({ baseRevision: old.baseRevision, baseContent: old.baseContent, source: old.source });
  await act(async () => button('应用').click());
  expect(onApply).toHaveBeenCalledWith(createContentFromMarkdown(old.source), old.baseContent, old.baseRevision);
  expect(host.textContent).toContain('源正文已有更新');
  expect(textarea().value).toBe(old.source);
  expect(sourceDraftStore.removeIfVersion).not.toHaveBeenCalled();
  await act(async () => button('另存为副本').click());
  expect(props.onSaveCopy).toHaveBeenCalledWith(createContentFromMarkdown(old.source));
  expect(drafts.size).toBe(0);
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it('requires explicit restore for the same instance and keeps changes after closing', async () => {
  const old = draft(scope); drafts.set(old.key, old);
  await render();
  expect(textarea().readOnly).toBe(true);
  expect(textarea().value).toBe('原正文');
  await act(async () => button('恢复此草稿').click());
  expect(sourceDraftStore.put).not.toHaveBeenCalled();
  await edit('恢复后继续编辑');
  expect(drafts.get(old.key)).toMatchObject({ source: '恢复后继续编辑', sequence: 6, baseRevision: '2' });
  await act(async () => button('取消').click());
  expect(drafts.get(old.key)?.source).toBe('恢复后继续编辑');
});

it('keeps read-only source views, restored drafts and previews free of local writes', async () => {
  const old = draft(); drafts.set(old.key, old);
  await render({ readOnly: true });
  expect(textarea().readOnly).toBe(true);
  expect(button('应用')).toBeUndefined();
  await act(async () => button('查看此草稿').click());
  expect(textarea().value).toBe(old.source);
  await act(() => button('预览').click());
  expect(host.querySelector('[data-source-preview]')?.getAttribute('data-readonly')).toBe('true');
  expect(host.querySelector('[data-source-preview]')?.getAttribute('data-workspace')).toBe(scope.workspaceId);
  expect(sourceDraftStore.put).not.toHaveBeenCalled();
  expect(sourceDraftStore.removeIfVersion).not.toHaveBeenCalled();
});

it('retains unsafe input and diagnostics without creating a preview or applying', async () => {
  vi.mocked(parseSourceEdit).mockReturnValue({ content: null, diagnostics: ['输入转换无法安全往返'] });
  await render(); await edit('不支持的输入');
  await act(() => button('预览').click());
  expect(host.querySelector('[data-source-preview]')).toBeNull();
  await act(async () => button('应用').click());
  expect(props.onApply).not.toHaveBeenCalled();
  expect(host.textContent).toContain('无法安全往返');
  expect(drafts.get(sourceDraftKey(scope))?.source).toBe('不支持的输入');
});

it('blocks apply for an unrepresentable original and preserves the baseline for inspection', async () => {
  vi.mocked(prepareSourceEdit).mockReturnValue({ source: '投影', diagnostics: ['原正文无法表达'], canApply: false });
  await render(); await edit('修改投影');
  expect(button('应用').disabled).toBe(true);
  expect(host.textContent).toContain('原正文无法表达');
  expect(host.querySelector('.nbase-source-original')?.textContent).toContain('原正文');
  expect(props.onApply).not.toHaveBeenCalled();
});

it('preserves a newer same-instance draft written during apply and prevents duplicate application', async () => {
  await render({ onApply: vi.fn(async () => {
    const saved = drafts.get(sourceDraftKey(scope))!;
    drafts.set(saved.key, { ...saved, source: '其他位置更新', sequence: saved.sequence + 1 });
  }) });
  await edit('本次应用');
  await act(async () => button('应用').click());
  expect(props.onApply).toHaveBeenCalledTimes(1);
  expect(drafts.get(sourceDraftKey(scope))?.source).toBe('其他位置更新');
  expect(host.textContent).toContain('更新过的源码草稿仍保留');
  expect(button('应用').disabled).toBe(true);
  expect(props.onClose).not.toHaveBeenCalled();
});

it('allows explicit abandonment while preserving a poisoned foreign recovered pointer', async () => {
  const foreign = draft({ ...scope, userId: 'another-account', instanceId: 'foreign' });
  drafts.set(foreign.key, foreign);
  const old = draft();
  old.recoveredFrom = [{ ...foreign, userId: scope.userId }];
  drafts.set(old.key, old);
  await render();
  await act(async () => button('恢复此草稿').click());
  await act(async () => button('放弃当前草稿').click());
  expect(drafts.get(foreign.key)).toEqual(foreign);
  expect(drafts.has(old.key)).toBe(false);
  expect(drafts.has(sourceDraftKey(scope))).toBe(false);
  expect(textarea().value).toBe('原正文');
});

it('keeps an old page write isolated when switching pages before its transaction finishes', async () => {
  let release!: () => void;
  const put = vi.mocked(sourceDraftStore.put).getMockImplementation()!;
  vi.mocked(sourceDraftStore.put).mockImplementationOnce(async (value, expected) => {
    await new Promise<void>(resolve => { release = resolve; }); await put(value, expected);
  });
  await render(); await edit('旧页最后输入');
  const nextScope = { ...scope, pageId: 'another-page', instanceId: 'another-editor', baseRevision: '8' };
  await render({ scope: nextScope });
  await act(async () => release());
  expect(textarea().value).toBe('原正文');
  expect(drafts.get(sourceDraftKey(scope))?.source).toBe('旧页最后输入');
  expect(drafts.has(sourceDraftKey(nextScope))).toBe(false);
  expect(props.onApply).not.toHaveBeenCalled();
});
