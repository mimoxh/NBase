// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContentFromMarkdown } from './markdown';
import {
  SourceDraftConflict, SourceDraftQueue, sameSourceDraftVersion, sourceDraftKey, sourceDraftVersion,
  type SourceDraft, type SourceDraftInput, type SourceDraftPage, type SourceDraftScope, type SourceDraftVersion,
} from './sourceDrafts';

const scope = { userId: '用户', workspaceId: '工作区', pageId: '页', instanceId: '编辑实例' };
const input = (source = '正文'): SourceDraftInput => ({ source, baseContent: createContentFromMarkdown('原正文'), baseRevision: '7' });
const copy = <T,>(value: T): T => structuredClone(value);
function storage() {
  const drafts = new Map<string, SourceDraft>();
  return {
    drafts,
    list: vi.fn(async (page: SourceDraftPage) => [...drafts.values()].filter(draft => draft.userId === page.userId
      && draft.workspaceId === page.workspaceId && draft.pageId === page.pageId).map(copy)),
    put: vi.fn(async (draft: SourceDraft, expected: SourceDraftVersion | null) => {
      const previous = drafts.get(draft.key);
      if (expected ? !sameSourceDraftVersion(previous, expected) : previous !== undefined) throw new SourceDraftConflict();
      drafts.set(draft.key, copy(draft));
    }),
    removeIfVersion: vi.fn(async (version: SourceDraftVersion) => {
      if (!sameSourceDraftVersion(drafts.get(version.key), version)) return false;
      return drafts.delete(version.key);
    }),
  };
}
const queues: SourceDraftQueue[] = [];
function queue(scopeInput: SourceDraftScope, initial: SourceDraft | null, io: ReturnType<typeof storage>) {
  const result = new SourceDraftQueue(scopeInput, initial, io); queues.push(result); return result;
}
afterEach(async () => {
  for (const item of queues.splice(0)) { await item.flush().catch(() => {}); item.abandonUnsavedInput(); }
  vi.restoreAllMocks();
});

describe('isolated source drafts', () => {
  it('does not write during an unchanged session and keeps four dimensions collision-free', async () => {
    const io = storage();
    expect(await queue(scope, null, io).flush()).toBeNull();
    expect(io.put).not.toHaveBeenCalled();
    const original = sourceDraftKey(scope);
    for (const key of ['userId', 'workspaceId', 'pageId', 'instanceId'] as const) {
      expect(sourceDraftKey({ ...scope, [key]: '其他' })).not.toBe(original);
    }
    expect(sourceDraftKey({ ...scope, userId: 'a:b', workspaceId: 'c' })).not.toBe(sourceDraftKey({ ...scope, userId: 'a', workspaceId: 'b:c' }));
  });

  it('serializes rapid edits and flush waits for the final queued input', async () => {
    const io = storage();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const put = io.put.getMockImplementation()!;
    io.put.mockImplementationOnce(async (draft, expected) => { await held; await put(draft, expected); });
    const current = queue(scope, null, io);
    const first = current.enqueue(input('中'));
    const second = current.enqueue(input('中文'));
    let flushed = false;
    const done = current.flush().then(value => { flushed = true; return value; });
    await Promise.resolve();
    expect(io.put).toHaveBeenCalledTimes(1);
    expect(flushed).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(await done).toMatchObject({ source: '中文', sequence: 2 });
    expect(io.put.mock.calls[1]?.[1]).toMatchObject({ source: '中', sequence: 1 });
    expect(io.drafts.get(sourceDraftKey(scope))?.source).toBe('中文');
  });

  it('protects immediate refresh while a write is queued and releases protection after commit', async () => {
    const io = storage();
    let release!: () => void;
    io.put.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const current = queue(scope, null, io);
    const write = current.enqueue(input());
    const before = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    await Promise.resolve(); release(); await write; await current.flush();
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('retains failed input protection, blocks flush and retries the latest input from the last confirmed version', async () => {
    const io = storage();
    const current = queue(scope, null, io);
    await current.enqueue(input('已保存'));
    io.put.mockRejectedValueOnce(new Error('QuotaExceededError'));
    await expect(current.enqueue(input('未保存'))).rejects.toThrow('QuotaExceededError');
    await expect(current.flush()).rejects.toThrow('QuotaExceededError');
    const refresh = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(refresh);
    expect(refresh.defaultPrevented).toBe(true);
    await current.enqueue(input('继续输入并重试'));
    expect(await current.flush()).toMatchObject({ source: '继续输入并重试', sequence: 2 });
    expect(io.put.mock.calls.at(-1)?.[1]).toMatchObject({ source: '已保存', sequence: 1 });
  });

  it('rejects stale concurrent writes and never replaces another instance or account', async () => {
    const io = storage();
    const first = queue(scope, null, io);
    const stale = queue(scope, null, io);
    await first.enqueue(input('第一个实例版本'));
    await expect(stale.enqueue(input('不应覆盖'))).rejects.toThrow(SourceDraftConflict);
    const secondScope = { ...scope, instanceId: '另一个实例' };
    await queue(secondScope, null, io).enqueue(input('另一个实例独立版本'));
    await queue({ ...scope, userId: '另一个账号' }, null, io).enqueue(input('账号隔离'));
    expect((await io.list(scope)).map(draft => draft.source)).toEqual(['第一个实例版本', '另一个实例独立版本']);
    expect(io.drafts).toHaveLength(3);
  });

  it('retains a recovered baseline and exact adopted version while writing to the current instance', async () => {
    const io = storage();
    const oldScope = { ...scope, instanceId: '旧标签页' };
    const original = await queue(oldScope, null, io).enqueue({ ...input('旧草稿输入'), baseRevision: '2' });
    const current = queue(scope, null, io);
    const adopted = sourceDraftVersion(original);
    const recovered = await current.enqueue({ source: original.source, baseContent: original.baseContent, baseRevision: original.baseRevision,
      recoveredFrom: [adopted] });
    expect(recovered).toMatchObject({ instanceId: scope.instanceId, baseRevision: '2', recoveredFrom: [adopted] });
    expect(io.drafts.get(original.key)).toEqual(original);
    await current.clear(sourceDraftVersion(recovered));
    await io.removeIfVersion(adopted);
    expect(io.drafts.size).toBe(0);
  });

  it('clears only a captured version after apply and preserves a newer same-key draft', async () => {
    const io = storage();
    const current = queue(scope, null, io);
    const applied = await current.enqueue(input('准备应用'));
    await current.enqueue(input('应用期间的新输入'));
    expect(await current.clear(sourceDraftVersion(applied))).toBe(false);
    expect(io.drafts.get(applied.key)?.source).toBe('应用期间的新输入');
    const version = sourceDraftVersion(current.latest!);
    expect(await current.clear(version)).toBe(true);
    expect(current.latest).toBeNull();
  });

  it('compares source, baseline, revision, sequence and timestamp before deletion', async () => {
    const io = storage();
    const saved = await queue(scope, null, io).enqueue(input());
    const version = sourceDraftVersion(saved);
    expect(sameSourceDraftVersion(saved, version)).toBe(true);
    expect(sameSourceDraftVersion({ ...saved, source: '新输入' }, version)).toBe(false);
    expect(sameSourceDraftVersion({ ...saved, baseRevision: '8' }, version)).toBe(false);
    expect(sameSourceDraftVersion({ ...saved, baseContent: createContentFromMarkdown('不同正文') }, version)).toBe(false);
    expect(sameSourceDraftVersion({ ...saved, sequence: 2 }, version)).toBe(false);
    expect(sameSourceDraftVersion({ ...saved, updatedAt: '新时间' }, version)).toBe(false);
    expect(sameSourceDraftVersion({ ...saved, instanceId: '别处' }, version)).toBe(false);
  });

  it('rejects a poisoned recovered pointer whose embedded scope disagrees with its foreign key', async () => {
    const io = storage();
    const foreignScope = { ...scope, userId: '其他账号', instanceId: '其他实例' };
    const saved = await queue(foreignScope, null, io).enqueue(input('相同内容'));
    const poisoned = { ...sourceDraftVersion(saved), userId: scope.userId };
    expect(sameSourceDraftVersion(saved, poisoned)).toBe(false);
    expect(await io.removeIfVersion(poisoned)).toBe(false);
    expect(io.drafts.get(saved.key)).toEqual(saved);
  });

  it('captures the original baseline and preserves oversized source without truncation', async () => {
    const io = storage();
    const current = queue(scope, null, io);
    const oversized = '字'.repeat(1024 * 1024);
    const value = input(oversized);
    const expected = copy(value.baseContent);
    const write = current.enqueue(value);
    value.baseContent.editorState.root.children = [];
    expect((await write).source).toBe(oversized);
    expect(current.latest?.baseContent).toEqual(expected);
  });

  it('restores the same instance without silently replacing an unrelated key', async () => {
    const io = storage();
    const saved = await queue(scope, null, io).enqueue(input('刷新前'));
    const resumed = queue(scope, copy(saved), io);
    expect(await resumed.flush()).toEqual(saved);
    await resumed.enqueue(input('刷新后'));
    expect(resumed.latest?.sequence).toBe(2);
    expect(() => new SourceDraftQueue({ ...scope, instanceId: '其他' }, saved, io)).toThrow(SourceDraftConflict);
  });
});
