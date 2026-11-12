import { imageSize } from './imageSize';
import { attachmentNodes, mermaidSources, yieldToBrowser, type SerializedNode } from './tree';

export interface ExportFile {
  id: string;
  fileName: string;
  mediaType: string;
  bytes: Uint8Array<ArrayBuffer>;
  /** Intrinsic pixels, images only. */
  size?: { width: number; height: number } | undefined;
  /** Filled for single-file HTML only. */
  base64?: string | undefined;
}
export interface RasterImage { bytes: Uint8Array<ArrayBuffer>; width: number; height: number }

/** Everything asynchronous is resolved before rendering, so renderers stay synchronous and pure. */
export interface ExportResources {
  files: Map<string, ExportFile>;
  mermaid: Map<string, { svg: string; png?: RasterImage | undefined }>;
  /** Prism HTML for a code block, or null for plain text. Output must already be escaped. */
  highlight?: ((code: string, language: string) => string | null) | undefined;
  /** Titles for page and database ids, when the host knows them. */
  pageTitle?: ((id: string) => string | undefined) | undefined;
}

export interface ResourceLoaders {
  fetchAttachment?: (id: string) => Promise<Blob>;
  renderMermaid?: (source: string) => Promise<string>;
  rasterize?: (svg: string) => Promise<RasterImage | null>;
  /** Re-encodes formats some Word versions cannot show (WebP) as PNG. */
  transcode?: (file: ExportFile) => Promise<ExportFile | null>;
  highlight?: ExportResources['highlight'];
  pageTitle?: ExportResources['pageTitle'];
  onProgress?: (text: string) => void;
}

export const maxExportBytes = 190 * 1024 * 1024;
const maxDiagrams = 60;

export const emptyResources = (): ExportResources => ({ files: new Map(), mermaid: new Map() });

export async function loadResources(root: SerializedNode, loaders: ResourceLoaders, target: 'html' | 'docx'): Promise<ExportResources> {
  const resources: ExportResources = { ...emptyResources(), highlight: loaders.highlight, pageTitle: loaders.pageTitle };
  const attachments = loaders.fetchAttachment ? attachmentNodes(root) : [];
  let total = 0;
  for (const [index, item] of attachments.entries()) {
    loaders.onProgress?.(`正在读取附件 ${index + 1}/${attachments.length}…`);
    // Same rule as the Markdown ZIP: a failed read stops the export instead of producing a partial copy.
    const blob = await loaders.fetchAttachment!(item.id);
    total += blob.size;
    if (total > maxExportBytes) throw new Error('附件总量超过 190 MB，请使用完整备份或分批下载。');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let file: ExportFile = { ...item, bytes, size: item.mediaType.startsWith('image/') ? imageSize(bytes, item.mediaType) ?? undefined : undefined };
    if (target === 'docx' && item.mediaType === 'image/webp' && loaders.transcode) file = await loaders.transcode(file).catch(() => null) ?? file;
    resources.files.set(item.id, file);
    await yieldToBrowser();
  }
  if (loaders.renderMermaid) {
    const sources = mermaidSources(root).slice(0, maxDiagrams);
    for (const [index, source] of sources.entries()) {
      loaders.onProgress?.(`正在渲染图表 ${index + 1}/${sources.length}…`);
      try {
        const svg = await loaders.renderMermaid(source);
        const png = target === 'docx' && loaders.rasterize ? await loaders.rasterize(svg).catch(() => null) ?? undefined : undefined;
        resources.mermaid.set(source, { svg, png });
      } catch { /* The diagram stays as source code; the export still succeeds. */ }
      await yieldToBrowser();
    }
  }
  return resources;
}
