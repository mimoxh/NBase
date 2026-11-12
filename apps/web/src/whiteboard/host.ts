import { whiteboardSearchText, type WhiteboardContent } from '@nbase/contracts';
import type { DocumentContent, EditorSnapshot } from '../editor/types';

/**
 * Glue for the workspaces. This module is static-imported by them, so it must stay tiny and must
 * not pull in the engine; the board UI itself loads through `lazy.tsx`.
 */

/** A whiteboard save travels through the document saver as a snapshot without Markdown or outline. */
export function boardSnapshot(content: WhiteboardContent): EditorSnapshot {
  return { content: content as unknown as DocumentContent, markdown: '', plainText: whiteboardSearchText(content.board), outline: [] };
}

export function attachmentContentUrl(workspaceId: string, attachmentId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(attachmentId)}/content`;
}

/** Session-only images for the demo workspace; they are gone on reload, like every demo change. */
const demoImages = new Map<string, string>();

export function demoImageUrl(attachmentId: string): string | null { return demoImages.get(attachmentId) ?? null; }

export async function demoUploadImages(files: File[]): Promise<{ id: string; fileName: string; mediaType: string }[]> {
  return files.filter(file => file.size > 0 && file.size <= 10 * 1024 * 1024).map(file => {
    const id = crypto.randomUUID();
    demoImages.set(id, URL.createObjectURL(file));
    const extension = file.type === 'image/jpeg' ? '.jpg' : `.${file.type.split('/')[1] ?? 'png'}`;
    return { id, fileName: (file.name || `image${extension}`).slice(0, 180), mediaType: file.type };
  });
}
