export interface AttachmentMetadata {
  id: string;
  workspaceId: string;
  fileName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
}

/** Audio and video may be larger; every other attachment keeps the original 10 MiB limit. */
export const attachmentByteLimit = 10 * 1024 * 1024;
export const mediaAttachmentByteLimit = 100 * 1024 * 1024;

const mediaExtensions = /\.(?:mp3|m4a|wav|ogg|oga|mp4|m4v|webm)$/i;

export function isMediaAttachment(mediaTypeOrName: string): boolean {
  return /^(?:audio|video)\//.test(mediaTypeOrName) || mediaExtensions.test(mediaTypeOrName);
}

/** Client pre-check by browser type or file name; the server decides from the bytes. */
export function attachmentLimitFor(mediaTypeOrName: string): number {
  return isMediaAttachment(mediaTypeOrName) ? mediaAttachmentByteLimit : attachmentByteLimit;
}

/** Shown inline in the editor (image, audio, video, PDF); everything else is download-only. */
export function attachmentPreviewKind(mediaType: string): 'image' | 'audio' | 'video' | 'pdf' | null {
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType.startsWith('video/')) return 'video';
  return mediaType === 'application/pdf' ? 'pdf' : null;
}
