import { useEffect, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $getSelection, $isRangeSelection } from 'lexical';
import { countText, type TextCount } from '../wordCount';

const delay = 400;

/** Counts after typing pauses, so a long document pays nothing per keystroke. */
export function WordCountPlugin() {
  const [editor] = useLexicalComposerContext();
  const [total, setTotal] = useState<TextCount>({ words: 0, characters: 0, minutes: 0 });
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    let timer: number | undefined;
    const measure = () => editor.read('latest', () => {
      setTotal(countText($getRoot().getTextContent()));
      const selection = $getSelection();
      setSelected($isRangeSelection(selection) && !selection.isCollapsed() ? countText(selection.getTextContent()).words : 0);
    });
    measure();
    const stop = editor.registerUpdateListener(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, delay);
    });
    return () => { window.clearTimeout(timer); stop(); };
  }, [editor]);
  return <div className="nbase-word-count" role="status" aria-label="字数统计">
    {selected > 0 && <span>已选 {selected.toLocaleString()} 字</span>}
    <span>{total.words.toLocaleString()} 字</span>
    <span>{total.characters.toLocaleString()} 字符</span>
    {total.minutes > 0 && <span>约 {total.minutes} 分钟读完</span>}
  </div>;
}
