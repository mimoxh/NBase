import { $isCodeNode } from '@lexical/code';
import { $createLinkNode, $isLinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link';
import { $findMatchingParent } from '@lexical/utils';
import { $createTextNode, $getSelection, $isRangeSelection, $isTextNode } from 'lexical';
import type { LexicalEditor, LexicalNode } from 'lexical';
import { isSafeLinkUrl } from './markdown';

export type UrlMatch = { start: number; end: number; text: string; url: string };

// CJK text and full-width punctuation end a typed URL, so 「见https://a.com。」 stops at the host.
const urlCharacter = '[^\\s<>"`\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef]';
const TRAILING_URL = new RegExp(`(?<![A-Za-z0-9._%+@/-])((?:https?://|www\\.)${urlCharacter}+)$`, 'i');

function normalizedUrl(text: string): string | null {
  if (/^www\./i.test(text) && !/^www\.[^./]+\.[^./]/i.test(text)) return null;
  const url = /^www\./i.test(text) ? `https://${text}` : text;
  if (!isSafeLinkUrl(url)) return null;
  try {
    return new URL(url).hostname ? url : null;
  } catch {
    return null;
  }
}

/** Sentence punctuation and an unmatched closing bracket belong to the prose, not the URL. */
function withoutTrailingPunctuation(text: string): string {
  let value = text;
  for (;;) {
    const unmatched = (open: string, close: string) => value.endsWith(close)
      && value.split(close).length > value.split(open).length;
    if (/[.,;:!?'*_~]$/.test(value) || unmatched('(', ')') || unmatched('[', ']')) value = value.slice(0, -1);
    else return value;
  }
}

/** The URL ending at the caret, unless it is still part of `[text](url)` or `[[page`. */
export function trailingUrl(textBeforeCaret: string): UrlMatch | null {
  const match = TRAILING_URL.exec(textBeforeCaret);
  if (!match) return null;
  const before = textBeforeCaret.slice(0, match.index);
  if (before.endsWith('](') || before.endsWith('[[')) return null;
  const text = withoutTrailingPunctuation(match[1]!);
  const url = normalizedUrl(text);
  return url ? { start: match.index, end: match.index + text.length, text, url } : null;
}

/** Clipboard text that is exactly one URL; a real paste may carry non-ASCII paths. */
export function standaloneUrl(clipboardText: string): Pick<UrlMatch, 'text' | 'url'> | null {
  const text = clipboardText.trim();
  if (!/^(?:https?:\/\/|www\.)\S+$/i.test(text)) return null;
  const url = normalizedUrl(text);
  return url ? { text, url } : null;
}

function $linkingBlocked(node: LexicalNode): boolean {
  return Boolean($findMatchingParent(node, ancestor => $isLinkNode(ancestor) || $isCodeNode(ancestor)));
}

/**
 * Runs from a key command, never from a node transform: a transform would also
 * visit stored text on open and turn merely viewing a page into a new revision.
 */
export function $linkUrlBeforeCaret(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.hasFormat('code')) return false;
  const node = selection.anchor.getNode();
  if (!$isTextNode(node) || !node.isSimpleText() || $linkingBlocked(node)) return false;
  const offset = selection.anchor.offset;
  const text = node.getTextContent();
  const match = trailingUrl(text.slice(0, offset));
  if (!match) return false;
  const parts = node.splitText(...[match.start, match.end].filter(value => value > 0 && value < text.length));
  const target = parts[match.start > 0 ? 1 : 0]!;
  const tail = target.getNextSibling();
  const link = $createLinkNode(match.url, { rel: 'noopener noreferrer' });
  target.replace(link);
  link.append(target);
  const rest = offset - match.end;
  if (rest > 0 && $isTextNode(tail)) tail.select(rest, rest);
  else target.selectEnd();
  return true;
}

/** A pasted URL links the selected words, or inserts a link at the caret. */
export function $pasteUrl(editor: LexicalEditor, clipboardText: string): boolean {
  const selection = $getSelection();
  const match = standaloneUrl(clipboardText);
  if (!match || !$isRangeSelection(selection) || selection.hasFormat('code')) return false;
  const anchor = selection.anchor.getNode();
  const focus = selection.focus.getNode();
  if ($linkingBlocked(anchor) || $linkingBlocked(focus)) return false;
  if (selection.isCollapsed()) {
    selection.insertNodes([$createLinkNode(match.url, { rel: 'noopener noreferrer' }).append($createTextNode(match.text))]);
    return true;
  }
  if (!anchor.getTopLevelElement()?.is(focus.getTopLevelElement())) return false;
  return editor.dispatchCommand(TOGGLE_LINK_COMMAND, match.url);
}
