/** Presence, comments and read-only share links (docs/architecture/collaboration.md). */
import { isBlockId } from './blockReferences.js';
import type { StoredDocumentContent } from './pages.js';
import type { PageKind } from './databases.js';
import type { RoomServerMessage } from './realtime.js';

export interface MemberRef { userId: string; loginName: string }

// --- Live channel -------------------------------------------------------------------------------------------

export const liveMessageByteLimit = 1024;
/** WebSocket close code sent when the session or membership behind a connection is no longer valid. */
export const liveCloseAuth = 4401;

export type LiveClientMessage =
  | { t: 'focus'; pageId: string | null; editing: boolean }
  | { t: 'join'; pageId: string }
  | { t: 'leave'; pageId: string }
  | { t: 'ping' };

export interface LivePresenceMember extends MemberRef { editing: boolean }

export type LiveServerMessage =
  | { t: 'hello'; userId: string }
  | { t: 'presence'; pageId: string; members: LivePresenceMember[] }
  | { t: 'saved'; pageId: string; revision: string; by: MemberRef }
  | { t: 'comments'; pageId: string }
  | { t: 'pong' }
  | RoomServerMessage;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLiveClientMessage(text: string): LiveClientMessage | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.t === 'ping') return { t: 'ping' };
  if ((data.t === 'join' || data.t === 'leave') && typeof data.pageId === 'string' && uuid.test(data.pageId)) {
    return { t: data.t, pageId: data.pageId.toLowerCase() };
  }
  if (data.t === 'focus' && (data.pageId === null || (typeof data.pageId === 'string' && uuid.test(data.pageId)))
    && typeof data.editing === 'boolean') {
    return { t: 'focus', pageId: data.pageId === null ? null : (data.pageId as string).toLowerCase(), editing: data.editing };
  }
  return null;
}

// --- Comments -----------------------------------------------------------------------------------------------

export const commentBodyLimit = 4000;
export const commentQuoteLimit = 500;
export const commentAnchorDepthLimit = 16;
export const commentThreadsPerPageLimit = 500;
export const commentsPerThreadLimit = 200;

/** Where a thread points. The block id is used when the block already has one; the path and quote find it otherwise. */
export interface CommentAnchor {
  blockId: string | null;
  /** Child indexes from the root to the block. */
  path: number[];
  /** Text of the block, or of the selection inside it, when the thread was opened. */
  quote: string;
}

export interface PageComment {
  id: string;
  author: MemberRef;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

export interface CommentThread {
  id: string;
  pageId: string;
  anchor: CommentAnchor;
  createdBy: MemberRef;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: MemberRef | null;
  comments: PageComment[];
}

export interface CommentThreadListResponse { threads: CommentThread[] }
export interface CreateCommentThreadRequest { id: string; commentId: string; anchor: CommentAnchor; body: string }
export interface ReplyCommentRequest { id: string; body: string }
export interface EditCommentRequest { body: string }

/** Trimmed body, or null when it is empty, too long, or carries control characters other than newline and tab. */
export function normalizeCommentBody(value: unknown): string | null {
  if (typeof value !== 'string' || /\p{Cs}/u.test(value)) return null;
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text || [...text].length > commentBodyLimit || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return null;
  return text;
}

export function isCommentAnchor(value: unknown): value is CommentAnchor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (data.blockId === null || isBlockId(data.blockId))
    && Array.isArray(data.path) && data.path.length >= 1 && data.path.length <= commentAnchorDepthLimit
    && data.path.every(index => Number.isInteger(index) && (index as number) >= 0 && (index as number) < 100000)
    && typeof data.quote === 'string' && [...data.quote].length <= commentQuoteLimit && !/[\p{Cc}\p{Cs}]/u.test(data.quote);
}

// --- Share links --------------------------------------------------------------------------------------------

export const shareLifetimeDays = [1, 7, 30] as const;
export type ShareLifetimeDays = typeof shareLifetimeDays[number];
export const defaultShareLifetimeDays: ShareLifetimeDays = 7;
export const activeSharesPerPageLimit = 20;
export const shareFragmentKey = 'share';
export const shareTokenHeader = 'x-nbase-share';
export const shareTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export type ShareStatus = 'active' | 'expired' | 'revoked';

export interface PageShare {
  id: string;
  pageId: string;
  includeChildren: boolean;
  status: ShareStatus;
  createdBy: MemberRef;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
}

/** `enabled` is false when the server runs with NBASE_SHARE_LINKS=off: links can be listed and revoked, not created or opened. */
export interface PageShareListResponse { shares: PageShare[]; enabled: boolean }
export interface CreatePageShareRequest { includeChildren: boolean; expiresInDays: ShareLifetimeDays }
export interface CreatePageShareResponse { share: PageShare; token: string; url: string }

export interface SharedPageSummary { id: string; parentId: string | null; title: string; kind: PageKind }
export interface SharedRootResponse { rootPageId: string; title: string; expiresAt: string; pages: SharedPageSummary[] }
export interface SharedPageResponse {
  id: string;
  title: string;
  kind: PageKind;
  updatedAt: string;
  /** Absent for page kinds the share view does not render (whiteboards). */
  content?: StoredDocumentContent;
}

export function isShareLifetime(value: unknown): value is ShareLifetimeDays {
  return (shareLifetimeDays as readonly unknown[]).includes(value);
}

export function shareUrl(publicOrigin: string, shareId: string, token: string): string {
  return `${publicOrigin}/#${shareFragmentKey}=${shareId}.${token}`;
}

/** Reads `#share=<id>.<token>`; anything else is ignored. */
export function shareFromHash(hash: string): { shareId: string; token: string } | null {
  const match = /^#share=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(hash);
  return match ? { shareId: match[1]!.toLowerCase(), token: match[2]! } : null;
}
