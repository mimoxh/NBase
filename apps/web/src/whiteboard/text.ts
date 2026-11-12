/** Text wrapping with an injected measurer, so the model stays testable without a canvas. */
export type Measure = (text: string, fontSize: number, bold: boolean) => number;

export const fontFamily = '-apple-system, "Segoe UI Variable Text", "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
export const fontOf = (fontSize: number, bold = false) => `${bold ? '600 ' : ''}${fontSize}px ${fontFamily}`;
export const lineHeightOf = (fontSize: number) => Math.round(fontSize * 1.4);

const wide = /[⺀-鿿豈-﫿＀-￯　-〿]/;

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
