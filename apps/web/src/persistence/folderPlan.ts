import type { AttachmentMetadata, PageSummary, StoredDocumentContent } from '@nbase/contracts';
import {
  folderAttachment, folderBaseName, folderDestination, folderNodeLink, folderPageReference, folderParentPath,
  isFolderObject, keepExternalPageReference, keepFolderLinkLiteral, mapFolderDocument, normalizeFolderPath, trimUtf16,
} from './folderLinks';

export const folderMarkdownLimit = 200;
export const folderFileLimit = 1000;
export const folderBytesLimit = 190 * 1024 * 1024;
const documentBytesLimit = 1024 * 1024;
const attachmentBytesLimit = 10 * 1024 * 1024;
export const subtreeManifestFormat = 'nbase-subtree-export-v1';
export const folderAttachmentExtensions: Readonly<Record<string, string>> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'text/plain': '.txt', 'text/markdown': '.md',
};

const markdownPath = /\.(?:md|markdown)$/iu;
const supportedAttachment = /\.(?:png|jpe?g|gif|webp|pdf|zip|txt|md)$/iu;
const supportedImage = /\.(?:png|jpe?g|gif|webp)$/iu;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface FolderParsedMarkdown {
  content: StoredDocumentContent;
  title?: string | undefined;
  tagNames: readonly string[];
  warnings: readonly string[];
}

export type FolderMarkdownParser = (source: string) => FolderParsedMarkdown;
export interface FolderDiagnostic { path: string; message: string }
export interface FolderSourceFile { path: string; file: File }

export interface FolderPagePlan {
  key: string;
  path: string;
  sourcePath: string | null;
  parentKey: string | null;
  title: string;
  createId: string;
  updateId: string;
  tagNames: string[];
  pageDependencies: string[];
  attachmentPaths: string[];
}

export interface FolderAttachmentPlan {
  path: string;
  id: string;
  fileName: string;
}

export interface FolderImportPlan {
  rootName: string;
  parentId: string | null;
  knownPageIds: string[];
  pages: FolderPagePlan[];
  attachments: FolderAttachmentPlan[];
  issues: FolderDiagnostic[];
  inputFileCount: number;
  inputBytes: number;
}

export interface SubtreeManifest {
  format: typeof subtreeManifestFormat;
  pages: { path: string; parentPath: string | null; title: string }[];
  attachments: { path: string; fileName: string }[];
}

type PageSeed = Pick<FolderPagePlan, 'key' | 'path' | 'sourcePath' | 'parentKey' | 'title'>;

export async function readFolderMarkdown(file: File): Promise<string> {
  if (file.size > documentBytesLimit) throw new Error('Markdown 文件超过 1 MiB。');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('Markdown 文件须使用 UTF-8 编码。'); }
}

function manifestPath(value: unknown): string {
  const path = typeof value === 'string' ? normalizeFolderPath(value) : null;
  if (!path) throw new Error('NBase 导出清单包含无效路径。');
  return path;
}

function orderedPages(items: PageSeed[]): PageSeed[] {
  const byKey = new Map(items.map(item => [item.key, item]));
  if (byKey.size !== items.length) throw new Error('NBase 导出清单包含重复页面路径。');
  const order: PageSeed[] = [];
  const visited = new Set<string>();
  const visit = (item: PageSeed, path: Set<string>) => {
    if (visited.has(item.key)) return;
    if (path.has(item.key) || path.size >= 32) throw new Error('导入页面层级包含循环或超过 32 层。');
    if (item.parentKey) {
      const parent = byKey.get(item.parentKey);
      if (!parent) throw new Error('NBase 导出清单缺少父页 ' + item.parentKey);
      path.add(item.key);
      visit(parent, path);
      path.delete(item.key);
    }
    visited.add(item.key);
    order.push(item);
  };
  for (const item of items) visit(item, new Set());
  return order;
}

function regularSeeds(paths: string[]): PageSeed[] {
  const notes = paths.filter(path => markdownPath.test(path));
  if (notes.length > folderMarkdownLimit) throw new Error('单批最多导入 200 个 Markdown 文件。');
  const directories = new Map<string, PageSeed>();
  const parentKey = (path: string): string | null => {
    const parent = folderParentPath(path);
    if (!parent) return null;
    const key = 'folder:' + parent;
    if (!directories.has(parent)) {
      directories.set(parent, { key, path: parent, sourcePath: null,
        parentKey: parentKey(parent), title: folderBaseName(parent) });
    }
    return key;
  };
  const pages = notes.map(path => ({ key: 'file:' + path, path, sourcePath: path,
    parentKey: parentKey(path), title: folderBaseName(path).replace(markdownPath, '') }));
  return [...directories.values(), ...pages];
}

async function readManifest(sources: Map<string, File>, rootName: string): Promise<{
  pages: PageSeed[];
  attachmentNames: Map<string, string>;
} | null> {
  const file = sources.get('manifest.json');
  if (!file || file.size > documentBytesLimit) return null;
  let value: unknown;
  try { value = JSON.parse(await file.text()); } catch { return null; }
  if (!isFolderObject(value)) return null;
  const attachmentNames = new Map<string, string>();
  if (value.format === 'nbase-page-export-v1') {
    if (!sources.has('document.md')) throw new Error('NBase 单页导出清单缺少 document.md。');
    if (Array.isArray(value.attachments)) {
      for (const item of value.attachments) {
        if (!isFolderObject(item) || typeof item.id !== 'string' || !uuid.test(item.id)
          || typeof item.mediaType !== 'string' || !Object.hasOwn(folderAttachmentExtensions, item.mediaType)
          || typeof item.fileName !== 'string') continue;
        attachmentNames.set('attachments/' + item.id.toLowerCase() + folderAttachmentExtensions[item.mediaType], item.fileName);
      }
    }
    return { pages: [{ key: 'file:document.md', path: 'document.md', sourcePath: 'document.md',
      parentKey: null, title: rootName }], attachmentNames };
  }
  if (value.format !== subtreeManifestFormat) return null;
  if (!Array.isArray(value.pages) || !value.pages.length || value.pages.length > folderMarkdownLimit
    || !Array.isArray(value.attachments) || value.attachments.length > folderFileLimit) throw new Error('NBase 子树清单格式无效。');
  const pages = value.pages.map((entry: unknown): PageSeed => {
    if (!isFolderObject(entry) || typeof entry.title !== 'string') throw new Error('NBase 子树清单包含无效页面。');
    const path = manifestPath(entry.path);
    if (!markdownPath.test(path) || !sources.has(path)) throw new Error('NBase 子树清单缺少页面文件 ' + path);
    return { key: 'file:' + path, path, sourcePath: path, title: entry.title,
      parentKey: entry.parentPath === null ? null : 'file:' + manifestPath(entry.parentPath) };
  });
  for (const entry of value.attachments) {
    if (!isFolderObject(entry) || typeof entry.fileName !== 'string') throw new Error('NBase 子树清单包含无效附件。');
    const path = manifestPath(entry.path);
    if (attachmentNames.has(path) || pages.some(page => page.path === path)) throw new Error('NBase 子树清单包含重复路径 ' + path);
    attachmentNames.set(path, entry.fileName);
  }
  return { pages, attachmentNames };
}

function normalizeTitle(value: string): string {
  return trimUtf16(value.replace(/[\p{Cc}\p{Cs}]/gu, ' ').trim(), 255).trim() || '未命名页面';
}

function reserveTitle(original: string, used: Set<string>): string {
  let title = original;
  for (let n = 2; used.has(title.normalize('NFC')); n++) {
    const suffix = '（' + n + '）';
    title = trimUtf16(original, 255 - suffix.length) + suffix;
  }
  used.add(title.normalize('NFC'));
  return title;
}

function safeAttachmentName(name: string): boolean {
  return name.length <= 180 && name.trim() === name && !/[/:\\\u0000-\u001f\u007f]/u.test(name)
    && supportedAttachment.test(name);
}

/** Only file paths represented in this selection can become workspace references. */
function pageLookup(pages: readonly FolderPagePlan[]) {
  const byPath = new Map(pages.map(page => [page.path, page]));
  return (path: string) => {
    const exact = byPath.get(path);
    if (exact) return exact;
    const short = byPath.get(path + '.md');
    const long = byPath.get(path + '.markdown');
    return short && long ? undefined : short ?? long;
  };
}

export async function scanMarkdownFolder(files: readonly File[], options: {
  pages: readonly PageSummary[];
  parentId: string | null;
  parseMarkdown: FolderMarkdownParser;
}): Promise<{ plan: FolderImportPlan; sources: FolderSourceFile[] }> {
  if (!files.length || files.length > folderFileLimit) throw new Error('请选择包含 1 至 1,000 个文件的目录。');
  const inputBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (inputBytes > folderBytesLimit) throw new Error('单批文件总量不能超过 190 MiB。');
  if (options.parentId && !options.pages.some(page => page.id === options.parentId)) throw new Error('目标父页已不可用。');
  const issues: FolderDiagnostic[] = [];
  const sources = new Map<string, File>();
  const duplicates = new Set<string>();
  let rootName = '';
  for (const file of files) {
    const relative = file.webkitRelativePath;
    const slash = relative.indexOf('/');
    const root = slash > 0 ? normalizeFolderPath(relative.slice(0, slash)) : null;
    const path = slash > 0 ? normalizeFolderPath(relative.slice(slash + 1)) : null;
    if (!root || !path || (rootName && root !== rootName)) {
      issues.push({ path: relative || file.name, message: '路径无效或不在所选目录中，已跳过。' }); continue;
    }
    rootName ||= root;
    if (sources.has(path) || duplicates.has(path)) {
      issues.push({ path, message: '存在重复的规范化路径，已跳过此路径的全部文件。' });
      sources.delete(path); duplicates.add(path); continue;
    }
    sources.set(path, file);
  }
  const manifest = await readManifest(sources, rootName);
  const seeds = orderedPages(manifest?.pages ?? regularSeeds([...sources.keys()].sort()));
  if (!seeds.some(page => page.sourcePath)) throw new Error(issues[0]?.message ?? '所选目录没有可导入的 Markdown 文件。');
  if (seeds.length > folderFileLimit || options.pages.length + seeds.length > 2000) {
    throw new Error('导入会超过工作台可加载的页面数量上限，请分批整理目标工作区。');
  }
  const rootTitles = new Set(options.pages.filter(page => page.parentId === options.parentId).map(page => page.title.normalize('NFC')));
  const titles = new Map<string | null, Set<string>>([[null, rootTitles]]);
  const pages: FolderPagePlan[] = [];
  // Keep only references between files; retaining every parsed Lexical tree multiplies input memory.
  const pageReferences = new Map<string, { url: string; label: string; image: boolean }[]>();
  for (const seed of seeds) {
    let parsed: FolderParsedMarkdown | undefined;
    if (seed.sourcePath) {
      try {
        parsed = options.parseMarkdown(await readFolderMarkdown(sources.get(seed.sourcePath)!));
        if (parsed.content.schemaVersion !== 1) throw new Error('正文格式版本无效。');
      } catch (error) {
        issues.push({ path: seed.path, message: error instanceof Error ? error.message : 'Markdown 文件无法读取。' });
        continue;
      }
      parsed.warnings.forEach(message => issues.push({ path: seed.path, message }));
    }
    if (seed.parentKey && !pages.some(page => page.key === seed.parentKey)) {
      issues.push({ path: seed.path, message: '父页无法导入，已跳过。' }); continue;
    }
    const used = titles.get(seed.parentKey) ?? new Set<string>();
    titles.set(seed.parentKey, used);
    const original = normalizeTitle(parsed?.title || seed.title);
    const title = reserveTitle(original, used);
    if (title !== original) issues.push({ path: seed.path, message: '同级页面重名，将创建为 ' + title + '。' });
    pages.push({ ...seed, title, createId: crypto.randomUUID(), updateId: crypto.randomUUID(),
      tagNames: [...new Set(parsed?.tagNames ?? [])], pageDependencies: [], attachmentPaths: [] });
    if (parsed) {
      const references: { url: string; label: string; image: boolean }[] = [];
      mapFolderDocument(parsed.content, node => {
        const reference = folderNodeLink(node);
        if (reference) references.push(reference);
        if (node.type === 'page-reference' && typeof node.targetPageId === 'string'
          && !options.pages.some(page => page.id === node.targetPageId)) {
          issues.push({ path: seed.path, message: '此工作区没有该稳定页面引用，将保留为普通链接：' + node.targetPageId });
        }
        return node;
      });
      pageReferences.set(seed.key, references);
    }
  }
  if (!pageReferences.size) throw new Error(issues[0]?.message ?? '没有可导入的 Markdown 文件。');
  const lookup = pageLookup(pages);
  const attachments = new Map<string, FolderAttachmentPlan>();
  for (const page of pages) {
    const references = pageReferences.get(page.key);
    if (!references || !page.sourcePath) continue;
    const pageDependencies = new Set<string>();
    const attachmentPaths = new Set<string>();
    const notice = (message: string) => issues.push({ path: page.path, message });
    for (const reference of references) {
      const destination = folderDestination(reference.url, page.sourcePath);
      if (destination.kind === 'outside') notice('引用越界或路径无效：' + reference.url);
      if (destination.kind !== 'local') continue;
      const target = reference.image ? undefined : lookup(destination.path);
      if (target) pageDependencies.add(target.key);
      else {
        if (!reference.image && pages.filter(item => item.path === destination.path + '.md'
          || item.path === destination.path + '.markdown').length > 1) {
          notice('引用文件名存在歧义，请使用完整扩展名：' + destination.path); continue;
        }
        const file = sources.get(destination.path);
        if (!file) { notice('缺少引用文件：' + destination.path); continue; }
        const fileName = manifest?.attachmentNames.get(destination.path) ?? folderBaseName(destination.path);
        if (!safeAttachmentName(fileName) || (reference.image && !supportedImage.test(fileName))) {
          notice('不支持的附件类型或名称：' + destination.path); continue;
        }
        if (file.size === 0 || file.size > attachmentBytesLimit) {
          notice('附件大小须在 1 字节至 10 MiB 之间：' + destination.path); continue;
        }
        attachmentPaths.add(destination.path);
        if (!attachments.has(destination.path)) {
          attachments.set(destination.path, { path: destination.path, id: crypto.randomUUID(), fileName });
        }
      }
      if (destination.hasSuffix) notice('重建引用时省略目标的查询参数或锚点：' + reference.url);
    }
    page.pageDependencies = [...pageDependencies];
    page.attachmentPaths = [...attachmentPaths];
  }
  const keep = new Set([...pages.flatMap(page => page.sourcePath ? [page.sourcePath] : []), ...attachments.keys()]);
  return { plan: { rootName, parentId: options.parentId, knownPageIds: options.pages.map(page => page.id),
    pages, attachments: [...attachments.values()], issues, inputFileCount: files.length, inputBytes },
    sources: [...sources].filter(([path]) => keep.has(path)).map(([path, file]) => ({ path, file })) };
}

export function rebuildFolderContent(plan: FolderImportPlan, page: FolderPagePlan, content: StoredDocumentContent,
  pageIds: ReadonlyMap<string, string>, attachments: ReadonlyMap<string, AttachmentMetadata>): StoredDocumentContent {
  const lookup = pageLookup(plan.pages);
  const known = new Set(plan.knownPageIds);
  const expectedAttachments = new Set(page.attachmentPaths);
  return mapFolderDocument(content, node => {
    if (node.type === 'page-reference' && typeof node.targetPageId === 'string' && !known.has(node.targetPageId)) {
      return keepExternalPageReference(node);
    }
    const reference = folderNodeLink(node);
    if (!reference || !page.sourcePath) return node;
    const destination = folderDestination(reference.url, page.sourcePath);
    if (destination.kind === 'local') {
      const target = reference.image ? undefined : lookup(destination.path);
      const id = target && pageIds.get(target.key);
      if (id && target) return folderPageReference(id, reference.label, target.title);
      const attachment = expectedAttachments.has(destination.path) && attachments.get(destination.path);
      if (attachment && (!reference.image || attachment.mediaType.startsWith('image/'))) return folderAttachment(attachment, reference.label);
    }
    if (!reference.image && (destination.kind === 'local' || destination.kind === 'outside')) {
      return keepFolderLinkLiteral(reference.url, reference.label);
    }
    return node;
  });
}
