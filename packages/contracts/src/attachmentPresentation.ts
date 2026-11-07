export const attachmentAligns = ['left', 'center', 'right'] as const;
export type AttachmentAlign = typeof attachmentAligns[number];

export const attachmentWidthMin = 10;
export const attachmentWidthMax = 100;
export const attachmentCaptionMaxLength = 300;

/** Optional image display settings. Absent keys keep older content byte-identical. */
export interface AttachmentPresentation {
  /** Percentage of the text column. */
  width?: number;
  align?: AttachmentAlign;
  caption?: string;
}

export function isAttachmentCaption(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= attachmentCaptionMaxLength
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isAttachmentPresentation(value: unknown): value is AttachmentPresentation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { width, align, caption } = value as Record<string, unknown>;
  return (width === undefined || (Number.isInteger(width) && Number(width) >= attachmentWidthMin && Number(width) <= attachmentWidthMax))
    && (align === undefined || attachmentAligns.includes(align as AttachmentAlign))
    && (caption === undefined || isAttachmentCaption(caption));
}

/** Copies only presentation keys that are set, from a node or manifest record. */
export function attachmentPresentationOf(value: AttachmentPresentation): AttachmentPresentation {
  return {
    ...(value.width === undefined ? {} : { width: value.width }),
    ...(value.align === undefined ? {} : { align: value.align }),
    ...(value.caption === undefined ? {} : { caption: value.caption }),
  };
}
