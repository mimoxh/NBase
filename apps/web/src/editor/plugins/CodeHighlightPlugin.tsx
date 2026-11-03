import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { PrismTokenizer, registerCodeHighlighting } from '@lexical/code-prism';
import '../prism-languages';

// A null default language keeps fence-less and unknown-language blocks
// untouched: the tokenizer never rewrites the stored language, so merely
// opening a document cannot change what a snapshot serializes.
const tokenizer = { ...PrismTokenizer, defaultLanguage: null };

/** Prism highlighting, gutter line numbers and code-block Tab indentation; also active in read-only previews. */
export function CodeHighlightPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerCodeHighlighting(editor, tokenizer), [editor]);
  return null;
}
