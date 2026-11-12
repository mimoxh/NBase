import { charReadings, isHan, pinyinSyllables } from './pinyin.js';

export const maxSearchTerms = 8;
const maxParses = 3;
const maxUnits = 32;
const maxInitials = 16;
/** Letters that can begin a syllable; i, u and v never do. */
const initialLetters = /^[abcdefghjklmnopqrstwxyz]+$/;
const aliases: Record<string, string> = { lue: 'lve', nue: 'nve' };

/** A tsquery operand: one reading, a reading prefix (initial or unfinished syllable) or one of a character's readings. */
export type PinyinUnit = { exact: string } | { prefix: string } | { anyOf: string[] };
export interface SearchTerm { text: string; parses: PinyinUnit[][] }
export interface ParsedQuery {
  phrase: string; compact: string | null; terms: SearchTerm[]; near: string | null;
  /** The terms read as one pinyin phrase (xiangmu jihua → xiangmujihua); a contiguous match ranks first. */
  joined: SearchTerm | null;
}

let parseSyllables: string[] | null = null;
function syllables(): string[] {
  // Vowelless interjections (m, n, ng, hm) would turn ordinary letters into noise.
  parseSyllables ??= [...pinyinSyllables(), ...Object.keys(aliases)].filter(item => /[aeiouv]/.test(item));
  return parseSyllables;
}

/** Up to three segmentations into whole syllables, fewest units first; the final unit may be unfinished. */
function syllableParses(run: string, last: boolean): PinyinUnit[][] {
  const list = syllables();
  const best: PinyinUnit[][][] = Array.from({ length: run.length + 1 }, () => []);
  best[0] = [[]];
  for (let at = 0; at < run.length; at += 1) {
    if (!best[at]!.length) continue;
    for (const syllable of list) {
      const rest = run.length - at;
      const whole = run.startsWith(syllable, at);
      const partial = last && syllable.length > rest && syllable.startsWith(run.slice(at));
      if (!whole && !partial) continue;
      const next = whole ? at + syllable.length : run.length;
      const lexeme = aliases[syllable] ?? syllable;
      const unit: PinyinUnit = next === run.length && last ? { prefix: whole ? lexeme : run.slice(at) } : { exact: lexeme };
      for (const parse of best[at]!) {
        if (parse.length >= maxUnits) continue;
        const candidates = best[next]!;
        const key = JSON.stringify([...parse, unit]);
        if (candidates.some(item => JSON.stringify(item) === key)) continue;
        candidates.push([...parse, unit]);
        candidates.sort((a, b) => a.length - b.length);
        candidates.length = Math.min(candidates.length, maxParses);
      }
    }
  }
  return best[run.length]!;
}

function runParses(run: string, last: boolean): PinyinUnit[][] {
  const parses = syllableParses(run, last).slice(0, 2);
  if (run.length >= 2 && run.length <= maxInitials && initialLetters.test(run)) parses.push([...run].map(prefix => ({ prefix })));
  return parses;
}

/** Pinyin alternatives for a term with Latin letters, optionally mixed with Han characters (项目jihua). */
export function termParses(text: string): PinyinUnit[][] {
  const pieces = text.toLowerCase().replace(/ü/g, 'v').match(/\p{Script=Han}|[a-z]+|'|./gu) ?? [];
  if (!pieces.some(piece => /^[a-z]/.test(piece))) return [];
  let parses: PinyinUnit[][] = [[]];
  for (const [index, piece] of pieces.entries()) {
    if (piece === "'") continue;
    let options: PinyinUnit[][];
    if (isHan(piece)) {
      const readings = charReadings(piece);
      if (!readings.length) return [];
      options = [[readings.length === 1 ? { exact: readings[0]! } : { anyOf: readings }]];
    } else if (/^[a-z]+$/.test(piece)) options = runParses(piece, index === pieces.length - 1);
    else return [];
    if (!options.length) return [];
    parses = parses.flatMap(parse => options.map(option => [...parse, ...option])).slice(0, maxParses);
  }
  // A single syllable (hua, an) is too vague; do not reread it as two shorter ones (hu a).
  if (parses.some(parse => parse.length === 1)) return [];
  return parses.filter(parse => parse.length <= maxUnits);
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/** Space-separated pieces; a pure Chinese piece is split into dictionary words (项目计划 → 项目, 计划). */
export function searchTerms(phrase: string): string[] {
  const terms: string[] = [];
  for (const piece of phrase.split(/\s+/u).filter(Boolean)) {
    const pureHan = /\p{Script=Han}/u.test(piece) && !/[a-z]/i.test(piece);
    const words = pureHan ? [...segmenter.segment(piece)].filter(item => item.isWordLike).map(item => item.segment) : [piece];
    terms.push(...(words.length ? words : [piece]));
  }
  const seen = new Set<string>();
  return terms.filter(term => !seen.has(term.toLowerCase()) && seen.add(term.toLowerCase())).slice(0, maxSearchTerms);
}

function escapeRegex(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, char => `\\${char}`);
}

export function parseSearchQuery(phrase: string): ParsedQuery {
  const texts = phrase ? searchTerms(phrase) : [];
  const compact = /\s/u.test(phrase) && /\p{Script=Han}/u.test(phrase) ? phrase.replace(/\s+/gu, '') : null;
  const terms = texts.map(text => ({ text, parses: termParses(text) }));
  const joined = texts.length > 1 && terms.some(term => term.parses.length) ? termParses(texts.join('')) : [];
  return {
    phrase, compact, terms, near: texts.length > 1 ? texts.map(text => escapeRegex(text.toLowerCase())).join('.{0,24}') : null,
    joined: joined.length ? { text: texts.join(''), parses: joined } : null,
  };
}

function operand(unit: PinyinUnit): string {
  if ('exact' in unit) return unit.exact;
  if ('prefix' in unit) return `${unit.prefix}:*`;
  return `(${unit.anyOf.join(' | ')})`;
}

/** Lexemes are [a-z] only, so the text can be cast with ::tsquery without the parser. */
export function termTsQuery(term: SearchTerm): string | null {
  if (!term.parses.length) return null;
  return term.parses.map(parse => `(${parse.map(operand).join(' <-> ')})`).join(' | ');
}
