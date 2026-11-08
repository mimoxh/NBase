import type { SerializedEditorState } from 'lexical';
import type { AttachmentMetadata, PageSummary } from '@nbase/contracts';
import type { DatabaseEmbedding } from './nodes/DatabaseViewNode';

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

export interface DocumentEditorProps {
  documentId: string;
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
}

export interface MarkdownAssessment {
  warnings: string[];
}
