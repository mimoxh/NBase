export { zipEntries, type ZipEntry } from '../persistence/attachmentExport';

const extensions: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'text/plain': '.txt', 'text/markdown': '.md',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/mp4': '.m4a', 'video/mp4': '.mp4', 'video/webm': '.webm',
};

/** Package paths come from the media type, falling back to a plain extension of the original name. */
export function extensionFor(mediaType: string, fileName = ''): string {
  return extensions[mediaType] ?? /\.[a-z0-9]{1,8}$/i.exec(fileName)?.[0]?.toLowerCase() ?? '.bin';
}

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
