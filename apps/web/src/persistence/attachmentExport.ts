import type { StoredDocumentContent } from '@nbase/contracts';
import { readMarkdownFrontMatter } from '../editor/markdownFrontMatter';
import { rewriteMarkdownProse } from '../editor/markdownReferences';

import { attachmentPresentations, hasAttachmentPresentation } from './attachmentPresentation';

export interface ExportAttachment {
  id: string;
  fileName: string;
  mediaType: string;
}

const extensionByType: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'text/plain': '.txt', 'text/markdown': '.md',
};

/** The server already validates document nodes; this is bounded defensive extraction for export. */
export function exportAttachments(content: StoredDocumentContent): ExportAttachment[] {
  const found = new Map<string, ExportAttachment>();
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 64 || found.size > 20_000) return;
    const value = node as Record<string, unknown>;
    if (value.type === 'attachment' && typeof value.attachmentId === 'string'
      && typeof value.fileName === 'string' && typeof value.mediaType === 'string'
      && extensionByType[value.mediaType]) {
      found.set(value.attachmentId, { id: value.attachmentId,
        fileName: value.fileName, mediaType: value.mediaType });
    }
    if (Array.isArray(value.children)) value.children.forEach(child => visit(child, depth + 1));
  };
  visit(content.editorState.root, 0);
  return [...found.values()];
}

export function portableMarkdown(markdown: string, attachments: ExportAttachment[]): string {
  const paths = new Map(attachments.map(item => [item.id.toLowerCase(),
    `attachments/${item.id.toLowerCase()}${extensionByType[item.mediaType]}`]));
  const header = readMarkdownFrontMatter(markdown);
  const body = header.preservedAsSource ? markdown : header.body;
  const prefix = markdown.slice(0, markdown.length - body.length);
  return prefix + rewriteMarkdownProse(body, prose => prose.replace(/\]\(nbase-attachment:([0-9a-f-]{36})\)/gi, (match, id: string) => {
    const path = paths.get(id.toLowerCase());
    return path ? `](${path})` : match;
  }));
}

export interface ZipEntry { name: string; bytes: Uint8Array<ArrayBuffer> }

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** ZIP store method: no dependency, no decompression, and an explicit memory bound. */
export function zipEntries(entries: ZipEntry[]): Blob {
  if (!entries.length || entries.length > 10_000) throw new Error('导出文件数量超出限制。');
  const encoder = new TextEncoder();
  const records = entries.map(entry => {
    if (!entry.name || entry.name.startsWith('/') || entry.name.includes('..') || entry.name.includes('\\')) {
      throw new Error('导出文件名无效。');
    }
    const name = encoder.encode(entry.name);
    if (name.length > 65535 || entry.bytes.length > 0xffffffff) throw new Error('导出文件过大。');
    return { name, bytes: entry.bytes, crc: crc32(entry.bytes), offset: 0 };
  });
  const localSize = records.reduce((size, item) => size + 30 + item.name.length + item.bytes.length, 0);
  const centralSize = records.reduce((size, item) => size + 46 + item.name.length, 0);
  const total = localSize + centralSize + 22;
  if (total > 200 * 1024 * 1024) throw new Error('附件总量超过 200 MB，请使用完整备份或分批下载。');
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  let cursor = 0;
  const u16 = (value: number) => { view.setUint16(cursor, value, true); cursor += 2; };
  const u32 = (value: number) => { view.setUint32(cursor, value, true); cursor += 4; };
  const copy = (value: Uint8Array) => { bytes.set(value, cursor); cursor += value.length; };
  for (const item of records) {
    item.offset = cursor;
    u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(0); u16(0);
    u32(item.crc); u32(item.bytes.length); u32(item.bytes.length);
    u16(item.name.length); u16(0); copy(item.name); copy(item.bytes);
  }
  const centralStart = cursor;
  for (const item of records) {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(0); u16(0);
    u32(item.crc); u32(item.bytes.length); u32(item.bytes.length);
    u16(item.name.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(item.offset);
    copy(item.name);
  }
  const centralLength = cursor - centralStart;
  u32(0x06054b50); u16(0); u16(0); u16(records.length); u16(records.length);
  u32(centralLength); u32(centralStart); u16(0);
  if (cursor !== total) throw new Error('导出文件构建失败。');
  return new Blob([bytes], { type: 'application/zip' });
}

export async function packagePage(markdown: string, content: StoredDocumentContent,
  fetchAttachment: (id: string) => Promise<Blob>): Promise<Blob> {
  const attachments = exportAttachments(content);
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [{ name: 'document.md', bytes: encoder.encode(portableMarkdown(markdown, attachments)) }];
  let accumulatedBytes = entries[0]!.bytes.length;
  for (const item of attachments) {
    const blob = await fetchAttachment(item.id);
    accumulatedBytes += blob.size;
    if (accumulatedBytes > 190 * 1024 * 1024) {
      throw new Error('附件总量超过 190 MB，请使用完整备份或分批下载。');
    }
    const extension = extensionByType[item.mediaType]!;
    entries.push({ name: `attachments/${item.id.toLowerCase()}${extension}`,
      bytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  const presentations = attachmentPresentations(content);
  entries.push({ name: 'manifest.json', bytes: encoder.encode(JSON.stringify({ format: 'nbase-page-export-v1',
    attachments, ...(hasAttachmentPresentation(presentations) ? { presentations } : {}) }, null, 2)) });
  return zipEntries(entries);
}
