import { isHan, runReadings } from './pinyin.js';

/** Pinyin keys cover the whole title and only this many UTF-16 units from the start of `search_text`. */
export const pinyinBodyUnitLimit = 8000;
export const pinyinTitleUnitLimit = 512;
/** PostgreSQL keeps at most 256 positions per lexeme; extra occurrences are dropped here, not silently there. */
const positionsPerLexeme = 255;

export interface PinyinSlot { start: number; end: number; readings: string[] }

/**
 * One slot per Han code point and one separator slot per run of anything else, so tsvector positions
 * (slot index + 1) are adjacent only for touching Han characters and map back to text offsets.
 */
export function pinyinSlots(text: string, unitLimit: number, withReadings = true): PinyinSlot[] {
  const slots: PinyinSlot[] = [];
  const end = Math.min(text.length, unitLimit);
  let run: { slot: PinyinSlot; char: string }[] = [];
  const flush = () => {
    if (!run.length) return;
    if (withReadings) runReadings(run.map(item => item.char)).forEach((readings, index) => { run[index]!.slot.readings = readings; });
    run = [];
  };
  for (let at = 0; at < end;) {
    const char = String.fromCodePoint(text.codePointAt(at)!);
    if (at + char.length > end) break;
    if (isHan(char)) {
      const slot = { start: at, end: at + char.length, readings: [] };
      slots.push(slot);
      run.push({ slot, char });
    } else {
      flush();
      const last = slots.at(-1);
      if (last && !isHan(text.slice(last.start, last.end))) last.end = at + char.length;
      else slots.push({ start: at, end: at + char.length, readings: [] });
    }
    at += char.length;
  }
  flush();
  return slots;
}

/** A tsvector literal; lexemes are plain [a-z] readings, so no quoting is needed. */
export function pinyinVector(text: string, unitLimit: number): string {
  const positions = new Map<string, number[]>();
  pinyinSlots(text, unitLimit).forEach((slot, index) => {
    for (const reading of slot.readings) {
      const list = positions.get(reading) ?? [];
      if (list.length < positionsPerLexeme) list.push(index + 1);
      positions.set(reading, list);
    }
  });
  return [...positions].map(([lexeme, list]) => `${lexeme}:${list.join(',')}`).join(' ');
}

/** Derived pinyin keys for one page; rebuildable from title and `search_text`, never authoritative. */
export function pagePinyinIndex(title: string, searchText: string): { title: string; body: string } {
  return { title: pinyinVector(title, pinyinTitleUnitLimit), body: pinyinVector(searchText, pinyinBodyUnitLimit) };
}
