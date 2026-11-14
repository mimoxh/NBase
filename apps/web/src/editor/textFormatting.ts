import { parseTextStyle, textStyleCss, type BlockAlignment, type TextStyle } from '@nbase/contracts';
import { $isHeadingNode } from '@lexical/rich-text';
import { $getSelectionStyleValueForProperty, $patchStyleText } from '@lexical/selection';
import { $isTableCellNode } from '@lexical/table';
import { $findMatchingParent, $getSelection, $isParagraphNode, $isRangeSelection } from 'lexical';
import type { ElementNode, LexicalNode, TextNode } from 'lexical';
import { $isToggleNode } from './nodes/ToggleNode';

const cssColor = (id: string | undefined, kind: 'c' | 'bg') => id ? `var(--nb-${kind}-${id})` : null;

/** `null` clears a property, `undefined` leaves it alone. Call inside editor.update. */
export function $applyTextStyle(patch: { color?: TextStyle['color'] | null; background?: TextStyle['background'] | null }): void {
  const selection = $getSelection();
  if (!selection) return;
  $patchStyleText(selection, {
    ...(patch.color !== undefined ? { color: cssColor(patch.color ?? undefined, 'c') } : {}),
    ...(patch.background !== undefined ? { 'background-color': cssColor(patch.background ?? undefined, 'bg') } : {}),
  });
}

/** The palette entries shared by the whole selection; mixed values read as unset. */
export function $selectionTextStyle(): TextStyle {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return {};
  return parseTextStyle(`color: ${$getSelectionStyleValueForProperty(selection, 'color', '')};`
    + `background-color: ${$getSelectionStyleValueForProperty(selection, 'background-color', '')}`);
}

/** Stored text styles only ever hold palette tokens in canonical order; pasted or patched CSS is rewritten. */
export function $canonicalizeTextStyle(node: TextNode): void {
  const style = node.getStyle();
  if (!style) return;
  const canonical = textStyleCss(parseTextStyle(style));
  if (canonical !== style) node.setStyle(canonical);
}

/**
 * Only paragraphs and headings outside tables take an alignment or indent: list items, quotes and
 * table cells have no Markdown form for them, and a toggle summary stays unaligned.
 */
export function $alignable(node: LexicalNode): ElementNode | null {
  const block = $findMatchingParent(node, item => $isParagraphNode(item) || $isHeadingNode(item)) as ElementNode | null;
  if (!block) return null;
  const parent = block.getParent();
  if ($isTableCellNode(parent) || ($isToggleNode(parent) && parent.getFirstChild()?.is(block))) return null;
  return block;
}

export function $selectionAlignment(): BlockAlignment | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const block = $alignable(selection.anchor.getNode());
  if (!block) return null;
  const format = block.getFormatType();
  return format === 'center' || format === 'right' || format === 'justify' ? format : 'left';
}

/** Left is the default and is stored as no format, so aligning left again leaves no trace. */
export function $setAlignment(value: BlockAlignment): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const blocks = new Map<string, ElementNode>();
  for (const node of selection.getNodes()) {
    const block = $alignable(node);
    if (block) blocks.set(block.getKey(), block);
  }
  for (const block of blocks.values()) block.setFormat(value === 'left' ? '' : value);
}
