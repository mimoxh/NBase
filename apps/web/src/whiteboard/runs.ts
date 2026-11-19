import { whiteboardLimits, type TextColorId, type WhiteboardTextRun } from '@nbase/contracts';

/**
 * Styled pieces of an element's text. Runs are stored only while some part of the text differs
 * from the element's own style; they always spell out the element's `text` exactly.
 */
export type Run = WhiteboardTextRun;
type RunFields = Omit<Run, 'text'>;

/** A style change over a range: `null` hands the field back to the element's own style. */
export interface RunPatch { bold?: boolean | null; italic?: boolean | null; color?: TextColorId | null; fontSize?: number | null }

/** The element defaults that a run attribute would only repeat. */
export interface RunDefaults { bold?: boolean | undefined; fontSize: number }

const fields = ['bold', 'italic', 'color', 'fontSize'] as const;
const sameFields = (a: RunFields, b: RunFields) => fields.every(key => a[key] === b[key]);
const stylesOf = (run: Run): RunFields => {
  const out: RunFields = {};
  for (const key of fields) if (run[key] !== undefined) (out as Record<string, unknown>)[key] = run[key];
  return out;
};

export const runsText = (runs: readonly Run[]) => runs.map(run => run.text).join('');

/**
 * The stored form: no empty pieces, no attribute that repeats the element's style, neighbours with
 * equal styles merged. Plain text comes back as `undefined`, so unstyled elements carry no runs.
 */
export function normalizeRuns(runs: readonly Run[] | undefined, defaults: RunDefaults): Run[] | undefined {
  if (!runs?.length) return undefined;
  const result: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const style = stylesOf(run);
    if (style.bold !== undefined && style.bold === Boolean(defaults.bold)) delete style.bold;
    if (style.italic === false) delete style.italic;
    if (style.fontSize !== undefined && style.fontSize === defaults.fontSize) delete style.fontSize;
    const last = result.at(-1);
    if (last && sameFields(stylesOf(last), style)) { result[result.length - 1] = { ...last, text: last.text + run.text }; continue; }
    result.push({ text: run.text, ...style });
  }
  if (!result.length || (result.length === 1 && !Object.keys(stylesOf(result[0]!)).length)) return undefined;
  if (result.length > whiteboardLimits.maxRuns) {
    // Too many pieces to store: keep the first ones and let the tail take the style of the last kept piece.
    const kept = result.slice(0, whiteboardLimits.maxRuns);
    kept[kept.length - 1] = { ...kept.at(-1)!, text: kept.at(-1)!.text + runsText(result.slice(whiteboardLimits.maxRuns)) };
    return kept;
  }
  return result;
}

/** Split so that a run boundary falls at every given offset (UTF-16 code units). */
function splitAt(runs: readonly Run[], offsets: number[]): Run[] {
  const cuts = [...new Set(offsets)].sort((a, b) => a - b);
  const result: Run[] = [];
  let position = 0;
  for (const run of runs) {
    let start = 0;
    for (const cut of cuts) {
      const local = cut - position;
      if (local > start && local < run.text.length) { result.push({ ...run, text: run.text.slice(start, local) }); start = local; }
    }
    result.push({ ...run, text: run.text.slice(start) });
    position += run.text.length;
  }
  return result;
}

const plainRuns = (text: string, runs: readonly Run[] | undefined): Run[] => runs?.length ? [...runs] : text ? [{ text }] : [];

/** Apply a style change to `[from, to)` of the text. */
export function styleRange(text: string, runs: readonly Run[] | undefined, from: number, to: number, patch: RunPatch, defaults: RunDefaults): Run[] | undefined {
  const start = Math.max(0, Math.min(from, to)), end = Math.min(text.length, Math.max(from, to));
  if (start === end) return normalizeRuns(plainRuns(text, runs), defaults);
  let position = 0;
  const next = splitAt(plainRuns(text, runs), [start, end]).map(run => {
    const at = position;
    position += run.text.length;
    if (at < start || at >= end) return run;
    const changed: Run = { ...run };
    for (const key of fields) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value === null) delete changed[key];
      else (changed as unknown as Record<string, unknown>)[key] = value;
    }
    return changed;
  });
  return normalizeRuns(next, defaults);
}

/** The style shared by every character of `[from, to)`; a field differing anywhere in the range is left out. */
export function rangeStyle(text: string, runs: readonly Run[] | undefined, from: number, to: number): RunFields {
  const pieces = plainRuns(text, runs);
  const start = Math.min(from, to), end = Math.max(from, to);
  let position = 0;
  let shared: RunFields | null = null;
  for (const run of pieces) {
    const at = position;
    position += run.text.length;
    // An empty range takes the style of the character before the caret.
    const touches = start === end ? (start > at && start <= position) || (start === 0 && at === 0) : at < end && position > start;
    if (!touches) continue;
    const style = stylesOf(run);
    if (!shared) { shared = style; continue; }
    for (const key of fields) if (shared[key] !== style[key]) delete shared[key];
  }
  return shared ?? {};
}

/**
 * Carry styles across a plain-text edit: the unchanged head and tail keep theirs, and inserted text
 * takes the style of the character before it (or after it, at the very start).
 */
export function editRuns(runs: readonly Run[] | undefined, before: string, after: string, defaults: RunDefaults): Run[] | undefined {
  if (!runs?.length || before === after) return runs?.length ? normalizeRuns(runs, defaults) : undefined;
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  const pieces = splitAt(runs, [head, before.length - tail]);
  const kept: Run[] = [], end: Run[] = [];
  let position = 0, styleBefore: RunFields | null = null, styleAfter: RunFields | null = null;
  for (const run of pieces) {
    const at = position;
    position += run.text.length;
    if (position <= head) { kept.push(run); styleBefore = stylesOf(run); }
    else if (at >= before.length - tail) { end.push(run); styleAfter ??= stylesOf(run); }
  }
  const inserted = after.slice(head, after.length - tail);
  const style = styleBefore ?? styleAfter ?? {};
  return normalizeRuns([...kept, ...(inserted ? [{ text: inserted, ...style }] : []), ...end], defaults);
}

/** Drop the run attributes an element-wide style change replaces, so the whole text shows the new style. */
export function clearRunFields(runs: readonly Run[] | undefined, keys: readonly (keyof RunFields)[], defaults: RunDefaults): Run[] | undefined {
  if (!runs?.length || !keys.length) return runs?.length ? normalizeRuns(runs, defaults) : undefined;
  return normalizeRuns(runs.map(run => {
    const next = { ...run };
    for (const key of keys) delete next[key];
    return next;
  }), defaults);
}
