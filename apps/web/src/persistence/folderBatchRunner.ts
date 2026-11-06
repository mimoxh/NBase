import type { AttachmentMetadata, CreatePageRequest, PageDocument, StoredDocumentContent, UpdatePageRequest } from '@nbase/contracts';
import { ApiError, attachmentClient, pageClient } from './client';
import {
  folderBatchStore, folderLockName, type FolderBatchScope, type FolderImportBatch, type FolderItemStatus,
} from './folderBatchStore';
import { readFolderMarkdown, rebuildFolderContent, type FolderMarkdownParser } from './folderPlan';

const emptyFolderContent: StoredDocumentContent = {
  schemaVersion: 1,
  editorState: { root: { type: 'root', version: 1, direction: null, indent: 0, format: '',
    children: [{ type: 'paragraph', version: 1, direction: null, indent: 0, format: '', children: [] }] } },
};

interface FolderRunOptions {
  parseMarkdown: FolderMarkdownParser;
  resolveTagIds?: ((names: readonly string[]) => Promise<string[]>) | undefined;
  shouldPause?: () => boolean;
  shouldCancel?: () => boolean;
}

interface FolderRunIO {
  source(path: string): Promise<File>;
  create(body: CreatePageRequest): Promise<PageDocument>;
  upload(id: string, file: File): Promise<AttachmentMetadata>;
  update(pageId: string, body: UpdatePageRequest): Promise<PageDocument>;
  checkpoint(batch: FolderImportBatch): Promise<void>;
}

const ambiguous = (error: unknown) => error instanceof ApiError
  && (error.status === 0 || error.status >= 500 || error.code === 'INVALID_RESPONSE');

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'REVISION_CONFLICT') return '页面骨架已被修改。现有页面和本地原文件已保留。';
    if (error.status === 401) return '登录已失效，请重新登录后恢复此批次。';
    if (error.status === 403) return '当前账号没有写入权限，请确认权限后重试。';
    if (ambiguous(error)) return '服务端结果尚未确认，请恢复网络后重试同一批次。';
    return '服务端拒绝了该项（' + error.code + '）。';
  }
  return error instanceof Error ? error.message : '该项未完成。';
}

function mustPause(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403 || ambiguous(error));
}

/** Checkpoint each confirmed operation and the complete conditional update body before submitting it. */
export async function processFolderBatch(batch: FolderImportBatch, io: FolderRunIO, options: FolderRunOptions): Promise<void> {
  const plan = batch.plan;
  const items = new Map(batch.pages.map(item => [item.key, item]));
  const uploads = new Map(batch.attachments.map(item => [item.path, item]));
  delete batch.paused;
  const pauseRequested = async () => {
    if (options.shouldCancel?.()) {
      for (const item of batch.pages) {
        if (!item.skeleton && item.createStarted) item.cancelAfterCreate = true;
        if (item.status !== 'success' && !item.pendingUpdate && (item.skeleton || !item.createStarted)) {
          item.status = 'cancelled'; delete item.error;
        }
      }
      for (const item of batch.attachments) {
        if (item.status !== 'success' && !item.uploadStarted) { item.status = 'cancelled'; delete item.error; }
      }
      batch.paused = '已取消未开始项。已提交但未确认的项目保留原操作 ID，可继续核对。';
      await io.checkpoint(batch);
      return true;
    }
    if (!options.shouldPause?.()) return false;
    batch.paused = '已暂停未执行的项目，可恢复此批次。';
    await io.checkpoint(batch);
    return true;
  };
  const failure = async (item: { status: FolderItemStatus; error?: string }, error: unknown) => {
    item.status = 'failed';
    item.error = describe(error);
    const paused = mustPause(error);
    if (paused) batch.paused = item.error;
    await io.checkpoint(batch);
    if (options.shouldCancel?.()) return pauseRequested();
    return paused;
  };

  // Allocate all page IDs first so links can target later files and form cycles.
  for (const page of plan.pages) {
    if (await pauseRequested()) return;
    const item = items.get(page.key)!;
    if (item.skeleton || item.status === 'cancelled') continue;
    const parent = page.parentKey ? items.get(page.parentKey)?.skeleton : null;
    if (page.parentKey && !parent) {
      await failure(item, new Error('父页尚未创建，重试父页后再执行。')); continue;
    }
    let created: PageDocument;
    try {
      item.createStarted = true;
      await io.checkpoint(batch);
      created = await io.create({ clientMutationId: page.createId, parentId: parent?.id ?? plan.parentId,
        title: page.title, content: emptyFolderContent });
    } catch (error) {
      if (await failure(item, error)) return;
      continue;
    }
    item.skeleton = { id: created.id, revision: created.revision };
    delete item.createStarted;
    item.status = item.cancelAfterCreate ? 'cancelled' : page.sourcePath ? 'pending' : 'success';
    delete item.cancelAfterCreate;
    delete item.error;
    await io.checkpoint(batch);
  }

  const neededUploads = new Set(plan.pages.filter(page => items.get(page.key)?.skeleton
    && !['success', 'cancelled'].includes(items.get(page.key)!.status))
    .flatMap(page => page.attachmentPaths));
  for (const attachment of plan.attachments) {
    if (await pauseRequested()) return;
    const item = uploads.get(attachment.path)!;
    if ((!neededUploads.has(attachment.path) && !item.uploadStarted)
      || item.status === 'success' || item.status === 'cancelled' || item.invalidFile) continue;
    try {
      const file = await io.source(attachment.path);
      const named = file.name === attachment.fileName ? file
        : new File([file], attachment.fileName, { type: file.type, lastModified: file.lastModified });
      item.uploadStarted = true;
      await io.checkpoint(batch);
      item.metadata = await io.upload(attachment.id, named);
    } catch (error) {
      if (error instanceof ApiError && [400, 413, 415].includes(error.status) && error.code.startsWith('ATTACHMENT_')) {
        item.invalidFile = true;
      }
      if (await failure(item, error)) return;
      continue;
    }
    item.status = 'success';
    delete item.uploadStarted;
    delete item.error;
    await io.checkpoint(batch);
  }

  const pageIds = new Map(batch.pages.flatMap(item => item.skeleton ? [[item.key, item.skeleton.id] as const] : []));
  const uploaded = new Map(batch.attachments.flatMap(item => item.metadata ? [[item.path, item.metadata] as const] : []));
  for (const page of plan.pages) {
    if (await pauseRequested()) return;
    const item = items.get(page.key)!;
    if (!item.skeleton || !page.sourcePath || item.status === 'success' || item.status === 'cancelled') continue;
    if (page.pageDependencies.some(key => !pageIds.has(key))) {
      await failure(item, new Error('引用目标页尚未创建，等待重试。')); continue;
    }
    if (page.attachmentPaths.some(path => !uploaded.has(path) && !uploads.get(path)?.invalidFile)) {
      await failure(item, new Error('引用的附件尚未上传，等待重试。')); continue;
    }
    try {
      if (!item.pendingUpdate) {
        const parsed = options.parseMarkdown(await readFolderMarkdown(await io.source(page.sourcePath)));
        if (page.tagNames.length && !options.resolveTagIds) throw new Error('需要先连接工作区标签服务。');
        const tagIds = page.tagNames.length ? await options.resolveTagIds!(page.tagNames) : undefined;
        item.pendingUpdate = { clientMutationId: page.updateId, expectedRevision: item.skeleton.revision,
          content: rebuildFolderContent(plan, page, parsed.content, pageIds, uploaded), ...(tagIds ? { tagIds } : {}) };
      }
      await io.checkpoint(batch);
      await io.update(item.skeleton.id, item.pendingUpdate);
    } catch (error) {
      if (await failure(item, error)) return;
      continue;
    }
    item.status = 'success';
    delete item.error;
    delete item.pendingUpdate;
    await io.checkpoint(batch);
  }
  if (!await pauseRequested()) await io.checkpoint(batch);
}

async function confirmPage(workspaceId: string, id: string, action: () => Promise<PageDocument>, expectedPageId?: string) {
  const verified = (page: PageDocument) => {
    if (!page || page.workspaceId !== workspaceId || typeof page.id !== 'string' || typeof page.revision !== 'string'
      || (expectedPageId && page.id !== expectedPageId)) throw new ApiError(0, 'INVALID_RESPONSE');
    return page;
  };
  try { return verified(await action()); }
  catch (error) {
    if (!ambiguous(error)) throw error;
    const receipt = await pageClient.receipt(workspaceId, id).catch(() => null);
    if (!receipt) throw error;
    return verified(receipt.response);
  }
}

export async function runFolderBatch(scope: FolderBatchScope, id: string, csrfToken: string,
  options: FolderRunOptions & { onProgress?: (batch: FolderImportBatch) => void }): Promise<FolderImportBatch> {
  const run = async (ownsBrowserLock: boolean) => {
    const token = crypto.randomUUID();
    const batch = await folderBatchStore.start(scope, id, token, ownsBrowserLock);
    const { workspaceId } = scope;
    try {
      await processFolderBatch(batch, {
        source: path => folderBatchStore.source(batch, path),
        create: body => confirmPage(workspaceId, body.clientMutationId, () => pageClient.create(workspaceId, body, csrfToken)),
        upload: (uploadId, file) => attachmentClient.upload(workspaceId, uploadId, file, csrfToken),
        update: (pageId, body) => confirmPage(workspaceId, body.clientMutationId,
          () => pageClient.update(workspaceId, pageId, body, csrfToken), pageId),
        checkpoint: async current => {
          await folderBatchStore.save(current, token);
          options.onProgress?.({ ...current, pages: current.pages.map(item => ({ ...item })),
            attachments: current.attachments.map(item => ({ ...item })) });
        },
      }, options);
      return batch;
    } finally {
      await folderBatchStore.save(batch, token, true);
    }
  };
  if (navigator.locks) {
    return navigator.locks.request(folderLockName(scope, id), { ifAvailable: true }, lock => {
      if (!lock) throw new Error('批次仍由另一个标签页处理，请稍后重试。');
      return run(true);
    });
  }
  return run(false);
}
