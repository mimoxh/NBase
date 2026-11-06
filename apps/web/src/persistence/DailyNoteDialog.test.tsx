// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { quickCaptureMarker, type DailyNoteStatus } from '@nbase/contracts';
import { $getRoot, createEditor } from 'lexical';
import { afterEach, expect, it, vi } from 'vitest';
import { $createSnapshot, createContentFromMarkdown } from '../editor/markdown';
import { EDITOR_NODES } from '../editor/nodes';
import { DailyNoteDialog, dailyClient } from './DailyNoteDialog';
import { ApiError } from './client';

vi.mock('../components/Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => <section>{children}</section> }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const initial: DailyNoteStatus = {
  date: '2026-11-04',
  today: '2026-11-04',
  settings: { timeZone: 'Asia/Shanghai', parentId: null, templateId: null },
  page: null,
};

const props = {
  workspaceId: 'workspace', templates: [], parents: [],
  onClose: () => {}, onOpenPage: () => {}, onRestorePage: () => {},
  onCreate: async () => {}, onCapture: async () => {}, onSaveSettings: async () => {},
};

it('retains record text and pins the target date across connection failure and retry', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.setSystemTime(new Date('2026-11-04T15:59:59.000Z'));
  const query = vi.spyOn(dailyClient, 'status').mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new ApiError(0, 'NETWORK_UNAVAILABLE'))
    .mockResolvedValueOnce({ ...initial, today: '2026-11-05', page: { id: 'daily', revision: '3', deleted: false } });
  const capture = vi.fn().mockRejectedValueOnce(new ApiError(0, 'NETWORK_UNAVAILABLE')).mockResolvedValueOnce(undefined);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<DailyNoteDialog {...props} mode="quick-capture" onCapture={capture} />));
    const field = host.querySelector('textarea')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '网络中断时保留');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => submit.click());
    expect(capture).toHaveBeenNthCalledWith(1, { date: '2026-11-04', text: '网络中断时保留' }, null);
    expect(field.value).toBe('网络中断时保留');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('网络暂不可用');
    vi.setSystemTime(new Date('2026-11-04T16:00:01.000Z'));
    await act(async () => submit.click());
    expect(query).toHaveBeenLastCalledWith('workspace', '2026-11-04');
    expect(capture).toHaveBeenNthCalledWith(2, { date: '2026-11-04', text: '网络中断时保留', expectedRevision: '3' },
      { id: 'daily', revision: '3', deleted: false });
    expect(field.value).toBe('');
    expect(host.textContent).toContain('已记录到 2026-11-04');
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});

it('keeps a quick-capture heading marker when Lexical reopens and renames it', () => {
  const content = createContentFromMarkdown('## 随手记');
  const root = content.editorState.root as unknown as { children: { $?: Record<string, unknown> }[] };
  root.children[0]!.$ = { [quickCaptureMarker]: true };
  const editor = createEditor({ nodes: EDITOR_NODES, onError: error => { throw error; } });
  editor.setEditorState(editor.parseEditorState(content.editorState));
  editor.update(() => $getRoot().getAllTextNodes()[0]!.setTextContent('手记新名'), { discrete: true });
  const snapshot = editor.read('latest', $createSnapshot);
  expect(snapshot.content.editorState.root.children[0]).toMatchObject({ $: { [quickCaptureMarker]: true } });
  expect(snapshot.markdown).toContain('## 手记新名');
});
