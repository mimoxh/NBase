import { isFootnoteId } from '@nbase/contracts';

interface MarkdownLine { raw: string; prefix: string; prose: string | null }
interface Footnote { id: string; markdown: string }
interface LinkDefinition { destination: string; title?: string }

const quotePrefix = /^(?: {0,3}>[ \t]?)+/;
const fenceStart = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const footnoteStart = /^ {0,3}\[\^([^\]\r\n]{1,128})\]:[ \t]*(.*)$/u;
const linkStart = /^ {0,3}\[((?:\\.|[^\]\\]){1,512})\]:[ \t]*(.*)$/u;
const escapedPunctuation = /\\([!-/:-@[-`{-~])/g;

/** Preserve indentation and quote prefixes while excluding examples from definition and reference lookup. */
export function markdownLines(markdown: string): MarkdownLine[] {
  let fence: { quote: number; marker: string; length: number } | undefined;
  let mathQuote: number | undefined;
  return markdown.replace(/\r\n?/g, '\n').split('\n').map(raw => {
    const prefix = quotePrefix.exec(raw)?.[0] ?? '';
    const quote = prefix.split('>').length - 1;
    const line = raw.slice(prefix.length);
    const fenceMatch = fenceStart.exec(line);
    if (fence?.quote !== quote) fence = undefined;
    if (mathQuote !== quote) mathQuote = undefined;
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence.marker && fenceMatch[1]!.length >= fence.length && !fenceMatch[2]!.trim()) fence = undefined;
      return { raw, prefix, prose: null };
    }
    if (mathQuote !== undefined) {
      if (/^\s*\$\$\s*$/.test(line)) mathQuote = undefined;
      return { raw, prefix, prose: null };
    }
    if (fenceMatch) {
      fence = { quote, marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      return { raw, prefix, prose: null };
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      mathQuote = quote;
      return { raw, prefix, prose: null };
    }
    if (/^\s*\$\$.*\$\$\s*$/.test(line)) return { raw, prefix, prose: null };
    return { raw, prefix, prose: line };
  });
}

function referenceKey(value: string): string {
  return value.replace(escapedPunctuation, '$1').trim().replace(/\s+/g, ' ').toLowerCase().normalize('NFC');
}

function linkDefinition(value: string): LinkDefinition | null {
  const match = /^(?:<([^<>\r\n]*)>|((?:\\.|[^\s\\()])+))(?:[ \t]+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^()\\])*)\)))?[ \t]*$/.exec(value);
  const destination = match?.[1] ?? match?.[2];
  if (!destination) return null;
  const title = (match?.[3] ?? match?.[4] ?? match?.[5])?.replace(escapedPunctuation, '$1');
  return { destination: destination.replace(escapedPunctuation, '$1'), ...(title === undefined ? {} : { title }) };
}

function bracketEnd(line: string, start: number): number {
  let depth = 1;
  const limit = Math.min(line.length, start + 1025);
  for (let index = start + 1; index < limit; index++) {
    if (line[index] === '\\') index++;
    else if (line[index] === '[') depth++;
    else if (line[index] === ']' && --depth === 0) return index;
  }
  return -1;
}

function inlineDestinationEnd(line: string, start: number): number {
  let depth = 1;
  let angle = false;
  let title = '';
  for (let index = start + 1; index < line.length; index++) {
    const character = line[index];
    if (character === '\\') { index++; continue; }
    if (title) { if (character === title) title = ''; continue; }
    if (angle) { if (character === '>') angle = false; continue; }
    if (character === '<' && depth === 1) angle = true;
    else if ((character === '"' || character === "'") && /\s/.test(line[index - 1]!)) title = character;
    else if (character === '(') depth++;
    else if (character === ')' && --depth === 0) return index;
  }
  return -1;
}

const inlineLiterals = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)|(?<![\\$])\$(?:\\.|[^\s$\\])(?:(?:\\.|[^$\\\n])*(?:\\.|[^\s$\\]))?\$(?!\d)/g;

function inlineLiteralEnds(line: string): Map<number, number> {
  const spans = new Map<number, number>();
  for (const match of line.matchAll(inlineLiterals)) {
    let backslashes = 0;
    for (let index = match.index - 1; line[index] === '\\'; index--) backslashes++;
    if (backslashes % 2 === 0) spans.set(match.index, match.index + match[0].length);
  }
  return spans;
}

/** Rewrite actual prose only; code, math and their inline spans retain literal content. */
export function rewriteMarkdownProse(markdown: string, rewrite: (text: string) => string): string {
  return markdownLines(markdown).map(line => {
    if (line.prose === null) return line.raw;
    let result = '', end = 0;
    for (const [start, next] of inlineLiteralEnds(line.prose)) {
      result += rewrite(line.prose.slice(end, start)) + line.prose.slice(start, next);
      end = next;
    }
    return line.prefix + result + rewrite(line.prose.slice(end));
  }).join('\n');
}

export function maskMarkdownInlineLiterals(line: string): string {
  let masked = '';
  let end = 0;
  for (const [start, next] of inlineLiteralEnds(line)) {
    masked += line.slice(end, start) + '内容';
    end = next;
  }
  return masked + line.slice(end);
}

function rewriteInline(line: string, links: Map<string, LinkDefinition>, footnotes: Map<string, Footnote>, warnings: Set<string>): string {
  if (!line.includes('[')) return line;
  const literalEnds = inlineLiteralEnds(line);
  let output = '';
  for (let index = 0; index < line.length;) {
    const literalEnd = literalEnds.get(index);
    if (literalEnd !== undefined) { output += line.slice(index, literalEnd); index = literalEnd; continue; }
    if (line[index] === '\\' && /[!-/:-@[-`{-~]/.test(line[index + 1] ?? '')) {
      output += line.slice(index, index + 2);
      index += 2;
      continue;
    }
    const image = line.startsWith('![', index);
    const opening = image ? index + 1 : index;
    const end = line[opening] === '[' ? bracketEnd(line, opening) : -1;
    if (end === -1) { output += line[index++]; continue; }
    const label = line.slice(opening + 1, end);
    if (line[end + 1] === '(') {
      const inlineEnd = inlineDestinationEnd(line, end + 1);
      if (inlineEnd !== -1) {
        output += line.slice(index, inlineEnd + 1);
        index = inlineEnd + 1;
        continue;
      }
    }
    if (!image && label.startsWith('[') && label.endsWith(']')) {
      output += line.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (!image && label.startsWith('^')) {
      const id = footnotes.get(referenceKey(label.slice(1)))?.id;
      if (id) output += '[^' + id + ']';
      else {
        warnings.add('脚注引用缺少有效定义');
        output += line.slice(index, end + 1);
      }
      index = end + 1;
      continue;
    }
    const keyEnd = line[end + 1] === '[' && !line.startsWith('[^', end + 1) ? bracketEnd(line, end + 1) : -1;
    const key = keyEnd === -1 ? label : line.slice(end + 2, keyEnd) || label;
    const definition = links.get(referenceKey(key));
    if (definition && !/[<>\r\n]/.test(definition.destination)) {
      const title = definition.title === undefined ? '' : ' "' + definition.title.replace(/[\\"]/g, '\\$&') + '"';
      output += (image ? '!' : '') + '[' + label + '](<' + definition.destination + '>' + title + ')';
    } else {
      if (keyEnd !== -1 || definition) warnings.add('引用式链接或图片缺少有效定义');
      output += line.slice(index, (keyEnd === -1 ? end : keyEnd) + 1);
    }
    index = (keyEnd === -1 ? end : keyEnd) + 1;
  }
  return output;
}

function continuedFootnote(lines: MarkdownLine[], start: number, firstLine: string): { end: number; markdown: string } {
  const body = [firstLine];
  let end = start;
  let blanks = 0;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!.raw;
    if (!line.trim()) { blanks++; continue; }
    const continuation = /^(?: {4}|\t)(.*)$/.exec(line);
    if (!continuation) break;
    while (blanks > 0) { body.push(''); blanks--; }
    body.push(continuation[1]!);
    end = index;
  }
  return { end, markdown: body.join('\n') };
}

export function resolveMarkdownReferences(markdown: string, footnoteSlot?: (id: string) => string): { body: string; footnotes: Footnote[]; warnings: string[] } {
  const lines = markdownLines(markdown);
  const links = new Map<string, LinkDefinition>();
  const footnotes = new Map<string, Footnote>();
  const warnings = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.prefix || line.prose === null) continue;
    const note = footnoteStart.exec(line.prose);
    if (note) {
      const id = note[1]!.normalize('NFC');
      const key = referenceKey(id);
      const definition = continuedFootnote(lines, index, note[2]!);
      const start = index;
      if (!isFootnoteId(id) || footnotes.has(key)) warnings.add('脚注定义标识无效或重复');
      else {
        footnotes.set(key, { id, markdown: definition.markdown });
      }
      for (; index < definition.end; index++) lines[index] = { raw: '', prefix: '', prose: '' };
      lines[index] = { raw: '', prefix: '', prose: '' };
      if (footnoteSlot && isFootnoteId(id)) {
        const slot = '\n\n' + footnoteSlot(id) + '\n\n';
        lines[start] = { raw: slot, prefix: '', prose: slot };
      }
      continue;
    }
    const link = linkStart.exec(line.prose);
    if (link) {
      const key = referenceKey(link[1]!);
      const definition = linkDefinition(link[2]!);
      if (!key || !definition || links.has(key)) warnings.add('引用式链接定义无效或重复');
      else links.set(key, definition);
      lines[index] = { raw: '', prefix: '', prose: '' };
    }
  }
  const rewrite = (line: MarkdownLine) => line.prose === null ? line.raw : line.prefix + rewriteInline(line.prose, links, footnotes, warnings);
  const body = lines.map(rewrite).join('\n');
  return { body, footnotes: [...footnotes.values()].map(note => ({ ...note, markdown: markdownLines(note.markdown).map(rewrite).join('\n') })),
    warnings: [...warnings] };
}
