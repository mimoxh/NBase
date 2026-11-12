import type { StoredDocumentContent } from '@nbase/contracts';
import { normalizeCodeBlockLanguage } from '../editor/codeLanguages';
import { renderMermaid } from '../editor/renderMermaid';
import { exportPage, type PageExportFormat, type PageExportResult } from './index';
import type { ExportFile, RasterImage, ResourceLoaders } from './resources';

/** Browser-only loaders: Prism, the sandboxed Mermaid renderer and canvas rasterizing. Lazily imported from menus. */
async function highlighter(): Promise<ResourceLoaders['highlight']> {
  try {
    await import('@lexical/code-prism');
    await import('../editor/prism-languages');
    const { default: Prism } = await import('prismjs');
    return (code, language) => {
      const id = normalizeCodeBlockLanguage(language) ?? language;
      const grammar = Prism.languages[id];
      return grammar && id !== 'plain' ? Prism.highlight(code, grammar, id) : null;
    };
  } catch { return undefined; }
}

async function canvasPng(source: CanvasImageSource, width: number, height: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

async function rasterize(svg: string): Promise<RasterImage | null> {
  const box = /viewBox="[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)"/.exec(svg);
  const width = Math.min(Math.max(Math.round(Number(box?.[1] ?? 800)), 1), 2400), height = Math.min(Math.max(Math.round(Number(box?.[2] ?? 600)), 1), 4000);
  // Explicit pixel size: Mermaid writes width="100%", which an <img> cannot resolve on its own.
  const sized = svg.replace(/^<svg\b([^>]*?)\swidth="[^"]*"/, '<svg$1').replace(/^<svg\b/, `<svg width="${width}" height="${height}"`);
  const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = 2;
    const bytes = await canvasPng(image, width * scale, height * scale);
    return bytes ? { bytes, width, height } : null;
  } finally { URL.revokeObjectURL(url); }
}

async function transcode(file: ExportFile): Promise<ExportFile | null> {
  const bitmap = await createImageBitmap(new Blob([file.bytes], { type: file.mediaType }));
  try {
    const bytes = await canvasPng(bitmap, bitmap.width, bitmap.height);
    return bytes ? { ...file, bytes, mediaType: 'image/png', size: file.size ?? { width: bitmap.width, height: bitmap.height } } : null;
  } finally { bitmap.close(); }
}

export interface PageExportOptions {
  title: string;
  content: StoredDocumentContent;
  format: PageExportFormat;
  fetchAttachment?: (id: string) => Promise<Blob>;
  pageTitle?: (id: string) => string | undefined;
  onProgress?: (text: string) => void;
}

export async function exportPageFile({ title, content, format, fetchAttachment, pageTitle, onProgress }: PageExportOptions): Promise<PageExportResult> {
  const loaders: ResourceLoaders = {
    renderMermaid: async source => {
      const controller = new AbortController();
      return (await renderMermaid(source, controller.signal)).text();
    },
    rasterize, transcode,
    ...(fetchAttachment ? { fetchAttachment } : {}), ...(pageTitle ? { pageTitle } : {}), ...(onProgress ? { onProgress } : {}),
  };
  if (format === 'html') { const highlight = await highlighter(); if (highlight) loaders.highlight = highlight; }
  return exportPage({ title, content }, format, loaders);
}
