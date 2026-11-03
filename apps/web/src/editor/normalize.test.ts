import { describe, expect, it } from 'vitest';
import { normalizeDocumentContent } from './normalize';
import { createContentFromMarkdown } from './markdown';
import type { DocumentContent } from './types';

const text = (t: string) => ({ type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text: t, version: 1 });
const highlight = (t: string, type = 'keyword') => ({ ...text(t), type: 'code-highlight', highlightType: type });
const linebreak = () => ({ type: 'linebreak', version: 1 });
const tab = () => ({ type: 'tab', version: 1 });

function doc(children: unknown[]): DocumentContent {
  return { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children } } } as unknown as DocumentContent;
}
const codeBlock = (children: unknown[], language?: string) => ({
  type: 'code', version: 1, format: '', indent: 0, direction: null, language, children,
});
const paragraph = (children: unknown[]) => ({ type: 'paragraph', version: 1, children });

describe('normalizeDocumentContent', () => {
  it('is idempotent and leaves non-code content untouched', () => {
    const content = doc([paragraph([text('普通文字')])]);
    expect(normalizeDocumentContent(content)).toEqual(content);
    const once = normalizeDocumentContent(doc([codeBlock([text('a'), linebreak(), text('b')])]));
    expect(normalizeDocumentContent(once)).toEqual(once);
  });

  it('normalizes highlighted tokens and tab/linebreak structure to text+linebreak', () => {
    const highlighted = doc([codeBlock([highlight('const'), text(' '), highlight('x'), text(' = 1'), linebreak(), tab(), text('return x')], 'javascript')]);
    const singleText = doc([codeBlock([text('const x = 1\n\treturn x')], 'javascript')]);
    const canonical = doc([codeBlock([text('const x = 1'), linebreak(), text('\treturn x')], 'javascript')]);
    expect(normalizeDocumentContent(highlighted)).toEqual(canonical);
    expect(normalizeDocumentContent(singleText)).toEqual(canonical);
    expect(normalizeDocumentContent(highlighted)).toEqual(normalizeDocumentContent(singleText));
  });

  it('drops empty text nodes but keeps blank lines as consecutive linebreaks', () => {
    const input = doc([codeBlock([text('a'), linebreak(), linebreak(), text('b')])]);
    expect(normalizeDocumentContent(input)).toEqual(doc([codeBlock([text('a'), linebreak(), linebreak(), text('b')])]));
    const withEmpties = doc([codeBlock([text(''), text('x'), linebreak(), text('')])]);
    expect(normalizeDocumentContent(withEmpties)).toEqual(doc([codeBlock([text('x'), linebreak()])]));
  });

  it('recurses into code blocks nested inside other elements', () => {
    const quote = { type: 'quote', version: 1, children: [codeBlock([highlight('let'), text(' a')])] };
    expect(normalizeDocumentContent(doc([quote]))).toEqual(doc([{ ...quote, children: [codeBlock([text('let a')])] }]));
  });
});
