// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { $getRoot, createEditor } from 'lexical';
import { isStoredMermaidSource } from '@nbase/contracts';
import { $createSnapshot, assessMarkdown, createContentFromMarkdown } from './markdown';
import { EDITOR_NODES } from './nodes';
import { $createMermaidNode, $isMermaidNode } from './nodes/MermaidNode';
import { defaultMermaidSource, fencedMermaidSource, mermaidSourceProblem } from './mermaidSource';

function snapshot(markdown: string) {
  const content = createContentFromMarkdown(markdown);
  const editor = createEditor({ namespace: 'mermaid-roundtrip', nodes: EDITOR_NODES, onError: error => { throw error; } });
  editor.setEditorState(editor.parseEditorState(content.editorState));
  return { editor, value: editor.read('latest', $createSnapshot) };
}

describe('Mermaid Markdown and JSON', () => {
  it.each([
    defaultMermaidSource,
    '\nsequenceDiagram\n  participant 用户\n  用户->>服务: 请求 == $x$ [[页面]]\n  服务-->>用户: 完成\n',
    'flowchart LR\n  A["反引号 ``` 与 \\\\ 路径"] --> B[完成]',
    '',
    '%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\n  A --> B\n  click A "https://outside.invalid"',
    'unrecognized original source\n' + '字'.repeat(13_000),
  ])('preserves every source character through fenced Markdown and reopening %#', source => {
    const markdown = fencedMermaidSource(source);
    expect(assessMarkdown(markdown).warnings).toEqual([]);
    const first = snapshot(markdown);
    first.editor.read('latest', () => {
      const node = $getRoot().getFirstChild();
      expect($isMermaidNode(node)).toBe(true);
      expect(node?.getTextContent()).toBe(source);
    });
    expect(first.value.markdown).toBe(markdown);
    const second = snapshot(first.value.markdown);
    expect(second.value.content).toEqual(first.value.content);
    expect(second.value.plainText).toContain(source);
  });

  it('exports a fence longer than embedded backticks and preserves adjacent formatted content', () => {
    const first = snapshot('前 **重点**\n\n````mermaid\nflowchart TD\n  A["```"] --> B[完成]\n````\n\n后 ==高亮==');
    expect(first.value.markdown).toContain('````mermaid\nflowchart TD\n  A["```"] --> B[完成]\n````');
    expect(snapshot(first.value.markdown).value.content).toEqual(first.value.content);
  });

  it('treats other code languages as code and leaves unclosed Mermaid fences recoverable', () => {
    expect(snapshot('```text\nflowchart TD\nA --> B\n```').editor.read('latest', () => $getRoot().getFirstChild()?.getType())).toBe('code');
    const unclosed = snapshot('```mermaid\nflowchart TD\nA --> B');
    expect(unclosed.value.plainText).toContain('A --> B');
  });

  it('creates a plain-text HTML copy without including active source markup', () => {
    const editor = createEditor({ namespace: 'mermaid-copy', nodes: EDITOR_NODES, onError: error => { throw error; } });
    editor.update(() => {
      const source = 'flowchart LR\n A["<script>alert(1)</script>"]';
      const node = $createMermaidNode(source);
      $getRoot().append(node);
      const exported = node.exportDOM();
      expect((exported.element as HTMLElement).textContent).toBe(source);
      expect((exported.element as HTMLElement).querySelector('script')).toBeNull();
    }, { discrete: true });
  });
});

describe('Mermaid rendering input bounds', () => {
  it.each([
    'graph LR\n A[甲] --> B[乙]',
    'sequenceDiagram\n 用户->>服务: 请求\n 服务-->>用户: 完成',
    '%% regular comment\nflowchart TD\n A --> B',
  ])('allows basic diagrams %#', source => expect(mermaidSourceProblem(source)).toBeNull());

  it.each([
    '',
    'pie\n "A": 10',
    '---\nconfig:\n  securityLevel: loose\n---\nflowchart TD\n A --> B',
    '%%{ init: {"securityLevel": "loose"}}%%\nflowchart TD\n A --> B',
    'flowchart TD\n A@{img: "https://outside.invalid/pic"}',
    'flowchart TD\n A["<img src=//outside.invalid/pic>"]',
    'flowchart TD\n A --> B\n click A "javascript:alert(1)"',
    'flowchart TD\n A --> B;click A "https://outside.invalid"',
    'sequenceDiagram\n participant 用户\n link 用户: 文档 @ http://outside.invalid',
    'flowchart TD\n A --> B\n classDef bad fill:url(//outside.invalid/pic)',
    'flowchart TD\n A["' + '字'.repeat(5_000) + '"]',
    'flowchart TD\n' + 'A --> B\n'.repeat(81),
    'flowchart TD\n' + 'A\n'.repeat(128),
  ])('returns a diagnostic before a restricted source reaches the renderer %#', source => {
    expect(mermaidSourceProblem(source)).toBeTruthy();
    expect(isStoredMermaidSource(source)).toBe(true);
  });

  it('requires valid text for persistence while accepting emoji and rendering failures', () => {
    for (const input of [null, 1, {}, 'bad\u0000', '\ud800', 'x'.repeat(1024 * 1024 + 1)]) {
      expect(isStoredMermaidSource(input)).toBe(false);
    }
    expect(isStoredMermaidSource('flowchart LR\n A[🎉]')).toBe(true);
  });
});
