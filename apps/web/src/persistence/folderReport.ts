import type { FolderImportBatch } from './folderBatchStore';

export function folderBatchCounts(batch: FolderImportBatch) {
  const items = [...batch.pages, ...batch.attachments];
  return { completed: items.filter(item => item.status === 'success').length,
    failed: items.filter(item => item.status === 'failed').length,
    cancelled: items.filter(item => item.status === 'cancelled').length,
    pending: items.filter(item => item.status === 'pending').length, total: items.length };
}

/** The report contains operation IDs and created pages, never the original file contents. */
export function folderImportReport(batch: FolderImportBatch) {
  return {
    format: 'nbase-folder-import-report-v1', batchId: batch.id, userId: batch.userId,
    workspaceId: batch.workspaceId, createdAt: batch.createdAt, rootName: batch.plan.rootName,
    parentId: batch.plan.parentId, inputFileCount: batch.plan.inputFileCount, inputBytes: batch.plan.inputBytes,
    ...folderBatchCounts(batch), paused: batch.paused ?? null, issues: batch.plan.issues,
    pages: batch.plan.pages.map(page => {
      const item = batch.pages.find(record => record.key === page.key);
      return { path: page.path, title: page.title, kind: page.sourcePath ? 'document' : 'folder',
        createOperationId: page.createId, updateOperationId: page.updateId,
        status: item?.status ?? 'pending', pageId: item?.skeleton?.id ?? null,
        originalRevision: item?.skeleton?.revision ?? null, error: item?.error ?? null };
    }),
    attachments: batch.plan.attachments.map(file => {
      const item = batch.attachments.find(record => record.path === file.path);
      return { path: file.path, fileName: file.fileName, operationId: file.id,
        status: item?.status ?? 'pending', attachmentId: item?.metadata?.id ?? null,
        retainedAsSource: Boolean(item?.invalidFile), error: item?.error ?? null };
    }),
  };
}
