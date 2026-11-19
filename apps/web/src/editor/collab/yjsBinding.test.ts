// @vitest-environment jsdom
import { $dfs } from '@lexical/utils';
import { createYjsBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Binding, type Provider } from '@lexical/yjs';
import { $createParagraphNode, $createTextNode, $getRoot, $parseSerializedNode, createEditor, type LexicalEditor, type ParagraphNode, type SerializedLexicalNode } from 'lexical';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import callout from '../../../../../docs/fixtures/markdown/callout-highlight.md?raw';
import common from '../../../../../docs/fixtures/markdown/common.md?raw';
import mermaid from '../../../../../docs/fixtures/markdown/mermaid.md?raw';
import mixed from '../../../../../docs/fixtures/markdown/notes-mixed.md?raw';
import table from '../../../../../docs/fixtures/markdown/table.md?raw';
import { $blockIdOf, $ensureBlockId } from '../blockAnchors';
import { parseMarkdownImport } from '../markdown';
import { $createAttachmentNode, $isAttachmentNode } from '../nodes/AttachmentNode';
import { $createBlockReferenceNode } from '../nodes/BlockReferenceNode';
import { $createBookmarkNode } from '../nodes/BookmarkNode';
import { $createDatabaseViewNode } from '../nodes/DatabaseViewNode';
import { $createImageReferenceNode } from '../nodes/ImageReferenceNode';
import { $createToggleNode } from '../nodes/ToggleNode';
import { EDITOR_NODES } from '../nodes';

const pageId = '0a1b2c3d-0000-4000-8000-000000000001';
const extra = [
  `页面 [另一页](/?page=${pageId}) 与白板：`,
  '',
  `[白板](/?page=${pageId}#nbase-whiteboard-view=400)`,
].join('\n');

const awareness = { getLocalState: () => null, getStates: () => new Map(), on() {}, off() {}, setLocalState() {}, setLocalStateField() {} };
const provider = { awareness, connect() {}, disconnect() {}, on() {}, off() {} } as unknown as Provider;

function peer(doc: Y.Doc): { editor: LexicalEditor; binding: Binding } {
  const editor = createEditor({ nodes: EDITOR_NODES, onError: error => { throw error; } });
  editor.setRootElement(document.createElement('div'));
  const binding = createYjsBinding({ editor, id: 'root', doc, docMap: new Map([['root', doc]]) });
  editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    if (tags.has('skip-collab') === false) {
      syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
    }
  });
  binding.root.getSharedType().observeDeep((events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events, false);
  });
  return { editor, binding };
}

function types(node: SerializedLexicalNode, into = new Set<string>()): Set<string> {
  into.add(node.type);
  for (const child of (node as { children?: SerializedLexicalNode[] }).children ?? []) types(child, into);
  return into;
}

it('carries every document node through Yjs and back unchanged', async () => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  docA.on('update', (update: Uint8Array) => Y.applyUpdate(docB, update, 'remote'));
  const a = peer(docA);
  const b = peer(docB);
  const sources = [common, table, mermaid, mixed, callout, extra];
  const children = sources.flatMap(source => parseMarkdownImport(source).content.editorState.root.children);
  const seen = new Set<string>();
  for (const child of children) types(child as SerializedLexicalNode, seen);
  a.editor.update(() => {
    const root = $getRoot();
    root.clear();
    for (const child of children) root.append($parseSerializedNode(child as SerializedLexicalNode) as never);
  }, { discrete: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect([...seen]).toEqual(expect.arrayContaining(['callout', 'equation', 'footnote-definition', 'footnote-reference', 'mermaid',
    'page-reference', 'table', 'whiteboard-view']));
  expect(b.editor.getEditorState().toJSON()).toEqual(a.editor.getEditorState().toJSON());
});

it('syncs the remaining custom nodes, block anchors, property edits and concurrent typing', async () => {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const a = peer(docA);
  const b = peer(docB);
  let paused = false;
  const queuedAB: Uint8Array[] = [];
  const queuedBA: Uint8Array[] = [];
  docA.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== 'remote') (paused ? queuedAB.push(update) : Y.applyUpdate(docB, update, 'remote')); });
  docB.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== 'remote') (paused ? queuedBA.push(update) : Y.applyUpdate(docA, update, 'remote')); });
  const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
  a.editor.update(() => {
    const root = $getRoot();
    root.clear();
    const first = $createParagraphNode().append($createTextNode('第一段'));
    $ensureBlockId(first);
    const refs = $createParagraphNode().append($createBlockReferenceNode(pageId, 'abcdefgh12345678', '引用'),
      $createTextNode(' '), $createImageReferenceNode('![图](https://example.com/a.png)', '图'));
    const toggle = $createToggleNode().append($createParagraphNode().append($createTextNode('摘要')),
      $createParagraphNode().append($createTextNode('内容')));
    root.append(first, refs, toggle,
      $createAttachmentNode('0a1b2c3d-0000-4000-8000-000000000002', '图', 'a.png', 'image/png', { width: 320, align: 'center' }),
      $createBookmarkNode({ url: 'https://example.com/', title: '示例', description: '说明', siteName: 'Example' }),
      $createDatabaseViewNode('0a1b2c3d-0000-4000-8000-000000000003', null),
      $createParagraphNode().append($createTextNode('末段')));
  }, { discrete: true });
  await flush();
  const json = (peerState: { editor: LexicalEditor }) => peerState.editor.getEditorState().toJSON();
  expect(json(b)).toEqual(json(a));
  expect(JSON.stringify(json(b))).toContain('abcdefgh12345678');
  const blockIdOf = (editor: LexicalEditor) => editor.read(() => $blockIdOf($getRoot().getFirstChildOrThrow()));
  expect(blockIdOf(b.editor)).toBe(blockIdOf(a.editor));
  expect(blockIdOf(b.editor)).toBeTruthy();

  a.editor.update(() => {
    const attachment = $dfs().map(entry => entry.node).find($isAttachmentNode)!;
    attachment.setPresentation({ width: 480, align: 'right' });
  }, { discrete: true });
  await flush();
  expect(json(b)).toEqual(json(a));
  expect(JSON.stringify(json(b))).toContain('"width":480');

  // Offline on both sides: each edits a different paragraph, then the updates cross.
  paused = true;
  a.editor.update(() => { ($getRoot().getFirstChildOrThrow() as ParagraphNode).append($createTextNode('甲补充')); }, { discrete: true });
  b.editor.update(() => { ($getRoot().getLastChildOrThrow() as ParagraphNode).append($createTextNode('乙补充')); }, { discrete: true });
  await flush();
  paused = false;
  for (const update of queuedAB.splice(0)) Y.applyUpdate(docB, update, 'remote');
  for (const update of queuedBA.splice(0)) Y.applyUpdate(docA, update, 'remote');
  await flush();
  expect(json(b)).toEqual(json(a));
  const text = a.editor.read(() => $getRoot().getTextContent());
  expect(text).toContain('第一段甲补充');
  expect(text).toContain('末段乙补充');
});
