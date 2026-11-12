import { pageReferenceLabelLimit } from './pageReferences.js';

/** NodeState key of a block's stable anchor; assigned only when a block is first referenced. */
export const blockIdKey = 'nbaseBlockId';

export function isBlockId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]{8}$/.test(value);
}

export interface SerializedBlockReference {
  type: 'block-reference';
  version: 1;
  targetPageId: string;
  blockId: string;
  /** Text of the block when the reference was made; shown when the block cannot be read. */
  label: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSerializedBlockReference(value: Record<string, unknown>): boolean {
  return value.type === 'block-reference' && value.version === 1 && value.children === undefined
    && typeof value.targetPageId === 'string' && uuid.test(value.targetPageId) && isBlockId(value.blockId)
    && typeof value.label === 'string' && value.label.length <= pageReferenceLabelLimit && Boolean(value.label.trim())
    && !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value.label);
}

export const blockReferenceUrl = (pageId: string, blockId: string) => `/?page=${pageId}#block-${blockId}`;
