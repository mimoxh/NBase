import { useEffect, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { mergeRegister } from '@lexical/utils';
import { COMMAND_PRIORITY_HIGH } from 'lexical';
import { Modal } from '../../components/Modal';
import { useEmbeddedPages } from '../../embed/source';
import { $insertEmbedBlock } from '../embedInsert';
import { $createWhiteboardViewNode, INSERT_WHITEBOARD_VIEW_COMMAND, REQUEST_WHITEBOARD_VIEW_COMMAND } from '../nodes/WhiteboardViewNode';

/** Inserts whiteboard blocks; a new whiteboard is created by the host before the block appears. */
export function WhiteboardViewPlugin({ documentId }: { documentId: string }) {
  const [editor] = useLexicalComposerContext();
  const embeds = useEmbeddedPages();
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => mergeRegister(
    editor.registerCommand(INSERT_WHITEBOARD_VIEW_COMMAND, ({ pageId }) => {
      if (!editor.isEditable()) return false;
      $insertEmbedBlock($createWhiteboardViewNode(pageId));
      return true;
    }, COMMAND_PRIORITY_HIGH),
    editor.registerCommand(REQUEST_WHITEBOARD_VIEW_COMMAND, mode => {
      if (!editor.isEditable() || !embeds) return false;
      if (mode === 'link') { setFilter(''); setPicking(true); return true; }
      if (!embeds.createWhiteboard) return false;
      void embeds.createWhiteboard().then(id => {
        if (id) editor.update(() => { editor.dispatchCommand(INSERT_WHITEBOARD_VIEW_COMMAND, { pageId: id }); });
      });
      return true;
    }, COMMAND_PRIORITY_HIGH),
  ), [editor, embeds]);

  if (!picking || !embeds) return null;
  const q = filter.trim().toLocaleLowerCase();
  const boards = embeds.pages.filter(page => page.kind === 'whiteboard' && page.id !== documentId);
  const choices = boards.filter(item => (item.title || '未命名白板').toLocaleLowerCase().includes(q));
  return <Modal title="插入已有白板" onClose={() => setPicking(false)}>
    <input className="nb-db-input" autoFocus aria-label="搜索白板" placeholder="搜索白板" value={filter}
      onChange={event => setFilter(event.target.value)} />
    <div className="nb-embed-picker">
      {choices.map(item => <button key={item.id} className="nb-db-option" onClick={() => {
        setPicking(false);
        editor.update(() => { editor.dispatchCommand(INSERT_WHITEBOARD_VIEW_COMMAND, { pageId: item.id }); });
      }}><span>{item.icon ?? '🎨'} {item.title || '未命名白板'}</span></button>)}
      {!choices.length && <p className="nb-db-empty-note">{boards.length ? '没有匹配的白板。' : '工作区里还没有白板。'}</p>}
    </div>
  </Modal>;
}
