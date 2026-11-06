import { $createCodeNode } from '@lexical/code';
import { isCalloutKind, isCalloutTitle, isMarkdownFrontMatter, markdownFrontMatterKey, pageIdFromReferenceUrl, pageReferenceUrl } from '@nbase/contracts';
import { createEditor, createState, $setState } from 'lexical';
import type { EditorState } from 'lexical';
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
import { $createTextNode, $findMatchingParent, $getRoot, $isElementNode, $isTextNode } from 'lexical';
import type { LexicalNode, SerializedLexicalNode, SerializedRootNode } from 'lexical';
import { EDITOR_NODES } from './nodes';
import { $createImageReferenceNode, ImageReferenceNode } from './nodes/ImageReferenceNode';
import { AttachmentNode } from './nodes/AttachmentNode';
import { $createEquationNode, $isEquationNode, $requestEquationEdit, EquationNode } from './nodes/EquationNode';
import { $createCalloutNode, $isCalloutNode, CalloutNode } from './nodes/CalloutNode';
import { $createPageReferenceNode, $isPageReferenceNode, isPageReferenceLabel, PageReferenceNode } from './nodes/PageReferenceNode';
import {
  $createFootnoteDefinitionNode, $createFootnoteReferenceNode, $isFootnoteDefinitionNode, $isFootnoteReferenceNode,
  FootnoteDefinitionNode, FootnoteReferenceNode,
} from './nodes/FootnoteNodes';
import { legacyPageReferencePattern } from './legacyPageReferences';
import { readMarkdownFrontMatter } from './markdownFrontMatter';
import { maskMarkdownInlineLiterals, resolveMarkdownReferences } from './markdownReferences';
import { normalizeCodeBlockLanguage } from './codeLanguages';
import { MERMAID_TRANSFORMER } from './mermaidMarkdown';
import { normalizeDocumentContent } from './normalize';
import type { DocumentContent, EditorSnapshot, MarkdownAssessment, OutlineItem } from './types';

export { addMarkdownFrontMatter, getMarkdownFrontMatter, readMarkdownFrontMatter } from './markdownFrontMatter';

const frontMatterState = createState(markdownFrontMatterKey, { parse: value => isMarkdownFrontMatter(value) ? value : null });

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
    if ($isLinkNode(parent)) {
      const raw = parent.getURL();
      const relativeAngle = match[2] !== undefined && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw.trim());
      const url = relativeAngle ? raw.replace(/ /g, '%20') : raw;
      if (!isSafeLinkUrl(url)) {
        parent.replace($createTextNode(match[0]));
        return;
      }
      if (url !== raw) parent.setURL(url);
    }
    return replacement;
  },
};

const PAGE_REFERENCE_PATTERN = /(?<!(?<!\\)(?:\\\\)*\\)\[((?:\\.|[^[\]\\\r\n]){1,510})\]\((\/\?page=[0-9a-f-]{36})\)/iu;
const PAGE_REFERENCE: TextMatchTransformer = {
  type: 'text-match', dependencies: [PageReferenceNode],
  importRegExp: PAGE_REFERENCE_PATTERN, regExp: /(?!)x/,
  export(node) {
    if (!$isPageReferenceNode(node)) return null;
    const label = node.getTextContent().replace(/[\\[\]`*_~=$<>!&]/g, '\\$&');
    return '[' + label + '](' + pageReferenceUrl(node.getTargetPageId()) + ')';
  },
  replace(node, match) {
    if ($findMatchingParent(node, $isLinkNode)) return;
    const target = pageIdFromReferenceUrl(match[2]!);
    const label = match[1]!.replace(/\\([!-/:-@[-`{-~])/g, '$1');
    if (target && isPageReferenceLabel(label)) node.replace($createPageReferenceNode(target, label));
  },
};

const LITERAL_LEGACY_REFERENCE: TextMatchTransformer = {
  type: 'text-match', dependencies: [],
  importRegExp: legacyPageReferencePattern, regExp: /(?!)x/,
  replace(node, match) { node.replace($createTextNode(match[0]).setFormat(node.getFormat())); },
};

const FOOTNOTE_REFERENCE: TextMatchTransformer = {
  type: 'text-match', dependencies: [FootnoteReferenceNode],
  importRegExp: /(?<!(?<!\\)(?:\\\\)*\\)\[\^([\p{L}\p{N}._-]{1,64})\]/u, regExp: /(?!)x/,
  export: node => $isFootnoteReferenceNode(node) ? node.getTextContent() : null,
  replace(node, match) {
    if (!$findMatchingParent(node, $isLinkNode)) node.replace($createFootnoteReferenceNode(match[1]!));
  },
};

const FOOTNOTE_DEFINITION: ElementTransformer = {
  type: 'element', dependencies: [FootnoteDefinitionNode], regExp: /(?!)x/,
  replace: () => false,
  export(node) {
    if (!$isFootnoteDefinitionNode(node)) return null;
    const [first, ...rest] = $convertToMarkdownString(MARKDOWN_TRANSFORMERS, node).split('\n');
    const header = '[^' + node.getFootnoteId() + ']:' + (first ? ' ' + first : '');
    return [header, ...rest.map(line => line ? '    ' + line : '')].join('\n');
  },
};

// Match a complete span before Lexical's generic unescape pass, which also
// runs on native code spans. The opening run must not be escaped, and the
// closing run must have the same length. Backslashes inside are literal.
const LITERAL_INLINE_CODE: TextMatchTransformer = {
  type: 'text-match', dependencies: [],
  importRegExp: /(?=`)(?<!(?<!\\)(?:\\\\)*\\)(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/,
  regExp: /(?!)x/,
  replace(node, match) {
    const raw = match[2] ?? '';
    const text = raw.startsWith(' ') && raw.endsWith(' ') && /[^ ]/.test(raw) ? raw.slice(1, -1) : raw;
    return node.replace($createTextNode(text).setFormat(node.getFormat()).toggleFormat('code'));
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

// Escape literal delimiter characters before Lexical wraps the formatted span.
// Lexical doubles backslashes, so remove the extra backslash it adds to each
// of our new escapes. An original backslash remains independently escaped.
const DELIMITER_ESCAPE: TextMatchTransformer = {
  type: 'text-match', dependencies: [],
  importRegExp: /(?!)x/, regExp: /(?!)x/,
  export: (node, _children, exportFormat) => {
    if (!$isTextNode(node) || node.hasFormat('code')) return null;
    const text = node.getTextContent();
    if (!/[=$]|\[\^/.test(text)) return null;
    return exportFormat(node, text.replace(/[=$]|\[(?=\^)/g, '\\$&')).replace(/\\\\(?=[=$]|\[\^)/g, '\\');
  },
  replace: () => {},
};

const CALLOUT_HEADER = /^ {0,3}>[ \t]?\[!(NOTE|WARNING|IMPORTANT)\](?:[ \t]+(.*))?$/;
const CALLOUT_BODY_LINE = /^ {0,3}>[ \t]?/;
function createCalloutTransformer(transformers: () => Transformer[]): MultilineElementTransformer {
const callout: MultilineElementTransformer = {
  type: 'multiline-element', dependencies: [CalloutNode],
  regExpStart: CALLOUT_HEADER,
  replace: () => false,
  handleImportAfterStartMatch({ lines, rootNode, startLineIndex, startMatch }) {
    const kind = startMatch[1];
    const title = startMatch[2]?.trim() ?? '';
    if (!isCalloutKind(kind) || !isCalloutTitle(title)) return null;
    const body: string[] = [];
    let end = startLineIndex;
    while (end + 1 < lines.length && CALLOUT_BODY_LINE.test(lines[end + 1]!)) {
      body.push(lines[++end]!.replace(CALLOUT_BODY_LINE, ''));
    }
    const node = $createCalloutNode(kind, title);
    rootNode.append(node);
    $convertFromMarkdownString(body.join('\n'), transformers().filter(item => item !== callout), node);
    return [true, end];
  },
  export(node) {
    if (!$isCalloutNode(node)) return null;
    const title = node.getTitle();
    const heading = `> [!${node.getKind()}]${title ? ` ${title}` : ''}`;
    const body = $convertToMarkdownString(transformers(), node);
    return body ? `${heading}\n${body.split('\n').map(line => line ? `> ${line}` : '>').join('\n')}` : heading;
  },
};

return callout;
}
const CALLOUT = createCalloutTransformer(() => MARKDOWN_TRANSFORMERS);

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

function createTableTransformer(inlineTransformers: () => Transformer[]): MultilineElementTransformer {
return {
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
        $convertFromMarkdownString(text.replace(/\\\|/g, '|'), inlineTransformers(), cell);
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

}
const TABLE = createTableTransformer(() => INLINE_TRANSFORMERS);

const INLINE_TRANSFORMERS: Transformer[] = [IMAGE, PAGE_REFERENCE, LITERAL_LEGACY_REFERENCE, SAFE_LINK, FOOTNOTE_REFERENCE, EQUATION_INLINE, LITERAL_INLINE_CODE,
  ...TRANSFORMERS.filter(item => item.type === 'text-format')];
export const MARKDOWN_TRANSFORMERS: Transformer[] = [
  CALLOUT, EQUATION_BLOCK, TABLE, HORIZONTAL_RULE, CHECK_LIST, FOOTNOTE_DEFINITION,
  ATTACHMENT, IMAGE, PAGE_REFERENCE, LITERAL_LEGACY_REFERENCE, SAFE_LINK, FOOTNOTE_REFERENCE, EQUATION_INLINE, LITERAL_INLINE_CODE, DELIMITER_ESCAPE,
  MERMAID_TRANSFORMER, CODE_ALIASED, ...TRANSFORMERS.filter(item => item !== LINK && item !== CHECK_LIST && item !== CODE),
];

/** Extra transformers also participate inside callouts and table cells. */
export function withMarkdownTransformers(extra: Transformer[]): Transformer[] {
  const transformers: Transformer[] = [];
  const callout = createCalloutTransformer(() => transformers);
  const table = createTableTransformer(() => transformers.filter(item => item.type === 'text-format' || item.type === 'text-match'));
  transformers.push(...extra, ...MARKDOWN_TRANSFORMERS.map(item => item === CALLOUT ? callout : item === TABLE ? table : item));
  return transformers;
}

/** Exclude fenced examples from feature detection, honoring marker and opening length. */
function proseLines(markdown: string): { lines: string[]; invalidCalloutTitle: boolean } {
  let fence: { marker: string; length: number } | undefined;
  let callout = false;
  let invalidCalloutTitle = false;
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n').map(line => {
    if (callout) {
      if (CALLOUT_BODY_LINE.test(line)) line = line.replace(CALLOUT_BODY_LINE, '');
      else { callout = false; fence = undefined; }
    }
    if (!callout && !fence) {
      const header = CALLOUT_HEADER.exec(line);
      if (header) {
        callout = true;
        if (!isCalloutTitle(header[2]?.trim() ?? '')) invalidCalloutTitle = true;
        return '';
      }
    }
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1]![0] === fence.marker && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined;
      return '';
    }
    if (match) { fence = { marker: match[1]![0]!, length: match[1]!.length }; return match[1]![0] === '~' ? '~~~' : ''; }
    return line;
  });
  return { lines, invalidCalloutTitle };
}
function unsupportedReasons(markdown: string): string[] {
  const { lines, invalidCalloutTitle } = proseLines(markdown);
  const masked = lines.map(maskMarkdownInlineLiterals).join('\n');
  const prose = masked
    .replace(new RegExp(PAGE_REFERENCE_PATTERN.source, 'giu'), '链接')
    .replace(new RegExp(legacyPageReferencePattern.source, 'gu'), '引用')
    .replace(/\]\([ \t]*<[^<>\r\n]*>/g, '](地址');
  const reasons: string[] = [];
  if (invalidCalloutTitle) reasons.push('提示块标题过长或含控制字符');
  if (/<\/?[a-z][\w:-]*(?:\s|\/?>)|<!--/i.test(prose)) reasons.push('HTML（含合并或嵌套表格）');
  if (/^(?:\s*>)*\s*\[[^\]]+\]:\s*\S/m.test(prose) || /(?<!\\)\[[^\]]+\]\[(?!\^)[^\]]*\]/.test(prose)) reasons.push('不受支持的引用式链接或脚注');
  if (/(?<!\\)\\\(|^[ \t]*(?<!\\)\\\[(?:[ \t]*$|[^\n]*\\\])/m.test(prose)) reasons.push('数学公式（\\( \\) 或 \\[ \\] 语法）');
  if (lines.filter(line => /^\s*\$\$\s*$/.test(line)).length % 2) reasons.push('未闭合的公式块');
  if (/^\s*(?:~~~|:::)\s*$/m.test(prose)) reasons.push('波浪号围栏或自定义容器');
  if (/^\S[^\n]*\n(?:={3,}|-{3,})\s*$/m.test(prose)) reasons.push('Setext 标题');
  if (/(?<!\\)!\[/.test(masked.replace(new RegExp(IMAGE_PATTERN.source, 'g'), ''))) reasons.push('复杂或不完整的图片引用');
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

function analyzeMarkdown(markdown: string, footnoteSlot?: (id: string) => string) {
  const header = readMarkdownFrontMatter(markdown);
  const document = resolveMarkdownReferences(header.body, footnoteSlot);
  const sections = [document.body, ...document.footnotes.map(note => note.markdown)];
  const reasons = [...new Set([...document.warnings, ...sections.flatMap(unsupportedReasons)])];
  const preservedAsSource = header.preservedAsSource || reasons.length > 0;
  const warnings = [...header.warnings, ...reasons.map(reason => '检测到' + reason + '，此文档将以 Markdown 代码原文保留。')];
  const prose = sections.flatMap(section => proseLines(section).lines.map(maskMarkdownInlineLiterals)).join('\n');
  if (/!\[/.test(prose)) warnings.push('图片仅保留引用并显示未加载占位，不会请求远程图片；复杂图片语法可能保持文本。');
  if (/\]\(\s*<?(?:javascript|data|vbscript|file):/i.test(prose)) warnings.push('危险协议链接将保留为不可点击的文字。');
  return { header, document, warnings, preservedAsSource };
}

export function assessMarkdown(markdown: string): MarkdownAssessment {
  const { warnings } = analyzeMarkdown(markdown);
  return { warnings };
}

export interface MarkdownImportResult {
  content: DocumentContent;
  title?: string;
  tagNames: string[];
  warnings: string[];
  preservedAsSource: boolean;
}

/** Unsupported document dialects are kept wholly as a Markdown code block, never partially erased. */
export function parseMarkdownImport(markdown: string, transformers = MARKDOWN_TRANSFORMERS,
  options: { preserveFootnotePosition?: boolean } = {}): MarkdownImportResult {
  const preserveFootnotePosition = options.preserveFootnotePosition !== false;
  const slots = new Map<string, string>();
  const prefix = '\ue000NBASE_FOOTNOTE_' + crypto.randomUUID() + '_';
  const { header, document, warnings, preservedAsSource } = analyzeMarkdown(markdown,
    preserveFootnotePosition ? id => {
      let token = prefix + slots.size + '\ue001';
      while (markdown.includes(token)) token += '_';
      slots.set(token, id);
      return token;
    } : undefined);
  const definitions = new Map<string, ReturnType<typeof $createFootnoteDefinitionNode>>();
  const slotTransformer: MultilineElementTransformer = {
    type: 'multiline-element', dependencies: [FootnoteDefinitionNode], regExpStart: /^\ue000NBASE_FOOTNOTE_.*$/,
    replace: () => false,
    handleImportAfterStartMatch({ lines, rootNode, startLineIndex }) {
      const id = slots.get(lines[startLineIndex]!);
      if (!id) return null;
      const definition = $createFootnoteDefinitionNode(id);
      definitions.set(id, definition);
      rootNode.append(definition);
      return [true, startLineIndex];
    },
  };
  const editor = createEditor({ namespace: 'nbase-markdown', nodes: EDITOR_NODES, onError: error => { throw error; } });
  editor.update(() => {
    if (preservedAsSource) {
      $getRoot().clear().append($createCodeNode('markdown').append($createTextNode(markdown)));
    } else {
      $convertFromMarkdownString(document.body, preserveFootnotePosition ? [slotTransformer, ...transformers] : transformers);
      const root = $getRoot();
      for (const note of document.footnotes) {
        const definition = definitions.get(note.id) ?? $createFootnoteDefinitionNode(note.id);
        if (!definition.isAttached()) root.append(definition);
        $convertFromMarkdownString(note.markdown, transformers, definition);
      }
      if (Object.keys(header.metadata).length) $setState(root, frontMatterState, header.metadata);
    }
  }, { discrete: true });
  return {
    content: { schemaVersion: 1, editorState: editor.getEditorState().toJSON() },
    ...(!preservedAsSource && header.title !== undefined ? { title: header.title } : {}),
    tagNames: preservedAsSource ? [] : header.tagNames, warnings, preservedAsSource,
  };
}

export function createContentFromMarkdown(markdown: string): DocumentContent {
  return parseMarkdownImport(markdown).content;
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

function $exportMarkdown(): string {
  return $convertToMarkdownString(MARKDOWN_TRANSFORMERS);
}

function $snapshotContent() {
  return {
    content: normalizeDocumentContent({ schemaVersion: 1, editorState: { root: serializeNode($getRoot()) as SerializedRootNode } }),
    outline: $collectOutline(),
  };
}

/** Call inside an EditorState.read callback. Anchors are view-only and never persisted IDs. */
export function $createSnapshot(): EditorSnapshot {
  return { ...$snapshotContent(), markdown: $exportMarkdown(), plainText: $getRoot().getTextContent() };
}

/** Keep expensive text projections out of the save path; the captured state is immutable. */
export function readEditorSnapshot(state: EditorState): EditorSnapshot {
  let markdown: string | undefined;
  let plainText: string | undefined;
  return {
    ...state.read($snapshotContent),
    get markdown() { return markdown ??= state.read($exportMarkdown); },
    get plainText() { return plainText ??= state.read(() => $getRoot().getTextContent()); },
  };
}

export function markdownFromContent(content: DocumentContent, transformers = MARKDOWN_TRANSFORMERS): string {
  if (content.schemaVersion !== 1) throw new Error('不支持的文档内容版本');
  const editor = createEditor({ nodes: EDITOR_NODES, onError: error => { throw error; } });
  return editor.parseEditorState(content.editorState).read(() => $convertToMarkdownString(transformers));
}





