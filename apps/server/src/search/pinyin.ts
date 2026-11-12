import { pinyin } from 'pinyin-pro';

/** Toneless, lowercase readings with ü written as v, e.g. 绿 → lv. */
const readingPattern = /^[a-z]{1,6}$/;
const hanPattern = /^\p{Script=Han}$/u;
const maxReadings = 3;
const cacheLimit = 40000;
const charCache = new Map<string, string[]>();

function clean(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ü/g, 'v').toLowerCase();
}

export function isHan(char: string): boolean {
  return hanPattern.test(char);
}

/** Every dictionary reading of one Han character, most common first. */
export function charReadings(char: string): string[] {
  const cached = charCache.get(char);
  if (cached) return cached;
  const readings = [...new Set(pinyin(char, { multiple: true, type: 'array', toneType: 'none', v: true }).map(clean))]
    .filter(reading => readingPattern.test(reading));
  if (charCache.size < cacheLimit) charCache.set(char, readings);
  return readings;
}

/**
 * Readings of each character of a Han run: the dictionary's word-aware reading first (银行 → yin hang),
 * then up to two other readings so a common alternative still matches (重庆 → chong / zhong).
 */
export function runReadings(chars: string[]): string[][] {
  const contextual = pinyin(chars.join(''), { type: 'array', toneType: 'none', v: true }).map(clean);
  const aligned = contextual.length === chars.length;
  return chars.map((char, index) => {
    const all = charReadings(char);
    const first = aligned && readingPattern.test(contextual[index]!) ? [contextual[index]!] : [];
    return [...new Set([...first, ...all])].slice(0, maxReadings);
  });
}

let syllables: Set<string> | null = null;

/** Syllables the dictionary can produce, derived once from the CJK Unified Ideographs block. */
export function pinyinSyllables(): Set<string> {
  if (syllables) return syllables;
  const found = new Set<string>();
  for (let code = 0x4e00; code <= 0x9fff; code += 1) {
    for (const reading of charReadings(String.fromCodePoint(code))) found.add(reading);
  }
  charCache.clear();
  syllables = found;
  return found;
}
