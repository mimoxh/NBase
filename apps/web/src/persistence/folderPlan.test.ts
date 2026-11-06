import type { AttachmentMetadata, PageSummary, StoredDocumentContent } from '@nbase/contracts';
import { describe, expect, it } from 'vitest';
import { createContentFromMarkdown } from '../editor/markdown';
import { folderDestination, folderMarkdownLink, folderNodeLink, mapFolderDocument, normalizeFolderPath } from './folderLinks';
import { folderBytesLimit, rebuildFolderContent, scanMarkdownFolder } from './folderPlan';

const parseMarkdown = (source: string) => ({ content: createContentFromMarkdown(source), tagNames: [], warnings: [] });
const options = { pages: [], parentId: null, parseMarkdown };
const workspaceId = 'workspace';
const targetId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';

function file(path: string, body = '正文', type = ''): File {
  const value = new File([body], path.slice(path.lastIndexOf('/') + 1), { type });
  Object.defineProperty(value, 'webkitRelativePath', { value: path });
  return value;
}

function nodes(content: StoredDocumentContent) {
  const found: Record<string, unknown>[] = [];
  mapFolderDocument(content, node => { found.push(node); return node; });
  return found;
}

describe('folder paths', () => {
  it('normalizes Unicode and resolves encoded spaces and in-root parents exactly once', () => {
    expect(normalizeFolderPath('资料/e\u0301.md')).toBe('资料/é.md');
    expect(folderDestination('../笔记%20一.md#节', '目录/记录.md')).toEqual({ kind: 'local', path: '笔记 一.md', hasSuffix: true });
    expect(folderDestination('./资料/%252e%252e.png', '记录.md')).toEqual({ kind: 'local', path: '资料/%2e%2e.png', hasSuffix: false });
    expect(folderDestination('#节', '记录.md')).toEqual({ kind: 'anchor' });
    expect(folderDestination('https://example.org/a.md', '记录.md')).toEqual({ kind: 'external' });
  });

  it.each(['../越界.md', '%2e%2e/越界.md', '/绝对.md', 'a%2Fb.md', 'a%5Cb.md', 'a\\b.md', 'a%00.md', '%ED%A0%80.md'])('rejects unsafe destination %s', url => {
    expect(folderDestination(url, '记录.md')).toEqual({ kind: 'outside' });
  });

  it.each(['a/../b', './a.md', 'a//b', 'a\\b', 'D:/a', '\ud800.md'])('rejects unsafe selected path %s', path => {
    expect(normalizeFolderPath(path)).toBeNull();
  });

  it('reads generated serialized link and image destinations without inspecting code text', () => {
    expect(folderNodeLink(folderMarkdownLink('../图.png', '图 [一]', true))).toEqual({ url: '../图.png', label: '图 [一]', image: true });
    expect(folderNodeLink(folderMarkdownLink('./a.md', '页'))).toEqual({ url: './a.md', label: '页', image: false });
  });
});

describe('folder preview and reference rebuild', () => {
  it('distinguishes same-name files and directories, numbers collisions, and preserves code', async () => {
    const existing: PageSummary = { id: targetId, workspaceId, parentId: null, title: '目录', icon: null, cover: null,
      revision: '1', createdAt: '', updatedAt: '' };
    const source = '[下一页](目录/笔记%20一.md)\n\n![截图](图.png)\n\n```md\n[下一页](目录/笔记%20一.md)\n![截图](图.png)\n```';
    const { plan } = await scanMarkdownFolder([file('根/目录.md', source), file('根/目录/笔记 一.md'), file('根/图.png', 'PNG', 'image/png')],
      { ...options, pages: [existing] });
    expect(plan.pages.map(page => [page.path, page.title, page.sourcePath === null])).toEqual([
      ['目录', '目录（2）', true], ['目录.md', '目录（3）', false], ['目录/笔记 一.md', '笔记 一', false],
    ]);
    const page = plan.pages.find(item => item.sourcePath === '目录.md')!;
    const target = plan.pages.find(item => item.sourcePath === '目录/笔记 一.md')!;
    expect(page.pageDependencies).toEqual([target.key]);
    expect(page.attachmentPaths).toEqual(['图.png']);
    const original = createContentFromMarkdown(source);
    const metadata: AttachmentMetadata = { id: otherId, workspaceId, fileName: '图.png', mediaType: 'image/png', byteSize: 3, sha256: '', createdAt: '' };
    const rebuilt = rebuildFolderContent(plan, page, original, new Map([[target.key, targetId]]), new Map([['图.png', metadata]]));
    expect(nodes(rebuilt)).toContainEqual({ type: 'page-reference', version: 1, targetPageId: targetId, label: '下一页' });
    expect(nodes(rebuilt)).toContainEqual({ type: 'attachment', version: 1, attachmentId: otherId, fileName: '图.png', mediaType: 'image/png', alt: '截图' });
    expect(nodes(rebuilt).find(node => node.type === 'code')).toEqual(nodes(original).find(node => node.type === 'code'));
    expect(JSON.stringify(original)).not.toContain('"type":"attachment"');
  });

  it('reports traversal, missing images, unsupported files and ambiguous extensionless references', async () => {
    const source = '[外部](../秘密.md) [丢失](missing.pdf) [脚本](run.exe) [歧义](same)\n\n![丢失](lost.png)';
    const { plan } = await scanMarkdownFolder([file('根/a.md', source), file('根/same.md'), file('根/same.markdown'), file('根/run.exe')], options);
    const page = plan.pages.find(item => item.sourcePath === 'a.md')!;
    expect(plan.issues.map(issue => issue.message).join('\n')).toMatch(/越界/);
    expect(plan.issues.map(issue => issue.message).join('\n')).toMatch(/missing.pdf/);
    expect(plan.issues.map(issue => issue.message).join('\n')).toMatch(/不支持/);
    expect(plan.issues.map(issue => issue.message).join('\n')).toMatch(/歧义/);
    expect(page.pageDependencies).toEqual([]);
    expect(plan.attachments).toEqual([]);
    const rebuilt = rebuildFolderContent(plan, page, createContentFromMarkdown(source), new Map(), new Map());
    expect(nodes(rebuilt).filter(node => node.type === 'link')).toEqual([]);
    expect(nodes(rebuilt).find(node => node.type === 'image-reference')).toMatchObject({ markdown: '![丢失](lost.png)' });
    expect(JSON.stringify(rebuilt)).toContain('[歧义](same)');
  });

  it('skips all normalized duplicate paths and unsafe entries while keeping valid files', async () => {
    const { plan, sources } = await scanMarkdownFolder([file('根/é.md'), file('根/e\u0301.md'), file('根/../逃逸.md'), file('根/保留.md')], options);
    expect(plan.pages.map(page => page.path)).toEqual(['保留.md']);
    expect(sources.map(source => source.path)).toEqual(['保留.md']);
    expect(plan.issues).toHaveLength(2);
  });

  it('honors injected front matter title, tags, warnings, and source preservation', async () => {
    const { plan } = await scanMarkdownFolder([file('根/name.md')], { ...options,
      parseMarkdown: source => ({ ...parseMarkdown(source), title: ' 元数据标题 ', tagNames: ['书', '书'], warnings: ['保留原文'], preservedAsSource: true }) });
    expect(plan.pages[0]).toMatchObject({ title: '元数据标题', tagNames: ['书'] });
    expect(plan.issues).toEqual([{ path: 'name.md', message: '保留原文' }]);
  });

  it('reports and downgrades stable page references absent from the selected workspace', async () => {
    const source = `[外页](/?page=${otherId})`;
    const { plan } = await scanMarkdownFolder([file('根/a.md', source)], options);
    expect(plan.issues[0]?.message).toContain('普通链接');
    const content = rebuildFolderContent(plan, plan.pages[0]!, createContentFromMarkdown(source), new Map(), new Map());
    expect(nodes(content).find(node => node.type === 'link')).toMatchObject({ url: '/?page=' + otherId });
    expect(nodes(content).some(node => node.type === 'page-reference')).toBe(false);
  });

  it('rejects excessive files, Markdown pages and total bytes before parsing', async () => {
    await expect(scanMarkdownFolder(Array.from({ length: 1001 }, (_, i) => file(`根/${i}.txt`)), options)).rejects.toThrow('1,000');
    await expect(scanMarkdownFolder(Array.from({ length: 201 }, (_, i) => file(`根/${i}.md`)), options)).rejects.toThrow('200');
    const large = file('根/large.md');
    Object.defineProperty(large, 'size', { value: folderBytesLimit + 1 });
    await expect(scanMarkdownFolder([large], options)).rejects.toThrow('190 MiB');
  });

  it('rejects invalid target parents and malformed/cyclic subtree manifests', async () => {
    await expect(scanMarkdownFolder([file('根/a.md')], { ...options, parentId: targetId })).rejects.toThrow('目标父页');
    const manifest = { format: 'nbase-subtree-export-v1', pages: [
      { path: 'a.md', title: 'A', parentPath: 'b.md' }, { path: 'b.md', title: 'B', parentPath: 'a.md' },
    ], attachments: [] };
    await expect(scanMarkdownFolder([file('根/manifest.json', JSON.stringify(manifest)), file('根/a.md'), file('根/b.md')], options)).rejects.toThrow('循环');
    manifest.pages[0]!.path = '../a.md';
    await expect(scanMarkdownFolder([file('根/manifest.json', JSON.stringify(manifest)), file('根/a.md'), file('根/b.md')], options)).rejects.toThrow('无效路径');
  });
});
