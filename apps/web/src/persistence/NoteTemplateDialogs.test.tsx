// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NoteTemplate } from '@nbase/contracts';
import { TemplateManagerDialog } from './NoteTemplateDialogs';
import { ApiError } from './client';
import { noteTemplateClient } from './noteTemplateClient';
import { newTemplateWrite, sameTemplateWrite, templateWriteStore, TemplateWriteConflict, type TemplateWrite } from './templateWrites';
import { createContentFromMarkdown } from '../editor/markdown';
import type { DocumentEditorHandle, DocumentEditorProps } from '../editor/types';

vi.mock('../components/Modal', () => ({ Modal: ({ children, onClose }: { children: ReactNode; onClose: () => void }) =>
  <section role="dialog"><button aria-label="关闭对话框" onClick={onClose}>×</button>{children}</section> }));
vi.mock('../editor/DocumentEditor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return { DocumentEditor: forwardRef<DocumentEditorHandle, DocumentEditorProps>(function Editor({ initialContent, readOnly }, ref) {
    useImperativeHandle(ref, () => ({ getSnapshot: () => ({ content: initialContent!, markdown: '', plainText: '', outline: [] }),
      focus: () => {}, insertAttachments: () => {}, replaceContent: () => false, findText: () => false, jumpToHeading: () => {}, locatePageReference: () => false }));
    return <div data-template-editor data-readonly={String(readOnly)}>{JSON.stringify(initialContent)}</div>;
  }) };
});

const scope = { userId: 'account', workspaceId: 'workspace' };
const content = createContentFromMarkdown('独有的待提交模板正文');
const source = { title: '待保存模板', content };
const saved: NoteTemplate = { id: 'template-id', name: source.title, content, builtin: false, revision: '1' };
let records: Map<string, TemplateWrite>;
const mounts: { root: Root; host: HTMLDivElement; mounted: boolean }[] = [];
const clone = <T,>(value: T): T => structuredClone(value);
function button(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label);
  expect(found, 'Missing button ' + label).toBeDefined(); return found!;
}
async function click(host: HTMLElement, label: string) { await act(async () => button(host, label).click()); }
async function mount(overrides: Partial<Parameters<typeof TemplateManagerDialog>[0]> = {}) {
  const props = { ...scope, csrfToken: 'csrf', source, onClose: vi.fn(), ...overrides };
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const mounted = { root, host, mounted: true }; mounts.push(mounted);
  await act(async () => root.render(<TemplateManagerDialog {...props} />));
  return { ...mounted, props, unmount: async () => { if (mounted.mounted) { await act(() => root.unmount()); host.remove(); mounted.mounted = false; } } };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  records = new Map();
  vi.spyOn(noteTemplateClient, 'list').mockResolvedValue([]);
  vi.spyOn(noteTemplateClient, 'create').mockResolvedValue(saved);
  vi.spyOn(noteTemplateClient, 'update').mockResolvedValue({ ...saved, revision: '2' });
  vi.spyOn(noteTemplateClient, 'remove').mockResolvedValue({ deleted: true });
  vi.spyOn(templateWriteStore, 'list').mockImplementation(async current => [...records.values()]
    .filter(record => record.userId === current.userId && record.workspaceId === current.workspaceId).map(clone));
  vi.spyOn(templateWriteStore, 'get').mockImplementation(async (current, mutationId) => clone([...records.values()]
    .find(record => record.userId === current.userId && record.workspaceId === current.workspaceId && record.operation.body.clientMutationId === mutationId)));
  vi.spyOn(templateWriteStore, 'put').mockImplementation(async (record, expected) => {
    const previous = records.get(expected?.key ?? record.key);
    if (expected ? !sameTemplateWrite(previous, expected) : Boolean(previous && !sameTemplateWrite(previous, record))) throw new TemplateWriteConflict();
    if (expected && record.key !== expected.key) records.delete(expected.key);
    records.set(record.key, clone(record));
  });
  vi.spyOn(templateWriteStore, 'removeIfVersion').mockImplementation(async record =>
    sameTemplateWrite(records.get(record.key), record) && records.delete(record.key));
});
afterEach(async () => {
  for (const mount of mounts.splice(0)) {
    if (mount.mounted) await act(() => mount.root.unmount());
    mount.host.remove();
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('durably captures the exact operation before sending and recovers it after close and refresh with the current CSRF', async () => {
  vi.mocked(noteTemplateClient.create).mockRejectedValueOnce(new ApiError(0, 'NETWORK_UNAVAILABLE'));
  const first = await mount();
  await click(first.host, '保存模板');
  expect(vi.mocked(templateWriteStore.put).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(noteTemplateClient.create).mock.invocationCallOrder[0]!);
  const record = [...records.values()][0]!;
  expect(record).toMatchObject({ ...scope, state: 'pending', snapshot: { name: source.title, content } });
  expect(first.host.textContent).toContain('保存结果尚未确认');
  await click(first.host, '关闭'); expect(first.props.onClose).toHaveBeenCalledTimes(1);
  await first.unmount();
  const reopened = await mount({ source: undefined, csrfToken: 'new-csrf' });
  expect(reopened.host.textContent).toContain('本机待处理模板');
  await click(reopened.host, '恢复此模板记录');
  expect(reopened.host.textContent).toContain('独有的待提交模板正文');
  await click(reopened.host, '重试');
  expect(noteTemplateClient.create).toHaveBeenLastCalledWith(scope.workspaceId, record.operation.body, 'new-csrf');
  expect(vi.mocked(noteTemplateClient.create).mock.calls[0]?.[1]).toEqual(vi.mocked(noteTemplateClient.create).mock.calls[1]?.[1]);
  expect(records.size).toBe(0);
  expect(reopened.host.textContent).toContain('已保存个人模板');
});

it('keeps the original ID when an unknown write is retried through an expired session', async () => {
  vi.mocked(noteTemplateClient.create).mockRejectedValueOnce(new ApiError(0, 'TIMEOUT'))
    .mockRejectedValueOnce(new ApiError(401, 'UNAUTHENTICATED'));
  const first = await mount(); await click(first.host, '保存模板');
  const original = clone([...records.values()][0]!);
  await click(first.host, '重试');
  expect([...records.values()][0]).toEqual(original);
  expect(first.host.textContent).toContain('登录已过期');
  expect(first.host.querySelector('[data-template-editor]')?.getAttribute('data-readonly')).toBe('true');
  await first.unmount();
  const again = await mount({ source: undefined, csrfToken: 'after-login' });
  await click(again.host, '恢复此模板记录'); await click(again.host, '重试');
  expect(vi.mocked(noteTemplateClient.create).mock.calls.map(call => call[1])).toEqual([original.operation.body, original.operation.body, original.operation.body]);
  expect(records.size).toBe(0);
});

it.each([403, 404, 409])('does not turn authorization or mutation lookup failures (%i) into a new create ID', async status => {
  vi.mocked(noteTemplateClient.create).mockRejectedValueOnce(new ApiError(status, status === 409 ? 'MUTATION_CONFLICT' : 'NOT_FOUND'));
  const current = await mount(); await click(current.host, '保存模板');
  expect([...records.values()][0]?.state).toBe('pending');
  expect(button(current.host, '新建个人模板').disabled).toBe(true);
  expect(button(current.host, '重试').disabled).toBe(false);
});

it('blocks network and silent close after a local write failure, retains copying, and retries the same ID', async () => {
  vi.mocked(templateWriteStore.put).mockRejectedValueOnce(new Error('QuotaExceededError'));
  vi.mocked(noteTemplateClient.create).mockRejectedValueOnce(new ApiError(0, 'TIMEOUT'));
  const writeText = vi.fn(async (_value: string) => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const current = await mount(); await click(current.host, '保存模板');
  const operation = vi.mocked(templateWriteStore.put).mock.calls[0]![0];
  expect(noteTemplateClient.create).not.toHaveBeenCalled();
  expect(current.host.textContent).toContain('QuotaExceededError');
  const refresh = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(refresh); expect(refresh.defaultPrevented).toBe(true);
  await click(current.host, '关闭'); await click(current.host, '关闭对话框');
  expect(current.props.onClose).not.toHaveBeenCalled();
  await click(current.host, '复制模板 JSON');
  expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual({ name: source.title, content });
  await click(current.host, '重试本机保存');
  expect(noteTemplateClient.create).toHaveBeenCalledWith(scope.workspaceId, operation.operation.body, 'csrf');
  const protectedNow = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(protectedNow); expect(protectedNow.defaultPrevented).toBe(false);
  await click(current.host, '关闭'); expect(current.props.onClose).toHaveBeenCalledTimes(1);
});

it('waits for local commit and does not send a late request after the dialog unmounts', async () => {
  let release!: () => void;
  const put = vi.mocked(templateWriteStore.put).getMockImplementation()!;
  vi.mocked(templateWriteStore.put).mockImplementationOnce(async (record, previous) => {
    await new Promise<void>(resolve => { release = resolve; }); await put(record, previous);
  });
  const current = await mount(); await click(current.host, '保存模板');
  expect(noteTemplateClient.create).not.toHaveBeenCalled();
  const refresh = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(refresh); expect(refresh.defaultPrevented).toBe(true);
  await current.unmount(); await act(async () => release());
  expect(records.size).toBe(1);
  expect(noteTemplateClient.create).not.toHaveBeenCalled();
});

it.each(['list', 'get'] as const)('does not send after unmount during the final stored-record %s check', async method => {
  const current = await mount();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  if (method === 'list') {
    const list = vi.mocked(templateWriteStore.list).getMockImplementation()!;
    vi.mocked(templateWriteStore.list).mockImplementationOnce(async scope => { await held; return list(scope); });
  } else {
    const get = vi.mocked(templateWriteStore.get).getMockImplementation()!;
    vi.mocked(templateWriteStore.get).mockImplementationOnce(async (scope, mutationId) => { await held; return get(scope, mutationId); });
  }
  await click(current.host, '保存模板');
  expect(records.size).toBe(1);
  expect(noteTemplateClient.create).not.toHaveBeenCalled();
  await current.unmount();
  await act(async () => release());
  expect(records.size).toBe(1);
  expect(noteTemplateClient.create).not.toHaveBeenCalled();
});

it('keeps rejected content recoverable and atomically replaces it when explicitly saving a conflict copy', async () => {
  vi.mocked(noteTemplateClient.list).mockResolvedValue([saved]);
  vi.mocked(noteTemplateClient.update).mockRejectedValueOnce(new ApiError(409, 'REVISION_CONFLICT'));
  const current = await mount({ source: undefined }); await click(current.host, saved.name); await click(current.host, '保存模板');
  const rejected = clone([...records.values()][0]!);
  expect(rejected).toMatchObject({ state: 'rejected', failure: 'REVISION_CONFLICT', snapshot: { content } });
  expect(current.host.querySelector('[data-template-editor]')?.getAttribute('data-readonly')).toBe('false');
  await current.unmount();
  const recovered = await mount({ source: undefined }); await click(recovered.host, '恢复此模板记录');
  await click(recovered.host, '保留编辑并另存'); await click(recovered.host, '保存模板');
  const [replacement, previous] = vi.mocked(templateWriteStore.put).mock.calls.at(-1)!;
  expect(previous).toEqual(rejected);
  expect(replacement.operation).toMatchObject({ kind: 'save', id: null, body: { name: source.title, content } });
  expect(replacement.operation.body.clientMutationId).not.toBe(rejected.operation.body.clientMutationId);
  expect(records.size).toBe(0);
});

it('recovers the original delete request and template body after a lost response', async () => {
  vi.mocked(noteTemplateClient.list).mockResolvedValue([saved]);
  vi.mocked(noteTemplateClient.remove).mockRejectedValueOnce(new ApiError(0, 'TIMEOUT'));
  const first = await mount({ source: undefined }); await click(first.host, saved.name);
  await click(first.host, '删除模板'); await click(first.host, '确认删除模板');
  const record = clone([...records.values()][0]!);
  expect(record).toMatchObject({ operation: { kind: 'delete', id: saved.id, body: { expectedRevision: saved.revision } }, snapshot: { name: saved.name, content } });
  await first.unmount();
  const reopened = await mount({ source: undefined }); await click(reopened.host, '恢复此模板记录');
  expect(reopened.host.textContent).toContain('独有的待提交模板正文');
  await click(reopened.host, '重试');
  expect(vi.mocked(noteTemplateClient.remove).mock.calls[1]).toEqual(vi.mocked(noteTemplateClient.remove).mock.calls[0]);
  expect(records.size).toBe(0);
});

it('does not expose or replay another account or workspace pending record', async () => {
  const operation = { kind: 'save' as const, id: null, body: { clientMutationId: 'mutation', name: '另一账号内容', content } };
  const foreign = newTemplateWrite({ ...scope, userId: 'other-account' }, operation, { name: operation.body.name, content });
  records.set(foreign.key, foreign);
  const current = await mount({ source: undefined });
  expect(templateWriteStore.list).toHaveBeenCalledWith(scope);
  expect(current.host.textContent).not.toContain('另一账号内容');
  expect(noteTemplateClient.create).not.toHaveBeenCalled();
});

it('leaves a newer stored version intact when a successful late response cleans its original version', async () => {
  let release!: (value: NoteTemplate) => void;
  vi.mocked(noteTemplateClient.create).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = await mount(); await click(first.host, '保存模板');
  const original = clone([...records.values()][0]!);
  const newer: TemplateWrite = { ...original, version: 'newer', state: 'rejected', failure: 'REVISION_CONFLICT' };
  records.set(original.key, newer);
  await first.unmount();
  const another = await mount({ userId: 'different-account', source: { title: '新账号模板', content: createContentFromMarkdown('其他正文') } });
  await act(async () => release(saved));
  expect(records.get(original.key)).toEqual(newer);
  expect(another.host.textContent).toContain('其他正文');
  expect(another.host.textContent).not.toContain('已保存个人模板');
  expect(templateWriteStore.removeIfVersion).toHaveBeenCalledWith(original);
});

it('retains a confirmed operation after cleanup failure and replays its original endpoint without creating a new ID', async () => {
  vi.mocked(templateWriteStore.removeIfVersion).mockRejectedValueOnce(new Error('cleanup denied'));
  const current = await mount(); await click(current.host, '保存模板');
  const original = clone([...records.values()][0]!);
  expect(current.host.textContent).toContain('服务端已确认');
  await click(current.host, '重试');
  expect(vi.mocked(noteTemplateClient.create).mock.calls.map(call => call[1])).toEqual([original.operation.body, original.operation.body]);
  expect(records.size).toBe(0);
});
