import { pageIdFromReferenceUrl, pageReferenceUrl, type PageDocument, type PageSummary } from '@nbase/contracts';
import { exportAttachments, zipEntries, type ZipEntry } from './attachmentExport';
import { attachmentPresentations, hasAttachmentPresentation, withCaptionParagraphs } from './attachmentPresentation';
import { folderMarkdownLink, mapFolderDocument } from './folderLinks';
import {
  folderAttachmentExtensions, folderBytesLimit, folderFileLimit, folderMarkdownLimit, subtreeManifestFormat, type SubtreeManifest,
} from './folderPlan';

interface FolderExportOptions {
  rootPageId: string;
  pages: readonly PageSummary[];
  fetchPage: (id: string) => Promise<PageDocument>;
  fetchAttachment: (id: string) => Promise<Blob>;
  formatMarkdown: (page: PageDocument) => string | Promise<string>;
}

function exportPagePath(id: string): string {
  const normalized = pageIdFromReferenceUrl(pageReferenceUrl(id));
  if (!normalized) throw new Error('页面 ID 无效，无法导出子树。');
  return 'pages/' + normalized + '.md';
}

function subtreeOf(rootId: string, pages: readonly PageSummary[]): PageSummary[] {
  const root = pages.find(page => page.id === rootId);
  if (!root) throw new Error('要导出的页面已不可用。');
  const children = new Map<string, PageSummary[]>();
  for (const page of pages) {
    if (page.workspaceId !== root.workspaceId || !page.parentId) continue;
    const siblings = children.get(page.parentId) ?? [];
    siblings.push(page);
    children.set(page.parentId, siblings);
  }
  const selected = [root];
  const seen = new Set([root.id]);
  for (let i = 0; i < selected.length; i++) {
    for (const page of children.get(selected[i]!.id) ?? []) {
      if (seen.has(page.id)) throw new Error('页面层级无效，无法导出子树。');
      seen.add(page.id);
      selected.push(page);
      if (selected.length > folderMarkdownLimit) throw new Error('子树 ZIP 最多包含 200 篇页面。');
    }
  }
  return selected;
}

/** Exports actual structured references as package-relative destinations. */
export async function packageFolderSubtree(options: FolderExportOptions): Promise<Blob> {
  const selected = subtreeOf(options.rootPageId, options.pages);
  const paths = new Map(selected.map(page => [page.id, exportPagePath(page.id)]));
  const entries: ZipEntry[] = [];
  const encoder = new TextEncoder();
  const manifest: SubtreeManifest = { format: subtreeManifestFormat, pages: [], attachments: [] };
  const attachmentPaths = new Map<string, string>();
  let bytes = 0;
  const add = (name: string, content: Uint8Array<ArrayBuffer>) => {
    bytes += content.byteLength;
    if (entries.length >= folderFileLimit || bytes > folderBytesLimit) throw new Error('子树 ZIP 超过 1,000 个文件或 190 MiB。');
    entries.push({ name, bytes: content });
  };
  for (const summary of selected) {
    const page = await options.fetchPage(summary.id);
    if (page.workspaceId !== summary.workspaceId || page.id !== summary.id || page.parentId !== summary.parentId) {
      throw new Error('导出期间页面目录发生变化，请刷新后重试。');
    }
    if (page.content.schemaVersion !== 1) throw new Error('页面正文版本无法导出：' + page.title);
    for (const attachment of exportAttachments(page.content)) {
      if (attachmentPaths.has(attachment.id)) continue;
      const suffix = folderAttachmentExtensions[attachment.mediaType];
      const id = pageIdFromReferenceUrl(pageReferenceUrl(attachment.id));
      if (!suffix || !id) throw new Error('附件格式无法导出：' + attachment.fileName);
      const path = 'attachments/' + id + suffix;
      const blob = await options.fetchAttachment(attachment.id);
      if (bytes + blob.size > folderBytesLimit) throw new Error('子树 ZIP 超过 190 MiB。');
      add(path, new Uint8Array(await blob.arrayBuffer()));
      attachmentPaths.set(attachment.id, path);
      manifest.attachments.push({ path, fileName: attachment.fileName });
    }
    const presentations = attachmentPresentations(page.content);
    const portable = mapFolderDocument(withCaptionParagraphs(page.content), node => {
      if (node.type === 'page-reference' && typeof node.targetPageId === 'string') {
        const destination = paths.get(node.targetPageId);
        if (destination) return folderMarkdownLink('./' + destination.slice('pages/'.length), String(node.label));
      }
      if (node.type === 'attachment' && typeof node.attachmentId === 'string') {
        const path = attachmentPaths.get(node.attachmentId);
        if (!path) throw new Error('页面中存在无法导出的附件：' + String(node.fileName));
        const image = String(node.mediaType).startsWith('image/');
        const label = image ? String(node.alt || node.fileName) : String(node.fileName);
        return folderMarkdownLink('../' + path, label, image);
      }
      return node;
    });
    const path = paths.get(page.id)!;
    add(path, encoder.encode(await options.formatMarkdown({ ...page, content: portable })));
    manifest.pages.push({ path, parentPath: page.id === options.rootPageId || !page.parentId ? null : paths.get(page.parentId) ?? null,
      title: page.title, ...(hasAttachmentPresentation(presentations) ? { presentations } : {}) });
  }
  add('manifest.json', encoder.encode(JSON.stringify(manifest, null, 2)));
  return zipEntries(entries);
}
