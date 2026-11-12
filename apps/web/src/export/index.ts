import type { StoredDocumentContent } from '@nbase/contracts';
import { buildDocx } from './docx';
import { assetPath, renderHtmlDocument } from './html';
import { loadResources, type ResourceLoaders } from './resources';
import { base64, rootOf, yieldToBrowser } from './tree';
import { utf8, zipEntries, type ZipEntry } from './zip';

export { registerHtmlRenderer } from './html';
export { registerDocxRenderer } from './docx';

export type PageExportFormat = 'html' | 'docx';
export interface PageExportResult { blob: Blob; extension: '.html' | '.zip' | '.docx'; note?: string }

/** Images up to this total are embedded as data: URIs; beyond it the HTML ships as a ZIP with assets/. */
export const singleHtmlImageBytes = 20 * 1024 * 1024;

export async function exportPage(page: { title: string; content: StoredDocumentContent }, format: PageExportFormat,
  loaders: ResourceLoaders = {}): Promise<PageExportResult> {
  const resources = await loadResources(rootOf(page.content), loaders, format);
  loaders.onProgress?.(format === 'docx' ? '正在生成 Word 文档…' : '正在生成 HTML…');
  await yieldToBrowser();
  if (format === 'docx') return { blob: buildDocx(page, resources), extension: '.docx' };
  const files = [...resources.files.values()];
  const imageBytes = files.filter(file => file.mediaType.startsWith('image/')).reduce((sum, file) => sum + file.bytes.length, 0);
  // Non-image files cannot live inside one HTML file; ship them beside it rather than drop them.
  if (imageBytes <= singleHtmlImageBytes && files.every(file => file.mediaType.startsWith('image/'))) {
    for (const file of files) { file.base64 = base64(file.bytes); await yieldToBrowser(); }
    return { blob: new Blob([renderHtmlDocument(page, resources, 'single')], { type: 'text/html;charset=utf-8' }), extension: '.html' };
  }
  const entries: ZipEntry[] = [{ name: 'index.html', bytes: utf8(renderHtmlDocument(page, resources, 'package')) }];
  for (const file of files) entries.push({ name: assetPath(file), bytes: file.bytes });
  return { blob: zipEntries(entries), extension: '.zip',
    note: imageBytes > singleHtmlImageBytes ? '图片总量超过 20 MB，已改为 ZIP（index.html + assets/）。' : '页面含非图片附件，已改为 ZIP（index.html + assets/）。' };
}
