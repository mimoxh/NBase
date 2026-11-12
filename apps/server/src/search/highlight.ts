import { pinyinBodyUnitLimit, pinyinSlots, pinyinTitleUnitLimit } from './pinyin-index.js';
import type { PinyinUnit, SearchTerm } from './query.js';

const before = 45;
const after = 85;
const occurrenceLimit = 400;

export function snippetAt(text: string, at: number, length: number): string {
  if (!text) return '仅标题匹配';
  const start = Math.max(0, (at < 0 ? 0 : at) - before);
  const end = Math.min(text.length, (at < 0 ? 0 : at + length) + after);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function findLiteral(text: string, needle: string | null): number {
  return needle ? text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase()) : -1;
}

/** The shortest stretch of `text` that holds the most terms; frequency and order do not matter here. */
export function termWindow(text: string, terms: string[]): { at: number; term: string } | null {
  const lower = text.toLocaleLowerCase();
  const hits: { at: number; term: number }[] = [];
  terms.forEach((term, index) => {
    const needle = term.toLocaleLowerCase();
    for (let at = lower.indexOf(needle), count = 0; at >= 0 && count < occurrenceLimit; at = lower.indexOf(needle, at + 1), count += 1) {
      hits.push({ at, term: index });
    }
  });
  if (!hits.length) return null;
  hits.sort((a, b) => a.at - b.at);
  let best = { found: 0, span: Infinity, at: 0, term: 0 };
  const counts = new Map<number, number>();
  for (let left = 0, right = 0; right < hits.length; right += 1) {
    counts.set(hits[right]!.term, (counts.get(hits[right]!.term) ?? 0) + 1);
    while ((counts.get(hits[left]!.term) ?? 0) > 1) { counts.set(hits[left]!.term, counts.get(hits[left]!.term)! - 1); left += 1; }
    const span = hits[right]!.at - hits[left]!.at;
    if (counts.size > best.found || (counts.size === best.found && span < best.span)) {
      best = { found: counts.size, span, at: hits[left]!.at, term: hits[left]!.term };
    }
  }
  return { at: best.at, term: text.slice(best.at, best.at + terms[best.term]!.length) };
}

export type LexemePositions = Map<string, Set<number>>;

function unitMatches(unit: PinyinUnit, position: number, lexemes: LexemePositions): boolean {
  if ('exact' in unit) return lexemes.get(unit.exact)?.has(position) ?? false;
  if ('anyOf' in unit) return unit.anyOf.some(reading => lexemes.get(reading)?.has(position));
  for (const [lexeme, positions] of lexemes) if (lexeme.startsWith(unit.prefix) && positions.has(position)) return true;
  return false;
}

/** The characters a pinyin term matched, recovered from tsvector positions (slot index + 1). */
export function pinyinSpan(text: string, field: 'title' | 'body', terms: SearchTerm[], lexemes: LexemePositions):
  { at: number; text: string } | null {
  const starts = new Set<number>();
  for (const positions of lexemes.values()) positions.forEach(position => starts.add(position));
  const ordered = [...starts].sort((a, b) => a - b);
  for (const term of terms) {
    for (const parse of term.parses) {
      const start = ordered.find(position => parse.every((unit, offset) => unitMatches(unit, position + offset, lexemes)));
      if (start === undefined) continue;
      const slots = pinyinSlots(text, field === 'title' ? pinyinTitleUnitLimit : pinyinBodyUnitLimit, false);
      const first = slots[start - 1];
      const last = slots[start - 2 + parse.length];
      if (first && last) return { at: first.start, text: text.slice(first.start, last.end) };
    }
  }
  return null;
}

export function lexemeFilter(terms: SearchTerm[]): { exact: string[]; prefixes: string[] } {
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  for (const unit of terms.flatMap(term => term.parses.flat())) {
    if ('exact' in unit) exact.add(unit.exact);
    else if ('prefix' in unit) prefixes.add(unit.prefix);
    else unit.anyOf.forEach(reading => exact.add(reading));
  }
  return { exact: [...exact], prefixes: [...prefixes] };
}
