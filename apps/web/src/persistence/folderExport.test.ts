import type { PageDocument, StoredDocumentContent } from '@nbase/contracts';
import { createEditor } from 'lexical';
import { describe, expect, it, vi } from 'vitest';
import { $createSnapshot, createContentFromMarkdown } from '../editor/markdown';
import { EDITOR_NODES } from '../editor/nodes';
import { packagePage } from './attachmentExport';
import { packageFolderSubtree } from './folderExport';
import { mapFolderDocument } from './folderLinks';
import { rebuildFolderContent, scanMarkdownFolder, type SubtreeManifest } from './folderPlan';

const rootId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const externalId = '33333333-3333-4333-8333-333333333333';
const attachmentId = '44444444-4444-4444-8444-444444444444';
const parseMarkdown = (source: string) => ({ content: createContentFromMarkdown(source), tagNames: [], warnings: [] });

function page(id: string, parentId: string | null, markdown: string): PageDocument {
  const content = mapFolderDocument(createContentFromMarkdown(markdown), node => node.type === 'image-reference'
    && typeof node.markdown === 'string' && node.markdown.includes('nbase-attachment:' + attachmentId)
    ? { type: 'attachment', version: 1, attachmentId, mediaType: 'image/png', fileName: '图片.png', alt: node.alt } : node);
  return { id, parentId, workspaceId: 'workspace', title: '同名 / 页', revision: '1', icon: null, cover: null,
    createdAt: '', updatedAt: '', content };
}

function formatMarkdown(page: PageDocument) {
  const editor = createEditor({ nodes: EDITOR_NODES, onError: error => { throw error; } });
  editor.setEditorState(editor.parseEditorState(page.content.editorState as ReturnType<typeof createContentFromMarkdown>['editorState']));
  return editor.getEditorState().read($createSnapshot).markdown;
}

async function unzip(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const entries = new Map<string, Uint8Array<ArrayBuffer>>();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    expect(view.getUint16(offset + 8, true)).toBe(0);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    entries.set(name, bytes.slice(start, start + size));
    offset = start + size;
  }
  expect(view.getUint32(offset, true)).toBe(0x02014b50);
  return entries;
}

const decoded = (entries: Map<string, Uint8Array>, path: string) => new TextDecoder().decode(entries.get(path));
function folderFiles(entries: Map<string, Uint8Array<ArrayBuffer>>) {
  return [...entries].map(([path, bytes]) => {
    const source = new File([bytes], path.slice(path.lastIndexOf('/') + 1));
    Object.defineProperty(source, 'webkitRelativePath', { value: '解压目录/' + path });
    return source;
  });
}
function findNodes(content: StoredDocumentContent, type: string) {
  const result: Record<string, unknown>[] = [];
  mapFolderDocument(content, node => { if (node.type === type) result.push(node); return node; });
  return result;
}

describe('re-importable directory ZIP', () => {
  it('rebuilds hierarchy and actual references in another workspace, preserving code and original attachment names', async () => {
    const root = page(rootId, null, `[子页](/?page=${childId})\n\n[其他](/?page=${externalId})\n\n![图](nbase-attachment:${attachmentId})\n\n\`\`\`md\n[代码](/?page=${childId})\n![源码](nbase-attachment:${attachmentId})\n\`\`\``);
    // Attachment names in structured content are authoritative, independently of ZIP paths.
    root.content = mapFolderDocument(root.content, node => node.type === 'attachment' ? { ...node, fileName: '原始 图片.png' } : node);
    const child = page(childId, rootId, `[父页](/?page=${rootId})\n\n![同图](nbase-attachment:${attachmentId})`);
    child.content = mapFolderDocument(child.content, node => node.type === 'attachment' ? { ...node, fileName: '原始 图片.png' } : node);
    const unrelated = page(externalId, null, '不能进入子树');
    const pages = [root, child, unrelated];
    const fetchAttachment = vi.fn(async () => new Blob(['PNG']));
    const zip = await packageFolderSubtree({ rootPageId: rootId, pages,
      fetchPage: async requested => pages.find(item => item.id === requested)!, fetchAttachment, formatMarkdown });
    const entries = await unzip(zip);
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    expect(entries.has(`pages/${externalId}.md`)).toBe(false);
    const markdown = decoded(entries, `pages/${rootId}.md`);
    expect(markdown).toContain(`[子页](./${childId}.md)`);
    expect(markdown).toContain(`![图](../attachments/${attachmentId}.png)`);
    expect(markdown).toContain(`[其他](/?page=${externalId})`);
    expect(markdown).toContain(`[代码](/?page=${childId})`);
    expect(markdown).toContain(`![源码](nbase-attachment:${attachmentId})`);
    const manifest = JSON.parse(decoded(entries, 'manifest.json')) as SubtreeManifest;
    expect(manifest.pages).toEqual([
      { path: `pages/${rootId}.md`, parentPath: null, title: root.title },
      { path: `pages/${childId}.md`, parentPath: `pages/${rootId}.md`, title: child.title },
    ]);
    expect(manifest.attachments).toEqual([{ path: `attachments/${attachmentId}.png`, fileName: '原始 图片.png' }]);

    const { plan } = await scanMarkdownFolder(folderFiles(entries), { pages: [], parentId: null, parseMarkdown });
    expect(plan.pages).toHaveLength(2);
    expect(plan.pages[1]?.parentKey).toBe(plan.pages[0]?.key);
    expect(plan.pages.map(item => item.title)).toEqual([root.title, child.title]);
    expect(plan.attachments[0]?.fileName).toBe('原始 图片.png');
    const newRoot = crypto.randomUUID(), newChild = crypto.randomUUID(), newAttachment = crypto.randomUUID();
    const content = rebuildFolderContent(plan, plan.pages[0]!, createContentFromMarkdown(markdown),
      new Map([[plan.pages[0]!.key, newRoot], [plan.pages[1]!.key, newChild]]),
      new Map([[plan.attachments[0]!.path, { id: newAttachment, workspaceId: 'another', fileName: '原始 图片.png',
        mediaType: 'image/png', byteSize: 3, sha256: '', createdAt: '' }]]));
    expect(findNodes(content, 'page-reference')).toEqual([{ type: 'page-reference', version: 1, targetPageId: newChild, label: '子页' }]);
    expect(findNodes(content, 'attachment')[0]).toMatchObject({ attachmentId: newAttachment, fileName: '原始 图片.png' });
    expect(findNodes(content, 'code')[0]).toEqual(findNodes(root.content, 'code')[0]);
  });

  it('recognizes the previous single-page ZIP after extraction and retains attachment names', async () => {
    const original = page(rootId, null, `![图片](nbase-attachment:${attachmentId})`);
    original.content = mapFolderDocument(original.content, node => node.type === 'attachment' ? { ...node, fileName: '老图片.png' } : node);
    const entries = await unzip(await packagePage(formatMarkdown(original), original.content, async () => new Blob(['PNG'])));
    const { plan } = await scanMarkdownFolder(folderFiles(entries), { pages: [], parentId: null, parseMarkdown });
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]).toMatchObject({ title: '解压目录', parentKey: null, sourcePath: 'document.md' });
    expect(plan.attachments[0]).toMatchObject({ path: `attachments/${attachmentId}.png`, fileName: '老图片.png' });
  });

  it('aborts the whole export when an attachment disappears or page hierarchy changes', async () => {
    const root = page(rootId, null, `![图片](nbase-attachment:${attachmentId})`);
    await expect(packageFolderSubtree({ rootPageId: rootId, pages: [root], fetchPage: async () => root,
      fetchAttachment: async () => { throw new Error('MISSING_ATTACHMENT'); }, formatMarkdown })).rejects.toThrow('MISSING_ATTACHMENT');
    await expect(packageFolderSubtree({ rootPageId: rootId, pages: [root], fetchPage: async () => ({ ...root, parentId: childId }),
      fetchAttachment: async () => new Blob(), formatMarkdown })).rejects.toThrow('目录发生变化');
  });
});
