import type { TextColorId, WhiteboardTextRun } from '@nbase/contracts';

/** Text wrapping with an injected measurer, so the model stays testable without a canvas. */
export type Measure = (text: string, fontSize: number, bold: boolean, italic?: boolean) => number;

export const fontFamily = '-apple-system, "Segoe UI Variable Text", "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
export const fontOf = (fontSize: number, bold = false, italic = false) => `${italic ? 'italic ' : ''}${bold ? '600 ' : ''}${fontSize}px ${fontFamily}`;
export const lineHeightOf = (fontSize: number) => Math.round(fontSize * 1.4);

const wide = /[⺀-鿿豈-﫿＀-￯　-〿]/;

/** Deterministic estimate used by tests and before a canvas exists. */
export const approximateMeasure: Measure = (text, fontSize, bold) => {
  let width = 0;
  for (const char of text) width += wide.test(char) ? fontSize : fontSize * (bold ? 0.6 : 0.55);
  return width;
};

/** Break points: after spaces and hyphens, and between any two CJK characters. */
function tokens(line: string): string[] {
  const result: string[] = [];
  let current = '';
  for (const char of line) {
    if (wide.test(char)) { if (current) result.push(current); result.push(char); current = ''; continue; }
    current += char;
    if (char === ' ' || char === '-') { result.push(current); current = ''; }
  }
  if (current) result.push(current);
  return result;
}

export function wrapText(text: string, maxWidth: number, fontSize: number, bold: boolean, measure: Measure): string[] {
  const lines: string[] = [];
  const limit = Math.max(maxWidth, fontSize);
  for (const paragraph of text.split('\n')) {
    if (measure(paragraph, fontSize, bold) <= limit) { lines.push(paragraph); continue; }
    let current = '';
    const flush = () => { lines.push(current.trimEnd()); current = ''; };
    for (const token of tokens(paragraph)) {
      if (measure(current + token.trimEnd(), fontSize, bold) <= limit) { current += token; continue; }
      if (current) flush();
      if (measure(token.trimEnd(), fontSize, bold) <= limit) { current = token; continue; }
      // A single word wider than the box breaks by character.
      for (const char of token) {
        if (current && measure(current + char, fontSize, bold) > limit) flush();
        current += char;
      }
    }
    lines.push(current.trimEnd());
  }
  return lines;
}

export function textBlockSize(text: string, maxWidth: number, fontSize: number, bold: boolean, measure: Measure): { lines: string[]; width: number; height: number } {
  const lines = wrapText(text, maxWidth, fontSize, bold, measure);
  let width = 0;
  for (const line of lines) width = Math.max(width, measure(line, fontSize, bold));
  return { lines, width, height: lines.length * lineHeightOf(fontSize) };
}

// ── Styled text ─────────────────────────────────────────────────────────────

/** What a run looks like once the element's own style has filled in what the run leaves out. */
export interface RunStyle { bold: boolean; italic: boolean; color: TextColorId | null; fontSize: number }
/** The text of an element together with the style it gives every run. */
export interface StyledText { text: string; runs?: readonly WhiteboardTextRun[] | undefined; fontSize: number; bold?: boolean | undefined }
export interface LineSegment { text: string; style: RunStyle; width: number }
export interface TextLine { segments: LineSegment[]; width: number; height: number; /** Largest font size on the line. */ size: number }
export interface TextLayout { lines: TextLine[]; width: number; height: number }

export const baseStyle = (source: StyledText): RunStyle => ({ bold: Boolean(source.bold), italic: false, color: null, fontSize: source.fontSize });
export const runStyle = (run: WhiteboardTextRun, base: RunStyle): RunStyle => ({
  bold: run.bold ?? base.bold, italic: run.italic ?? base.italic, color: run.color ?? base.color, fontSize: run.fontSize ?? base.fontSize,
});
const sameStyle = (a: RunStyle, b: RunStyle) => a.bold === b.bold && a.italic === b.italic && a.color === b.color && a.fontSize === b.fontSize;

interface Glyph { char: string; style: RunStyle }

function segmentsOf(glyphs: readonly Glyph[], measure: Measure): LineSegment[] {
  const segments: LineSegment[] = [];
  for (const glyph of glyphs) {
    const last = segments.at(-1);
    if (last && sameStyle(last.style, glyph.style)) last.text += glyph.char;
    else segments.push({ text: glyph.char, style: glyph.style, width: 0 });
  }
  for (const segment of segments) segment.width = measure(segment.text, segment.style.fontSize, segment.style.bold, segment.style.italic);
  return segments;
}

const widthOf = (glyphs: readonly Glyph[], measure: Measure) => segmentsOf(glyphs, measure).reduce((sum, segment) => sum + segment.width, 0);

function trimEnd(glyphs: Glyph[]): Glyph[] {
  let end = glyphs.length;
  while (end > 0 && /\s/u.test(glyphs[end - 1]!.char)) end -= 1;
  return end === glyphs.length ? glyphs : glyphs.slice(0, end);
}

function glyphTokens(paragraph: readonly Glyph[]): Glyph[][] {
  const result: Glyph[][] = [];
  let current: Glyph[] = [];
  for (const glyph of paragraph) {
    if (wide.test(glyph.char)) { if (current.length) result.push(current); result.push([glyph]); current = []; continue; }
    current.push(glyph);
    if (glyph.char === ' ' || glyph.char === '-') { result.push(current); current = []; }
  }
  if (current.length) result.push(current);
  return result;
}

function lineOf(glyphs: Glyph[], fallback: RunStyle, measure: Measure): TextLine {
  const segments = segmentsOf(glyphs, measure);
  const size = segments.length ? Math.max(...segments.map(segment => segment.style.fontSize)) : fallback.fontSize;
  return { segments, width: segments.reduce((sum, segment) => sum + segment.width, 0), height: lineHeightOf(size), size };
}

/**
 * Lay out styled text in lines no wider than `maxWidth`, with the same break rules as `wrapText`.
 * Without runs the result matches `wrapText` line for line, so older boards wrap exactly as before.
 */
export function layoutText(source: StyledText, maxWidth: number, measure: Measure): TextLayout {
  const base = baseStyle(source);
  if (!source.runs?.length) {
    const lineHeight = lineHeightOf(source.fontSize);
    const lines = wrapText(source.text, maxWidth, source.fontSize, base.bold, measure).map((line): TextLine => {
      const width = measure(line, source.fontSize, base.bold);
      return { segments: line ? [{ text: line, style: base, width }] : [], width, height: lineHeight, size: source.fontSize };
    });
    return { lines, width: Math.max(0, ...lines.map(line => line.width)), height: lines.length * lineHeight };
  }
  const limit = Math.max(maxWidth, source.fontSize);
  const paragraphs: Glyph[][] = [[]];
  // Each empty line keeps the style the text had where it was broken, so its height matches what was typed.
  const lineStyles: RunStyle[] = [base];
  for (const run of source.runs) {
    const style = runStyle(run, base);
    for (const char of run.text) {
      if (char === '\n') { paragraphs.push([]); lineStyles.push(style); continue; }
      paragraphs.at(-1)!.push({ char, style });
    }
  }
  const lines: TextLine[] = [];
  paragraphs.forEach((paragraph, at) => {
    const fallback = paragraph[0]?.style ?? lineStyles[at] ?? base;
    if (widthOf(paragraph, measure) <= limit) { lines.push(lineOf(paragraph, fallback, measure)); return; }
    let current: Glyph[] = [];
    const flush = () => { lines.push(lineOf(trimEnd(current), fallback, measure)); current = []; };
    for (const token of glyphTokens(paragraph)) {
      if (widthOf([...current, ...trimEnd(token)], measure) <= limit) { current.push(...token); continue; }
      if (current.length) flush();
      if (widthOf(trimEnd(token), measure) <= limit) { current = [...token]; continue; }
      for (const glyph of token) {
        if (current.length && widthOf([...current, glyph], measure) > limit) flush();
        current.push(glyph);
      }
    }
    lines.push(lineOf(trimEnd(current), fallback, measure));
  });
  return { lines, width: Math.max(0, ...lines.map(line => line.width)), height: lines.reduce((sum, line) => sum + line.height, 0) };
}

/** Where a segment's vertical centre sits on its line, so smaller type shares the baseline of the largest. */
export const segmentCenterOffset = (line: TextLine, size: number) => (line.size - size) * 0.34;
