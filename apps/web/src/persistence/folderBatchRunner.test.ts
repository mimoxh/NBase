import type { AttachmentMetadata, CreatePageRequest, PageDocument, UpdatePageRequest } from '@nbase/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContentFromMarkdown } from '../editor/markdown';
import { ApiError, pageClient } from './client';
import { processFolderBatch, runFolderBatch } from './folderBatchRunner';
import { folderBatchStore, newFolderBatch, type FolderImportBatch } from './folderBatchStore';
import { scanMarkdownFolder } from './folderPlan';
import { folderImportReport } from './folderReport';

const scope = { userId: 'account', workspaceId: 'workspace' };
const parseMarkdown = (source: string) => ({ content: createContentFromMarkdown(source), tagNames: [], warnings: [] });
const id = (n: number) => `${n.toString().padStart(8, '0')}-1111-4111-8111-111111111111`;
const clone = <T,>(value: T): T => structuredClone(value);
function file(path: string, body: string): File {
  const source = new File([body], path.slice(path.lastIndexOf('/') + 1));
  Object.defineProperty(source, 'webkitRelativePath', { value: 'root/' + path });
  return source;
}
function document(pageId: string, body: Partial<PageDocument> = {}): PageDocument {
  return { id: pageId, workspaceId: scope.workspaceId, parentId: null, title: '页', revision: '1', createdAt: '', updatedAt: '',
    icon: null, cover: null, content: createContentFromMarkdown(''), ...body };
}
async function setup(entries = [['a.md', '[B](b.md)\n\n![图](图.png)'], ['b.md', '[A](a.md)'], ['图.png', 'PNG']]) {
  const sources = new Map(entries.map(([path, text]) => [path!, file(path!, text!)]));
  const { plan } = await scanMarkdownFolder([...sources.values()], { pages: [], parentId: null, parseMarkdown });
  const batch = newFolderBatch(scope, plan);
  const remote = new Map<string, PageDocument>();
  const saved: FolderImportBatch[] = [];
  const io = {
    source: vi.fn(async (path: string) => sources.get(path)!),
    checkpoint: vi.fn(async (current: FolderImportBatch) => { saved.push(clone(current)); }),
    create: vi.fn(async (body: CreatePageRequest) => {
      const page = document(id(remote.size + 1), { parentId: body.parentId, title: body.title, content: body.content });
      remote.set(page.id, page); return clone(page);
    }),
    upload: vi.fn(async (attachmentId: string, source: File): Promise<AttachmentMetadata> => ({ id: attachmentId,
      workspaceId: scope.workspaceId, fileName: source.name, mediaType: 'image/png', byteSize: source.size, sha256: '', createdAt: '' })),
    update: vi.fn(async (pageId: string, body: UpdatePageRequest) => {
      expect(saved.at(-1)?.pages.find(item => item.skeleton?.id === pageId)?.pendingUpdate).toEqual(body);
      const page = remote.get(pageId)!;
      if (body.expectedRevision !== page.revision) throw new ApiError(409, 'REVISION_CONFLICT', page.revision);
      const updated = { ...page, ...(body.content ? { content: body.content } : {}), revision: String(Number(page.revision) + 1) };
      remote.set(pageId, updated); return clone(updated);
    }),
  };
  return { batch, io, sources, remote, saved };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('two-pass folder writes', () => {
  it('creates every stable skeleton before uploads or cyclic references, checkpointing each update first', async () => {
    const { batch, io } = await setup();
    await processFolderBatch(batch, io, { parseMarkdown });
    expect(batch.pages.map(item => item.status)).toEqual(['success', 'success']);
    expect(batch.attachments[0]?.status).toBe('success');
    expect(io.create.mock.invocationCallOrder.at(-1)).toBeLessThan(io.upload.mock.invocationCallOrder[0]!);
    expect(io.upload.mock.invocationCallOrder[0]).toBeLessThan(io.update.mock.invocationCallOrder[0]!);
    const bodies = io.update.mock.calls.map(call => call[1]);
    expect(JSON.stringify(bodies[0])).toContain('"targetPageId":"' + batch.pages[1]!.skeleton!.id + '"');
    expect(JSON.stringify(bodies[1])).toContain('"targetPageId":"' + batch.pages[0]!.skeleton!.id + '"');
    expect(bodies.map(body => body.expectedRevision)).toEqual(['1', '1']);
    expect(batch.pages.every(item => !item.pendingUpdate)).toBe(true);
  });

  it('pauses after the current request, then resumes cloned durable state without creating the first page twice', async () => {
    const { batch, io } = await setup();
    await processFolderBatch(batch, io, { parseMarkdown, shouldPause: () => io.create.mock.calls.length === 1 });
    expect(io.create).toHaveBeenCalledTimes(1);
    expect(io.update).not.toHaveBeenCalled();
    expect(batch.pages[0]?.skeleton).toBeDefined();
    expect(batch.pages[1]?.skeleton).toBeUndefined();
    const refreshed = clone(batch);
    await processFolderBatch(refreshed, io, { parseMarkdown });
    expect(io.create).toHaveBeenCalledTimes(2);
    expect(io.create.mock.calls.map(call => call[0].clientMutationId)).toEqual(batch.plan.pages.map(page => page.createId));
    expect(refreshed.pages.every(item => item.status === 'success')).toBe(true);
  });

  it('retains upload and update IDs/bodies across lost responses and reloads', async () => {
    const { batch, io } = await setup();
    io.upload.mockRejectedValueOnce(new ApiError(0, 'NETWORK_UNAVAILABLE'));
    await processFolderBatch(batch, io, { parseMarkdown });
    expect(batch.paused).toContain('尚未确认');
    expect(io.update).not.toHaveBeenCalled();
    const refreshed = clone(batch);
    io.update.mockRejectedValueOnce(new ApiError(0, 'TIMEOUT'));
    await processFolderBatch(refreshed, io, { parseMarkdown });
    expect(io.upload.mock.calls.map(call => call[0])).toEqual([batch.plan.attachments[0]!.id, batch.plan.attachments[0]!.id]);
    const pending = clone(refreshed.pages[0]!.pendingUpdate!);
    expect(pending.clientMutationId).toBe(batch.plan.pages[0]!.updateId);
    expect(refreshed.pages[0]!.status).toBe('failed');
    const anotherRefresh = clone(refreshed);
    await processFolderBatch(anotherRefresh, io, { parseMarkdown: () => { throw new Error('must reuse saved update body'); } });
    // The second page has not started its update and needs parsing; the ambiguous first write reuses its exact stored body.
    expect(io.update.mock.calls[1]?.[1]).toEqual(pending);
    expect(anotherRefresh.pages[0]?.status).toBe('success');
    expect(io.create).toHaveBeenCalledTimes(2);
    expect(io.upload).toHaveBeenCalledTimes(2);
  });

  it('keeps user edits, original revision and local content after a skeleton conflict; other pages finish', async () => {
    const { batch, io, remote, sources } = await setup();
    const create = io.create.getMockImplementation()!;
    io.create.mockImplementation(async body => {
      const page = await create(body);
      if (body.title === 'a') remote.set(page.id, { ...page, revision: '2', content: createContentFromMarkdown('用户编辑') });
      return page;
    });
    await processFolderBatch(batch, io, { parseMarkdown });
    expect(batch.pages[0]).toMatchObject({ status: 'failed', skeleton: { revision: '1' }, pendingUpdate: { expectedRevision: '1' } });
    expect(batch.pages[0]?.error).toContain('骨架已被修改');
    expect(JSON.stringify(remote.get(batch.pages[0]!.skeleton!.id)!.content)).toContain('用户编辑');
    expect(batch.pages[1]?.status).toBe('success');
    expect(await sources.get('a.md')!.text()).toContain('[B](b.md)');
    expect(folderImportReport(batch).pages[0]).toMatchObject({ status: 'failed', originalRevision: '1', pageId: batch.pages[0]!.skeleton!.id });
  });

  it('cancels remaining work durably after the current create and keeps that skeleton visible', async () => {
    const { batch, io } = await setup();
    await processFolderBatch(batch, io, { parseMarkdown, shouldCancel: () => io.create.mock.calls.length === 1 });
    expect(batch.pages.map(item => item.status)).toEqual(['cancelled', 'cancelled']);
    expect(batch.pages[0]?.skeleton).toBeDefined();
    expect(batch.attachments[0]?.status).toBe('cancelled');
    expect(io.create).toHaveBeenCalledTimes(1);
    expect(io.update).not.toHaveBeenCalled();
    const refreshed = clone(batch);
    await processFolderBatch(refreshed, io, { parseMarkdown });
    expect(io.create).toHaveBeenCalledTimes(1);
    expect(io.upload).not.toHaveBeenCalled();
    expect(folderImportReport(refreshed)).toMatchObject({ cancelled: 3, completed: 0 });
    expect(folderImportReport(refreshed).pages[0]?.pageId).toBe(batch.pages[0]!.skeleton!.id);
  });

  it('keeps uncertain creates for receipt reconciliation while cancelling their unstarted body updates', async () => {
    const { batch, io } = await setup();
    io.create.mockRejectedValueOnce(new ApiError(0, 'TIMEOUT'));
    await processFolderBatch(batch, io, { parseMarkdown, shouldCancel: () => io.create.mock.calls.length === 1 });
    expect(batch.pages[0]).toMatchObject({ status: 'failed', createStarted: true, cancelAfterCreate: true });
    expect(batch.pages[1]?.status).toBe('cancelled');
    const refreshed = clone(batch);
    await processFolderBatch(refreshed, io, { parseMarkdown });
    expect(io.create.mock.calls[1]?.[0].clientMutationId).toBe(io.create.mock.calls[0]?.[0].clientMutationId);
    expect(refreshed.pages[0]).toMatchObject({ status: 'cancelled', skeleton: { revision: '1' } });
    expect(io.update).not.toHaveBeenCalled();
    expect(io.upload).not.toHaveBeenCalled();
  });

  it('retains rejected attachment source references and lets independent documents complete', async () => {
    const { batch, io, remote } = await setup();
    io.upload.mockRejectedValueOnce(new ApiError(415, 'ATTACHMENT_CONTENT_MISMATCH'));
    await processFolderBatch(batch, io, { parseMarkdown });
    expect(batch.pages.every(item => item.status === 'success')).toBe(true);
    expect(batch.attachments[0]).toMatchObject({ status: 'failed', invalidFile: true });
    expect(JSON.stringify(remote.get(batch.pages[0]!.skeleton!.id)!.content)).toContain('![图](图.png)');
    expect(folderImportReport(batch).attachments[0]?.retainedAsSource).toBe(true);
    await processFolderBatch(batch, io, { parseMarkdown });
    expect(io.upload).toHaveBeenCalledTimes(1);
  });
});

describe('receipt-aware browser runner', () => {
  it('confirms lost create/update responses with the original receipts and releases its local lease', async () => {
    const { batch, sources } = await setup([['a.md', '保留正文']]);
    vi.stubGlobal('navigator', {});
    const start = vi.spyOn(folderBatchStore, 'start').mockImplementation(async (_scope, _id, token) => ({ ...batch, run: { token, expires: Date.now() + 60_000 } }));
    vi.spyOn(folderBatchStore, 'source').mockImplementation(async (_batch, path) => sources.get(path)!);
    const save = vi.spyOn(folderBatchStore, 'save').mockResolvedValue();
    const created = document(id(1));
    vi.spyOn(pageClient, 'create').mockRejectedValue(new ApiError(0, 'TIMEOUT'));
    vi.spyOn(pageClient, 'update').mockRejectedValue(new ApiError(0, 'NETWORK_UNAVAILABLE'));
    const receipt = vi.spyOn(pageClient, 'receipt').mockResolvedValueOnce({ statusCode: 201, response: created })
      .mockResolvedValueOnce({ statusCode: 200, response: { ...created, revision: '2' } });
    const result = await runFolderBatch(scope, batch.id, 'csrf', { parseMarkdown });
    expect(result.pages[0]?.status).toBe('success');
    expect(receipt.mock.calls).toEqual([[scope.workspaceId, batch.plan.pages[0]!.createId], [scope.workspaceId, batch.plan.pages[0]!.updateId]]);
    expect(start.mock.calls[0]?.[3]).toBe(false);
    expect(save.mock.calls.at(-1)?.slice(1)).toEqual([expect.any(String), true]);
  });

  it('rejects a receipt from another workspace and persists the unfinished operation', async () => {
    const { batch } = await setup([['a.md', '正文']]);
    vi.stubGlobal('navigator', {});
    vi.spyOn(folderBatchStore, 'start').mockResolvedValue(batch);
    vi.spyOn(folderBatchStore, 'save').mockResolvedValue();
    vi.spyOn(pageClient, 'create').mockRejectedValue(new ApiError(0, 'TIMEOUT'));
    vi.spyOn(pageClient, 'receipt').mockResolvedValue({ statusCode: 201, response: document(id(1), { workspaceId: 'other' }) });
    const result = await runFolderBatch(scope, batch.id, 'csrf', { parseMarkdown });
    expect(result.pages[0]).toMatchObject({ status: 'failed', createStarted: true });
    expect(result.pages[0]?.skeleton).toBeUndefined();
  });
});
