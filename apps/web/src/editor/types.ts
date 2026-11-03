import type { SerializedEditorState } from 'lexical';
import type { AttachmentMetadata } from '@nbase/contracts';

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

export interface DocumentEditorProps {
  documentId: string;
  initialContent?: DocumentContent | undefined;
  initialMarkdown?: string | undefined;
  readOnly?: boolean | undefined;
  onChange: (documentId: string, snapshot: EditorSnapshot) => void;
  onReady?: ((documentId: string, snapshot: EditorSnapshot) => void) | undefined;
  onNotice?: ((message: string) => void) | undefined;
  workspaceId?: string | undefined;
  onUploadFiles?: ((files: File[]) => Promise<AttachmentMetadata[]>) | undefined;
}

export interface DocumentEditorHandle {
  getSnapshot: () => EditorSnapshot;
  focus: () => void;
  insertAttachments: (attachments: AttachmentMetadata[]) => void;
  findText: (phrase: string) => boolean;
}

export interface MarkdownAssessment {
  warnings: string[];
}
