import type { SerializedEditorState } from 'lexical';
import type { Provider } from '@lexical/yjs';
import type { Doc } from 'yjs';
import type { AttachmentMetadata, CommentAnchor, LinkPreview, PageSummary } from '@nbase/contracts';
import type { DatabaseEmbedding } from './nodes/DatabaseViewNode';
import type { EmbeddedPages } from '../embed/source';

/** Versioned document payload; runtime node keys are never document identities. */
export interface DocumentContent {
  schemaVersion: 1;
  editorState: SerializedEditorState;
}

export interface OutlineItem {
  /** View-only anchor, not a persistent block ID. */
  id: string;
  text: string;
  level: number;
}

export interface EditorSnapshot {
  content: DocumentContent;
  markdown: string;
  plainText: string;
  outline: OutlineItem[];
}

export interface EditorPageReferences {
  pages: readonly PageSummary[];
  open: (pageId: string) => void;
}

export type AttachmentPickKind = 'image' | 'file';

/** A real-time room the editor is bound to (docs/architecture/realtime.md). */
export interface DocumentCollab {
  providerFactory: (id: string, docs: Map<string, Doc>) => Provider;
  /** Shown next to this user's cursor in other tabs. */
  username: string;
  cursorColor: string;
  /** Called when an input method composition starts and ends in this editor. */
  onComposition?: ((composing: boolean) => void) | undefined;
}

export interface DocumentEditorProps {
  documentId: string;
  /** Edits a room's shared document instead of local state; undo then only covers this user's own changes. */
  collab?: DocumentCollab | undefined;
  title?: string | undefined;
  onReplaceTitle?: ((title: string, bodyChanged: boolean) => void) | undefined;
  pageReferences?: EditorPageReferences | undefined;
  initialContent?: DocumentContent | undefined;
  initialMarkdown?: string | undefined;
  readOnly?: boolean | undefined;
  onChange: (documentId: string, snapshot: EditorSnapshot) => void;
  onReady?: ((documentId: string, snapshot: EditorSnapshot) => void) | undefined;
  onNotice?: ((message: string) => void) | undefined;
  workspaceId?: string | undefined;
  onUploadFiles?: ((files: File[]) => Promise<AttachmentMetadata[]>) | undefined;
  /** Opens the workspace file picker; without it the slash menu offers no upload commands. */
  onPickAttachment?: ((kind: AttachmentPickKind) => void) | undefined;
  /** Shows database view blocks live; without it they render as placeholders and no database commands appear. */
  databases?: DatabaseEmbedding | undefined;
  /** Shows embedded whiteboards live; without it they render as placeholders and no whiteboard commands appear. */
  embeds?: EmbeddedPages | undefined;
  /** Reads a web page's title for a bookmark card; without it bookmarks show the address only. */
  onLinkPreview?: ((url: string) => Promise<LinkPreview>) | undefined;
  /** Current text of an anchored block in a saved page, or null when it no longer exists. */
  resolveBlock?: ((pageId: string, blockId: string) => Promise<string | null>) | undefined;
}

export interface DocumentEditorHandle {
  getSnapshot: () => EditorSnapshot;
  focus: () => void;
  insertAttachments: (attachments: AttachmentMetadata[]) => void;
  /** A source application is a single undoable replacement in this editor instance. */
  replaceContent: (content: DocumentContent) => boolean;
  findText: (phrase: string) => boolean;
  jumpToHeading: (id: string) => void;
  locatePageReference: (targetPageId: string, occurrence?: number) => boolean;
  /** Where a new comment would point: the block under the current selection, or null when nothing is selected. */
  commentAnchor: () => CommentAnchor | null;
  /** Whether the commented block can still be found; with `reveal`, scrolls to it and flashes it. */
  locateComment: (anchor: CommentAnchor, reveal?: boolean) => boolean;
}

export interface MarkdownAssessment {
  warnings: string[];
}
