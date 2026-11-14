import { $convertToMarkdownString } from '@lexical/markdown';
import type { ElementTransformer, MultilineElementTransformer, Transformer } from '@lexical/markdown';
import { $isHeadingNode, HeadingNode } from '@lexical/rich-text';
import { $isTableCellNode, $isTableNode } from '@lexical/table';
import { $applyTableLayout, parseTableLayoutComment, type TableLayout } from './tableLayout';
import { $isLinkNode } from '@lexical/link';
import { $createBookmarkNode, $isBookmarkNode, BookmarkNode } from './nodes/BookmarkNode';
import { blockIdState } from './blockAnchors';
import { $setState } from 'lexical';

const hex = (text: string) => [...new TextEncoder().encode(text)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = (text: string) => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(text.match(/../g) ?? [], pair => parseInt(pair, 16)));

/** `<!-- nbase-bookmark site="…" description="…" -->` with percent-encoded values; the next line is the link. */
function parseBookmarkComment(line: string): { description: string; siteName: string } | null {
  const match = /^<!-- nbase-bookmark site="([^"\s]*)" description="([^"\s]*)" -->$/.exec(line.trim());
  try { return match ? { siteName: decodeURIComponent(match[1]!).slice(0, 120), description: decodeURIComponent(match[2]!).slice(0, 1000) } : null; }
  catch { return null; }
}

const escapeLinkText = (text: string) => text.replace(/[\\[\]`*_~=$<>!&]/g, '\\$&');
const commentValue = (text: string) => encodeURIComponent(text).replace(/[!'()*~-]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());

export const BOOKMARK_BLOCK: ElementTransformer = {
  type: 'element', dependencies: [BookmarkNode], regExp: /(?!)x/,
  replace: () => false,
  export(node) {
    if (!$isBookmarkNode(node)) return null;
    const { url, title, description, siteName } = node.getPreview();
    return `<!-- nbase-bookmark site="${commentValue(siteName)}" description="${commentValue(description)}" -->\n[${escapeLinkText(title)}](<${url.replace(/[<>\s]/g, encodeURIComponent)}>)`;
  },
};
import { parseTextStyle, textColorHex, textColorIds, textStyleCss, type TextColorId, type TextStyle } from '@nbase/contracts';
import { $createParagraphNode, $createTextNode, $isElementNode, $isParagraphNode, $isTextNode, ParagraphNode } from 'lexical';
import type { ElementFormatType, ElementNode, LexicalNode, TextNode } from 'lexical';
import { markdownLines, rewriteMarkdownProse } from './markdownReferences';
import { $isFootnoteDefinitionNode } from './nodes/FootnoteNodes';
import { $createToggleNode, $isToggleNode, ToggleNode } from './nodes/ToggleNode';

/**
 * Markdown has no syntax for text colour, alignment, indentation or collapsible blocks, so NBase
 * writes a fixed HTML subset for them: `<span style="color:#…">`, `<div align="…" style="margin-left:…em">`
 * and `<details>`.
 * Import swaps exactly those forms for private-use markers before the Markdown conversion and
 * resolves the markers afterwards; any other HTML still keeps the whole document as source.
 */
const OPEN = '', CLOSE = '', BLOCK = '';
const reserved = /[-]/;
const spanOpen = /<span style="(?:color:(#[0-9a-f]{6}))?;?(?:background-color:(#[0-9a-f]{6}))?">/g;
const alignments: Record<string, ElementFormatType> = { c: 'center', r: 'right', j: 'justify' };
/** One indent level is 2em, as in the HTML export; the attribute order is fixed. */
const divOpen = /^<div(?: align="(center|right|justify)")?(?: style="margin-left:([1-9]\d?)em")?>$/;
const divMarker = /^A([crjn])(\d{0,2})$/;

const colorByHex = (hex: string | undefined, kind: 'text' | 'background') =>
  hex ? textColorIds.find(id => textColorHex[id][kind] === hex) : undefined;
const colorCode = (id: TextColorId | undefined) => id ? String(textColorIds.indexOf(id) + 1) : '0';
const colorFromCode = (code: string | undefined) => textColorIds[Number(code) - 1];

export function textStyleSpan(css: string): string {
  const { color, background } = parseTextStyle(css);
  if (!color && !background) return '';
  return '<span style="' + [color && 'color:' + textColorHex[color].text,
    background && 'background-color:' + textColorHex[background].background].filter(Boolean).join(';') + '">';
}

function encodeInline(markdown: string): string | null {
  let unknown = false;
  const encoded = rewriteMarkdownProse(markdown, text => text.replace(spanOpen, (tag, color?: string, background?: string) => {
    const style: TextStyle = {};
    const text = colorByHex(color, 'text'), fill = colorByHex(background, 'background');
    if (text) style.color = text;
    if (fill) style.background = fill;
    if ((!color && !background) || Boolean(color) !== Boolean(text) || Boolean(background) !== Boolean(fill)) { unknown = true; return tag; }
    return OPEN + colorCode(style.color) + colorCode(style.background);
  }).replace(/<\/span>/g, CLOSE));
  if (unknown) return null;
  // A span never crosses a line: every exported block is one line, and nesting is not written.
  for (const line of encoded.split('\n')) {
    let depth = 0;
    for (const char of line) {
      if (char === OPEN) depth++;
      else if (char === CLOSE) depth--;
      if (depth < 0 || depth > 1) return null;
    }
    if (depth) return null;
  }
  return encoded;
}

function encodeBlocks(markdown: string): string | null {
  const lines = markdownLines(markdown);
  const output: string[] = [];
  const stack: { kind: 'toggle' | 'align'; quote: string; summary: boolean }[] = [];
  for (const line of lines) {
    const prose = line.prose?.trim();
    const top = stack.at(-1);
    const quote = line.prefix.trimEnd();
    const emit = (marker: string) => { output.push(quote, line.prefix + marker, quote); };
    if (top?.kind === 'toggle' && !top.summary) {
      const summary = prose === undefined ? null : /^<summary>(.*)<\/summary>$/.exec(prose);
      if (!summary || quote !== top.quote) return null;
      top.summary = true;
      emit(BLOCK + 'S' + summary[1]);
      continue;
    }
    if (prose === undefined) { output.push(line.raw); continue; }
    const div = divOpen.exec(prose);
    const em = div?.[2] ? Number(div[2]) : 0;
    const align = div && (div[1] || em) && em % 2 === 0 ? div : null;
    if (div && !align) return null;
    const layout = prose.startsWith('<!-- nbase-table ') ? parseTableLayoutComment(prose) : null;
    const anchor = /^<!-- \^([a-z0-9]{8}) -->$/.exec(prose);
    if (anchor) { emit(BLOCK + 'I' + anchor[1]); continue; }
    if (prose.startsWith('<!-- nbase-bookmark ')) {
      const fields = parseBookmarkComment(prose);
      if (!fields) return null;
      emit(BLOCK + 'K' + hex(JSON.stringify(fields)));
      continue;
    }
    if (prose.startsWith('<!-- nbase-table ')) {
      if (!layout) return null;
      // Digits and ; , . = x only, so the marker paragraph never matches another Markdown rule.
      emit(BLOCK + 'W' + (layout.widths?.join(',') ?? '') + ';'
        + layout.spans.map(span => `${span.row}.${span.column}=${span.colSpan}x${span.rowSpan}`).join(','));
      continue;
    }
    if (prose === '<details>' || prose === '<details open>') {
      stack.push({ kind: 'toggle', quote, summary: false });
      emit(BLOCK + 'T');
    } else if (align) {
      stack.push({ kind: 'align', quote, summary: true });
      emit(BLOCK + 'A' + (align[1]?.[0] ?? 'n') + (em ? String(em / 2) : ''));
    } else if (prose === '</details>' || prose === '</div>') {
      if (top?.kind !== (prose === '</div>' ? 'align' : 'toggle') || top.quote !== quote) return null;
      stack.pop();
      emit(BLOCK + (prose === '</div>' ? 'a' : 't'));
    } else output.push(line.raw);
  }
  return stack.length ? null : output.join('\n');
}

/** Returns the input unchanged when it uses the subset in any form this module would not write itself. */
export function encodeHtmlSubset(markdown: string): { markdown: string; reserved: boolean } {
  if (reserved.test(markdown)) return { markdown, reserved: true };
  if (!/<(?:span|div|details)\b|<!-- nbase-(?:table|bookmark) |<!-- \^[a-z0-9]{8} -->/.test(markdown)) return { markdown, reserved: false };
  const inline = encodeInline(markdown);
  const blocks = inline === null ? null : encodeBlocks(inline);
  return { markdown: blocks ?? markdown, reserved: false };
}

function $blockMarker(node: LexicalNode): string | null {
  if (!$isParagraphNode(node)) return null;
  const text = node.getTextContent();
  return text.startsWith(BLOCK) ? text.slice(1) : null;
}

function $resolveBlocks(container: ElementNode): boolean {
  const stack: ({ align: ElementFormatType | null; indent: number } | { toggle: ToggleNode })[] = [];
  let layout: TableLayout | null = null;
  let bookmark: { description: string; siteName: string } | null = null;
  let anchorId: string | null = null;
  // The anchor line precedes a block's own markers, so it attaches to whichever block they produce.
  const claim = (node: LexicalNode): boolean => {
    if (!anchorId) return true;
    if (!$isElementNode(node)) return false;
    $setState(node, blockIdState, anchorId);
    anchorId = null;
    return true;
  };
  for (const child of container.getChildren()) {
    const marker = $blockMarker(child);
    if (bookmark) {
      const link = $isParagraphNode(child) && child.getChildrenSize() === 1 ? child.getFirstChild() : null;
      if (!$isLinkNode(link) || !/^https?:/i.test(link.getURL())) return false;
      child.replace($createBookmarkNode({ url: link.getURL(), title: link.getTextContent(), ...bookmark }));
      bookmark = null;
      continue;
    }
    if (marker?.[0] === 'I') {
      if (anchorId || !/^I[a-z0-9]{8}$/.test(marker)) return false;
      anchorId = marker.slice(1);
      child.remove();
      continue;
    }
    if (marker?.[0] === 'K') {
      try { bookmark = JSON.parse(unhex(marker.slice(1))) as { description: string; siteName: string }; } catch { return false; }
      child.remove();
      continue;
    }
    if (layout) {
      if (!$isTableNode(child) || !$applyTableLayout(child, layout)) return false;
      layout = null;
    }
    if (marker?.[0] === 'W') {
      const [widths, spans] = marker.slice(1).split(';');
      layout = parseTableLayoutComment('<!-- nbase-table' + (widths ? ` widths="${widths}"` : '') + (spans ? ` spans="${spans}"` : '') + ' -->');
      if (!layout) return false;
      child.remove();
      continue;
    }
    const toggle = stack.findLast((frame): frame is { toggle: ToggleNode } => 'toggle' in frame)?.toggle;
    if (marker !== null) {
      const top = stack.at(-1);
      const div = divMarker.exec(marker);
      if (div) { stack.push({ align: alignments[div[1]!] ?? null, indent: Number(div[2] || 0) }); child.remove(); }
      else if (marker === 'a' && top && 'align' in top) { stack.pop(); child.remove(); }
      else if (marker === 'T') {
        const node = $createToggleNode();
        if (toggle) { toggle.append(node); child.remove(); } else child.replace(node);
        if (!claim(node)) return false;
        stack.push({ toggle: node });
      } else if (marker[0] === 'S' && top && 'toggle' in top && top.toggle.isEmpty()) {
        const first = (child as ElementNode).getFirstDescendant();
        if (!$isTextNode(first) || !first.getTextContent().startsWith(BLOCK + 'S')) return false;
        if (first.getTextContentSize() === 2) first.remove(); else first.setTextContent(first.getTextContent().slice(2));
        top.toggle.append(child);
      } else if (marker === 't' && top && 'toggle' in top && !top.toggle.isEmpty()) {
        stack.pop();
        child.remove();
      } else return false;
      continue;
    }
    if (!claim(child)) return false;
    if (toggle) {
      if (toggle.isEmpty()) return false;
      toggle.append(child);
    }
    const div = stack.findLast((frame): frame is { align: ElementFormatType | null; indent: number } => 'align' in frame);
    if (div && ($isParagraphNode(child) || $isHeadingNode(child))) {
      if (div.align) child.setFormat(div.align);
      if (div.indent) child.setIndent(div.indent);
    }
    if ($isElementNode(child) && (child.isShadowRoot() || $isFootnoteDefinitionNode(child)) && !$resolveBlocks(child)) return false;
  }
  return stack.length === 0 && !layout && !bookmark && !anchorId;
}

function $resolveInline(block: ElementNode): void {
  let style = '';
  const visit = (node: LexicalNode): void => {
    if ($isElementNode(node)) {
      if (node.isInline()) node.getChildren().forEach(visit);
      return;
    }
    if (!$isTextNode(node)) return;
    const text = node.getTextContent();
    if (!text.includes(OPEN) && !text.includes(CLOSE)) { if (style) node.setStyle(style); return; }
    const parts: TextNode[] = [];
    let buffer = '';
    const flush = () => {
      if (buffer) parts.push($createTextNode(buffer).setFormat(node.getFormat()).setStyle(style));
      buffer = '';
    };
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      if (char === OPEN) {
        flush();
        const color = colorFromCode(text[index + 1]), background = colorFromCode(text[index + 2]);
        style = textStyleCss({ ...(color ? { color } : {}), ...(background ? { background } : {}) });
        index += 2;
      } else if (char === CLOSE) { flush(); style = ''; }
      else buffer += char;
    }
    flush();
    if (!parts.length) { node.remove(); return; }
    let last: LexicalNode = node.replace(parts[0]!);
    for (const part of parts.slice(1)) last = last.insertAfter(part);
  };
  for (const child of block.getChildren()) {
    if ($isElementNode(child) && !child.isInline()) $resolveInline(child);
    else visit(child);
  }
}

/** Call after the Markdown conversion, inside the same update. False means a marker could not be placed. */
export function $resolveHtmlSubset(root: ElementNode): boolean {
  if (!reserved.test(root.getTextContent())) return true;
  if (!$resolveBlocks(root)) return false;
  $resolveInline(root);
  return !reserved.test(root.getTextContent());
}

const alignedFormat = (node: ElementNode) => ['center', 'right', 'justify'].includes(node.getFormatType()) ? node.getFormatType() : null;
const aligned = (node: LexicalNode): node is ParagraphNode | HeadingNode =>
  ($isParagraphNode(node) || $isHeadingNode(node)) && (alignedFormat(node) !== null || node.getIndent() > 0)
  && !$isTableCellNode(node.getParent());

export const ALIGNED_BLOCK: ElementTransformer = {
  type: 'element', dependencies: [ParagraphNode, HeadingNode], regExp: /(?!)x/,
  replace: () => false,
  export(node, traverseChildren) {
    if (!aligned(node)) return null;
    const body = ($isHeadingNode(node) ? '#'.repeat(Number(node.getTag().slice(1))) + ' ' : '') + traverseChildren(node);
    const format = alignedFormat(node), indent = node.getIndent();
    const attributes = (format ? ` align="${format}"` : '') + (indent > 0 ? ` style="margin-left:${indent * 2}em"` : '');
    return `<div${attributes}>\n\n${body}\n\n</div>`;
  },
};

export function createToggleTransformer(transformers: () => Transformer[]): MultilineElementTransformer {
  return {
    type: 'multiline-element', dependencies: [ToggleNode], regExpStart: /(?!)x/,
    replace: () => false,
    export(node, traverseChildren) {
      if (!$isToggleNode(node)) return null;
      const first = node.getFirstChild();
      const summary = $isParagraphNode(first) ? traverseChildren(first).replace(/\n+/g, ' ') : '';
      const all = $convertToMarkdownString(transformers(), node);
      // The summary paragraph exports as its own inline text, so it is the prefix of the whole export.
      const body = (all.startsWith(summary) ? all.slice(summary.length) : all).replace(/^\n+/, '');
      return `<details>\n<summary>${summary}</summary>\n\n${body ? body + '\n\n' : ''}</details>`;
    },
  };
}
