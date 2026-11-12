import { isWhiteboardContent, whiteboardAttachments, whiteboardContentProblem, whiteboardPageReferences,
  whiteboardSearchText, type PageKind, type WhiteboardContent } from '@nbase/contracts';

export { isWhiteboardContent };

/** Whiteboard pages keep their board inside `content_json`; these are the kind-specific halves of the page write path. */
export function whiteboardProblem(value: unknown): string | null {
  return whiteboardContentProblem(value);
}

export function whiteboardIndex(content: WhiteboardContent) {
  return { searchText: whiteboardSearchText(content.board), references: whiteboardPageReferences(content.board) };
}

export function whiteboardAttachmentReferences(content: WhiteboardContent) {
  return whiteboardAttachments(content.board);
}

/** A page is a whiteboard exactly when its content carries a board; the two never disagree after creation. */
export function contentMatchesKind(kind: PageKind, content: unknown): boolean {
  return isWhiteboardContent(content) === (kind === 'whiteboard');
}
