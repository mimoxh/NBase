import { $createCodeNode } from '@lexical/code';
import { createEditor } from 'lexical';
import { $isLinkNode } from '@lexical/link';
import {
  $convertFromMarkdownString, $convertToMarkdownString, CHECK_LIST, CODE, LINK, TRANSFORMERS,
} from '@lexical/markdown';
import type { ElementTransformer, MultilineElementTransformer, TextMatchTransformer, Transformer } from '@lexical/markdown';
import { $createHorizontalRuleNode, $isHorizontalRuleNode, HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode';
import { $isHeadingNode } from '@lexical/rich-text';
import {
  $createTableCellNode, $createTableNode, $createTableRowNode, $isTableCellNode,
  $isTableNode, $isTableRowNode, TableCellHeaderStates, TableCellNode, TableNode, TableRowNode,
} from '@lexical/table';
import { $createTextNode, $getRoot, $isElementNode, $isTextNode } from 'lexical';
import type { LexicalNode, SerializedLexicalNode, SerializedRootNode } from 'lexical';
import { EDITOR_NODES } from './nodes';
import { $createImageReferenceNode, ImageReferenceNode } from './nodes/ImageReferenceNode';
import { AttachmentNode } from './nodes/AttachmentNode';
import { $createEquationNode, $isEquationNode, $requestEquationEdit, EquationNode } from './nodes/EquationNode';
import { normalizeCodeBlockLanguage } from './codeLanguages';
import { normalizeDocumentContent } from './normalize';
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

/** RegExpMatchArray is a real array plus index/input; copy it so the captured language can be rewritten. */
function withCodeLanguage(match: RegExpMatchArray): RegExpMatchArray {
  const normalized = normalizeCodeBlockLanguage(match[2]);
  if (normalized === match[2]) return match;
  const copy = match.slice() as RegExpMatchArray;
  if (match.index !== undefined) copy.index = match.index;
  if (match.input !== undefined) copy.input = match.input;
  if (match.groups !== undefined) copy.groups = match.groups;
  copy[2] = normalized ?? '';
  return copy;
}

/** Fenced-code language aliases resolve to selector values; unknown names persist and export verbatim. */
const CODE_ALIASED: MultilineElementTransformer = {
  ...CODE,
  handleImportAfterStartMatch: args => CODE.handleImportAfterStartMatch?.({ ...args, startMatch: withCodeLanguage(args.startMatch) }) ?? null,
  replace: (rootNode, children, startMatch, endMatch, linesInBetween, isImport) => {
    const normalized = normalizeCodeBlockLanguage(startMatch[2]);
    const match = normalized === startMatch[2] ? startMatch : [...startMatch.slice(0, 2), normalized ?? '', ...startMatch.slice(3)];
    return CODE.replace(rootNode, children, match, endMatch, linesInBetween, isImport);
  },
};

// Inline math: `$src$` — non-space at both edges, no unescaped `$` or newline
// inside, opening `$` not escaped or doubled, closing `$` not before a digit.
const MATH_CHAR = String.raw`(?:\\.|[^\s$\\])`;
const MATH_INNER = String.raw`(?:\\.|[^$\\\n])*`;
const INLINE_MATH = String.raw`(?<![\\$])\$(${MATH_CHAR}(?:${MATH_INNER}${MATH_CHAR})?)\$(?!\d)`;

const EQUATION_INLINE: TextMatchTransformer = {
  type: 'text-match', dependencies: [EquationNode],
  importRegExp: new RegExp(INLINE_MATH), regExp: new RegExp(`${INLINE_MATH}$`), trigger: '$',
  export: node => $isEquationNode(node) && node.isInline() ? `$${node.getEquation().replace(/\n+/g, ' ')}$` : null,
  replace(node, match) { node.replace($createEquationNode(match[1] ?? '', true)); },
};

const EQUATION_BLOCK: MultilineElementTransformer = {
  type: 'multiline-element', dependencies: [EquationNode],
  regExpStart: /^\s*\$\$/,
  // Imports are consumed by handleImportAfterStartMatch, and the typed
  // `$$`+Enter shortcut is handled in EquationPlugin — this transformer only
  // matches fenced blocks on import, so replace always declines here.
  replace: () => false,
  handleImportAfterStartMatch({ lines, rootNode, startLineIndex }) {
    const line = lines[startLineIndex]!;
    const single = /^\s*\$\$([\s\S]*)\$\$\s*$/.exec(line);
    if (single) {
      rootNode.append($createEquationNode(single[1] ?? '', false));
      return [true, startLineIndex];
    }
    if (!/^\s*\$\$\s*$/.test(line)) return null;
    const content: string[] = [];
    for (let index = startLineIndex + 1; index < lines.length; index++) {
      if (/^\s*\$\$\s*$/.test(lines[index]!)) {
        rootNode.append($createEquationNode(content.join('\n'), false));
        return [true, index];
      }
      content.push(lines[index]!);
    }
    return null;
  },
  export(node) {
    return $isEquationNode(node) && !node.isInline() ? `$$\n${node.getEquation()}\n$$` : null;
  },
};

// Plain text `$` must round-trip as a literal: export escapes it to `\$`, and
// the importer's unescapeText turns `\$` back into `$`. A private-use sentinel
// carries the `$` through format escaping so it stays a literal on the way out.
const DOLLAR_SENTINEL = '';
const DOLLAR_ESCAPE: TextMatchTransformer = {
  type: 'text-match', dependencies: [],
  importRegExp: /(?!)x/, regExp: /(?!)x/,
  export: (node, _children, exportFormat) => {
    if (!$isTextNode(node) || node.hasFormat('code')) return null;
    const text = node.getTextContent();
    if (!text.includes('$') || text.includes(DOLLAR_SENTINEL)) return null;
    return exportFormat(node, text.replace(/\$/g, DOLLAR_SENTINEL));
  },
  replace: () => {},
};

/** Sentinels left by DOLLAR_ESCAPE become literal `\$` escapes in Markdown output. */
function restoreDollarEscapes(markdown: string): string {
  return markdown.replaceAll(DOLLAR_SENTINEL, '\\$');
}

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

const INLINE_TRANSFORMERS: Transformer[] = [IMAGE, SAFE_LINK, EQUATION_INLINE, ...TRANSFORMERS.filter(item => item.type === 'text-format')];
export const MARKDOWN_TRANSFORMERS: Transformer[] = [
  EQUATION_BLOCK, TABLE, HORIZONTAL_RULE, CHECK_LIST,
  ATTACHMENT, IMAGE, SAFE_LINK, EQUATION_INLINE, DOLLAR_ESCAPE,
  CODE_ALIASED, ...TRANSFORMERS.filter(item => item !== LINK && item !== CHECK_LIST && item !== CODE),
];

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
  if (/(?<!\\)\\\(|^\s*(?<!\\)\\\[/m.test(prose)) reasons.push('数学公式（\\( \\) 或 \\[ \\] 语法）');
  if (lines.filter(line => /^\s*\$\$\s*$/.test(line)).length % 2) reasons.push('未闭合的公式块');
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
    content: normalizeDocumentContent({ schemaVersion: 1, editorState: { root: serializeNode($getRoot()) as SerializedRootNode } }),
    markdown: restoreDollarEscapes($convertToMarkdownString(MARKDOWN_TRANSFORMERS)),
    plainText: $getRoot().getTextContent(), outline: $collectOutline(),
  };
}





