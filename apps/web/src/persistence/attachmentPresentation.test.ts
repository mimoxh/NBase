// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { StoredDocumentContent } from '@nbase/contracts';
import { $getRoot, createEditor } from 'lexical';
import { createContentFromMarkdown, markdownFromContent, readEditorSnapshot } from '../editor/markdown';
import { EDITOR_NODES } from '../editor/nodes';
import { $isAttachmentNode } from '../editor/nodes/AttachmentNode';
import { parseSourceEdit, prepareSourceEdit } from '../editor/sourceEditing';
import {
  attachmentPresentations, hasAttachmentPresentation, readAttachmentPresentations, restoreAttachmentPresentations, withCaptionParagraphs,
} from './attachmentPresentation';

const id = '44444444-4444-4444-8444-444444444444';
const image = (extra: object = {}) => ({ type: 'attachment', version: 1, attachmentId: id,
  alt: '图', fileName: '图.png', mediaType: 'image/png', ...extra });

function content(nodes: object[]): StoredDocumentContent {
  const base = createContentFromMarkdown('后文');
  const tree = structuredClone(base) as unknown as StoredDocumentContent & { editorState: { root: { children: object[] } } };
  const paragraph = tree.editorState.root.children[0] as { children: object[] };
  tree.editorState.root.children = [{ ...structuredClone(paragraph), children: nodes }, paragraph];
  return tree;
}

function reopened(value: StoredDocumentContent) {
  const editor = createEditor({ nodes: EDITOR_NODES, onError: error => { throw error; } });
  const state = editor.parseEditorState(value.editorState as never);
  editor.setEditorState(state);
  return { editor, snapshot: readEditorSnapshot(state) };
}

describe('attachment node presentation', () => {
  it('adds no keys to plain attachments', () => {
    const { snapshot } = reopened(content([image()]));
    const tree = snapshot.content.editorState as unknown as { root: { children: { children: Record<string, unknown>[] }[] } };
    const node = tree.root.children[0]!.children[0]!;
    expect(node.version).toBe(1);
    expect(Object.keys(node).sort()).toEqual(['alt', 'attachmentId', 'fileName', 'mediaType', 'type', 'version']);
  });

  it('round-trips width, alignment and caption through JSON, and ignores invalid values', () => {
    const { editor } = reopened(content([image({ width: 50, align: 'center', caption: '图注' })]));
    editor.read('latest', () => {
      const node = $getRoot().getFirstDescendant();
      expect($isAttachmentNode(node) && node.getPresentation()).toEqual({ width: 50, align: 'center', caption: '图注' });
    });
    const invalid = reopened(content([image({ width: 500 })]));
    invalid.editor.read('latest', () => {
      const node = $getRoot().getFirstDescendant();
      expect($isAttachmentNode(node) && node.getPresentation()).toEqual({});
    });
  });

  it('blocks source editing when identical references hide different settings', () => {
    const value = content([image({ width: 50 }), image({ width: 75 })]);
    expect(prepareSourceEdit(value as never).canApply).toBe(false);
  });

  it('keeps each image through source editing without showing the settings in Markdown', () => {
    const value = content([image({ width: 50, caption: '第一张' }), image({ alt: '另一张', width: 75 })]);
    const prepared = prepareSourceEdit(value as never);
    expect(prepared.diagnostics).toEqual([]);
    expect(prepared.source).not.toContain('第一张');
    const result = parseSourceEdit(prepared.source, value as never);
    expect(result.diagnostics).toEqual([]);
    expect(attachmentPresentations(result.content!)).toEqual([{ width: 50, caption: '第一张' }, { width: 75 }]);
  });
});

describe('exports', () => {
  it('lists every occurrence in document order', () => {
    const list = attachmentPresentations(content([image(), image({ align: 'right' })]));
    expect(list).toEqual([{}, { align: 'right' }]);
    expect(hasAttachmentPresentation(list)).toBe(true);
    expect(hasAttachmentPresentation([{}, {}])).toBe(false);
  });

  it('shows captions as the paragraph below the image and leaves other pages untouched', () => {
    const plain = content([image()]);
    expect(withCaptionParagraphs(plain)).toBe(plain);
    const text = markdownFromContent(withCaptionParagraphs(content([image({ caption: '图注' })])) as never);
    expect(text).toMatch(/!\[图\]\(nbase-attachment:[^)]+\)\n\n图注\n\n后文/);
  });

  it('restores records on import and removes only the export caption paragraphs', () => {
    const original = content([image({ width: 50, caption: '图注' })]);
    const list = attachmentPresentations(original);
    const exported = withCaptionParagraphs(content([image({ caption: '图注' })]));
    const stripped = structuredClone(exported) as never as { editorState: { root: { children: { children: Record<string, unknown>[] }[] } } };
    delete stripped.editorState.root.children[0]!.children[0]!.caption;
    const restored = restoreAttachmentPresentations(stripped as never, list);
    expect(attachmentPresentations(restored)).toEqual(list);
    expect(markdownFromContent(restored as never).match(/图注/g)).toBeNull();
    expect(markdownFromContent(restored as never)).toContain('后文');
  });

  it('skips restoring when an attachment failed to rebuild', () => {
    const value = content([image()]);
    expect(restoreAttachmentPresentations(value, [{ width: 50 }, { width: 25 }])).toBe(value);
  });

  it('drops hand-edited manifest records', () => {
    expect(readAttachmentPresentations([{ width: 50 }, {}])).toEqual([{ width: 50 }, {}]);
    expect(readAttachmentPresentations([{ width: 5 }])).toBeUndefined();
    expect(readAttachmentPresentations('x')).toBeUndefined();
  });
});
