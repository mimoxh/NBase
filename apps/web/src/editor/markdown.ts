import { $createCodeNode } from '@lexical/code';
import { createEditor } from 'lexical';
import { $isLinkNode } from '@lexical/link';
import {
  $convertFromMarkdownString, $convertToMarkdownString, CHECK_LIST, LINK, TRANSFORMERS,
} from '@lexical/markdown';
import type { ElementTransformer, MultilineElementTransformer, TextMatchTransformer, Transformer } from '@lexical/markdown';
import { $createHorizontalRuleNode, $isHorizontalRuleNode, HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode';
import { $isHeadingNode } from '@lexical/rich-text';
import {
  $createTableCellNode, $createTableNode, $createTableRowNode, $isTableCellNode,
  $isTableNode, $isTableRowNode, TableCellHeaderStates, TableCellNode, TableNode, TableRowNode,
} from '@lexical/table';
import { $createTextNode, $getRoot, $isElementNode } from 'lexical';
import type { LexicalNode, SerializedLexicalNode, SerializedRootNode } from 'lexical';
import { EDITOR_NODES } from './nodes';
import { $createImageReferenceNode, ImageReferenceNode } from './nodes/ImageReferenceNode';
import { AttachmentNode } from './nodes/AttachmentNode';
import type { DocumentContent, EditorSnapshot, MarkdownAssessment, OutlineItem } from './types';

/** Relative paths and explicit web/mail protocols only. Reject control-character scheme obfuscation. */
export function isSafeLinkUrl(url: string): boolean {
  const value = url.trim();
  if (!value || /[\u0000-\u0020\u007f-\u009f\\]/.test(value) || /&(?:#\w+|\w+);/.test(value)) return false;
  if (value.startsWith('//')) return false;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  return scheme ? ['http', 'https', 'mailto'].includes(scheme) : !/^[^/?#]*:/.test(value);
}

const SAFE_LINK: TextMatchTransformer = {
  ...LINK,
  replace(node, match) {
    const replacement = LINK.replace?.(node, match);
    const parent = replacement?.getParent();
    if ($isLinkNode(parent) && !isSafeLinkUrl(parent.getURL())) {
      const literal = $createTextNode(match[0]);
      parent.replace(literal);
      return;
    }
    return replacement;
  },
};

// Intentionally a bounded subset: balanced/nested destinations are left as raw source with a warning.
const IMAGE_PATTERN = /!\[((?:\\.|[^\]\\])*)\]\((?:<[^<>\r\n]*>|(?:\\.|[^\s()\\])*)(?:\s+"(?:\\.|[^"\\])*")?\)/;
const IMAGE: TextMatchTransformer = {
  type: 'text-match', dependencies: [ImageReferenceNode],
  importRegExp: IMAGE_PATTERN, regExp: new RegExp(`${IMAGE_PATTERN.source}$`), trigger: ')',
  export: node => node instanceof ImageReferenceNode ? node.getMarkdown() : null,
  replace(node, match) { node.replace($createImageReferenceNode(match[0], match[1]?.replace(/\\([\[\]\\])/g, '$1') ?? '')); },
};

const ATTACHMENT: TextMatchTransformer = {
  type: 'text-match', dependencies: [AttachmentNode],
  importRegExp: /(?!)x/, regExp: /(?!)x/,
  export: node => node instanceof AttachmentNode ? node.getMarkdown() : null,
  replace: () => {},
};

const HORIZONTAL_RULE: ElementTransformer = {
  type: 'element', dependencies: [HorizontalRuleNode],
  regExp: /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/,
  export: node => $isHorizontalRuleNode(node) ? '---' : null,
  replace(parent) { parent.replace($createHorizontalRuleNode()); },
  triggerOnEnter: true,
};

/** Split only unescaped pipes. GFM requires pipes inside code spans to be escaped too. */
function tableCells(line: string): string[] {
  const trimmed = line.trim();
  const values: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]!;
    if (char === '\\' && i + 1 < trimmed.length) { current += char + trimmed[++i]!; continue; }
    if (char === '|') { values.push(current.trim()); current = ''; }
    else current += char;
  }
  values.push(current.trim());
  if (trimmed.startsWith('|')) values.shift();
  if (trimmed.endsWith('|') && values.at(-1) === '') values.pop();
  return values;
}
function delimiterCells(line: string): string[] | null {
  if (!line.includes('|')) return null;
  const cells = tableCells(line);
  return cells.length && cells.every(cell => /^:?-{3,}:?$/.test(cell)) ? cells : null;
}
function escapeTablePipes(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) { result += text[i]! + text[++i]!; continue; }
    result += text[i] === '|' ? '\\|' : text[i];
  }
  return result;
}

const TABLE: MultilineElementTransformer = {
  type: 'multiline-element', dependencies: [TableNode, TableRowNode, TableCellNode],
  regExpStart: /^.*\|.*$/,
  replace: () => false,
  handleImportAfterStartMatch({ lines, startLineIndex, rootNode }) {
    const header = tableCells(lines[startLineIndex]!);
    const delimiters = delimiterCells(lines[startLineIndex + 1] ?? '');
    if (!delimiters || delimiters.length !== header.length) return null;
    const rows = [header];
    let end = startLineIndex + 1;
    for (let index = end + 1; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line.trim() || !line.includes('|')) break;
      const cells = tableCells(line);
      if (cells.length !== header.length) return null;
      rows.push(cells); end = index;
    }
    const table = $createTableNode();
    rows.forEach((cells, rowIndex) => {
      const row = $createTableRowNode();
      cells.forEach((text, column) => {
        const cell = $createTableCellNode(rowIndex === 0 ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS);
        const alignment = delimiters[column]!;
        if (alignment.startsWith(':') && alignment.endsWith(':')) cell.setFormat('center');
        else if (alignment.endsWith(':')) cell.setFormat('right');
        else if (alignment.startsWith(':')) cell.setFormat('left');
        $convertFromMarkdownString(text.replace(/\\\|/g, '|'), INLINE_TRANSFORMERS, cell);
        row.append(cell);
      });
      table.append(row);
    });
    rootNode.append(table);
    return [true, end];
  },
  export(node, traverseChildren) {
    if (!$isTableNode(node)) return null;
    const rows = node.getChildren().filter($isTableRowNode);
    if (!rows.length) return '';
    const rendered = rows.map(row => `| ${row.getChildren().filter($isTableCellNode).map(cell =>
      escapeTablePipes(traverseChildren(cell)).replace(/\n+/g, ' ')).join(' | ')} |`);
    const delimiters = rows[0]!.getChildren().filter($isTableCellNode).map(cell => {
      const format = cell.getFormatType();
      return format === 'center' ? ':---:' : format === 'right' ? '---:' : format === 'left' ? ':---' : '---';
    });
    rendered.splice(1, 0, `| ${delimiters.join(' | ')} |`);
    return rendered.join('\n');
  },
};

const INLINE_TRANSFORMERS: Transformer[] = [IMAGE, SAFE_LINK, ...TRANSFORMERS.filter(item => item.type === 'text-format')];
export const MARKDOWN_TRANSFORMERS: Transformer[] = [TABLE, HORIZONTAL_RULE, CHECK_LIST, ATTACHMENT, IMAGE, SAFE_LINK, ...TRANSFORMERS.filter(item => item !== LINK && item !== CHECK_LIST)];

/** Exclude fenced examples from feature detection, honoring marker and opening length. */
function proseLines(markdown: string): string[] {
  let fence: { marker: string; length: number } | undefined;
  return markdown.replace(/\r\n?/g, '\n').split('\n').map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1]![0] === fence.marker && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined;
      return '';
    }
    if (match) { fence = { marker: match[1]![0]!, length: match[1]!.length }; return match[1]![0] === '~' ? '~~~' : ''; }
    return line;
  });
}
function unsupportedReasons(markdown: string): string[] {
  const lines = proseLines(markdown);
  const prose = lines.join('\n');
  const reasons: string[] = [];
  if (/^---\s*\n[\s\S]*?\n(?:---|\.\.\.)\s*(?:\n|$)/.test(markdown)) reasons.push('YAML front matter');
  if (/<\/?[a-z][\w:-]*(?:\s|\/?>)|<!--/i.test(prose)) reasons.push('HTML（含合并或嵌套表格）');
  if (/^\s*\[[^\]]+\]:\s*\S/m.test(prose) || /\[[^\]]+\]\[[^\]]*\]/.test(prose)) reasons.push('引用式链接或脚注');
  if (/\[\^[^\]]+\]/.test(prose)) reasons.push('脚注');
  if (/^\s*\$\$|\$[^\s$][^\n$]*\$|\\\([^\n]+\\\)|^\s*\\\[\s*$/m.test(prose)) reasons.push('数学公式');
  if (/^\s*(?:~~~|:::)\s*$/m.test(prose)) reasons.push('波浪号围栏或自定义容器');
  if (/^\S[^\n]*\n(?:={3,}|-{3,})\s*$/m.test(prose)) reasons.push('Setext 标题');
    if (/\[\[[^\]]+\]\]/.test(prose)) reasons.push('双链');
  if (/!\[/.test(prose.replace(new RegExp(IMAGE_PATTERN.source, 'g'), ''))) reasons.push('复杂或不完整的图片引用');
  for (let index = 1; index < lines.length; index++) {
    const delimiters = delimiterCells(lines[index]!);
    if (!delimiters) continue;
    if (tableCells(lines[index - 1]!).length !== delimiters.length) { reasons.push('列数不一致的表格'); break; }
    for (let row = index + 1; row < lines.length && lines[row]!.trim() && lines[row]!.includes('|'); row++) {
      if (tableCells(lines[row]!).length !== delimiters.length) { reasons.push('列数不一致的表格'); break; }
    }
  }
  return [...new Set(reasons)];
}

export function assessMarkdown(markdown: string): MarkdownAssessment {
  const warnings = unsupportedReasons(markdown).map(reason => `检测到${reason}：此文档将以 Markdown 代码原文保留，请保留原始文件。`);
  const prose = proseLines(markdown).join('\n');
  if (/!\[/.test(prose)) warnings.push('图片仅保留引用并显示未加载占位，不会请求远程图片；复杂图片语法可能保持文本。');
  if (/\]\(\s*(?:javascript|data|vbscript|file):/i.test(prose)) warnings.push('危险协议链接将保留为不可点击的文字。');
  return { warnings };
}

/** Unsupported document dialects are kept wholly as a Markdown code block, never partially erased. */
export function createContentFromMarkdown(markdown: string): DocumentContent {
  const editor = createEditor({ namespace: 'nbase-markdown', nodes: EDITOR_NODES, onError: error => { throw error; } });
  editor.update(() => {
    if (unsupportedReasons(markdown).length) {
      $getRoot().clear().append($createCodeNode('markdown').append($createTextNode(markdown)));
    } else {
      $convertFromMarkdownString(markdown, MARKDOWN_TRANSFORMERS);
    }
  }, { discrete: true });
  return { schemaVersion: 1, editorState: editor.getEditorState().toJSON() };
}

function serializeNode(node: LexicalNode): SerializedLexicalNode {
  const serialized = node.exportJSON();
  return $isElementNode(node) ? { ...serialized, children: node.getChildren().map(serializeNode) } as SerializedLexicalNode : serialized;
}

/** Call inside an EditorState.read callback. Heading ids are view-only anchors and never persisted IDs. */
export function $collectOutline(): OutlineItem[] {
  const outline: OutlineItem[] = [];
  const visit = (node: LexicalNode): void => {
    if ($isHeadingNode(node)) outline.push({ id: `heading-${node.getKey()}`, text: node.getTextContent(), level: Number(node.getTag().slice(1)) });
    if ($isElementNode(node)) node.getChildren().forEach(visit);
  };
  visit($getRoot());
  return outline;
}

/** Call inside an EditorState.read callback. Anchors are view-only and never persisted IDs. */
export function $createSnapshot(): EditorSnapshot {
  return {
    content: { schemaVersion: 1, editorState: { root: serializeNode($getRoot()) as SerializedRootNode } },
    markdown: $convertToMarkdownString(MARKDOWN_TRANSFORMERS),
    plainText: $getRoot().getTextContent(), outline: $collectOutline(),
  };
}





