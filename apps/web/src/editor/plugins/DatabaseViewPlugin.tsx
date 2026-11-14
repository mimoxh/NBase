import { useEffect, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { mergeRegister } from '@lexical/utils';
import { COMMAND_PRIORITY_HIGH } from 'lexical';
import { Modal } from '../../components/Modal';
import { $insertEmbedBlock } from '../embedInsert';
import { $createDatabaseViewNode, INSERT_DATABASE_VIEW_COMMAND, REQUEST_DATABASE_VIEW_COMMAND,
  useDatabaseEmbedding } from '../nodes/DatabaseViewNode';

/** Inserts database view blocks; a new database is created by the host before the block appears. */
export function DatabaseViewPlugin() {
  const [editor] = useLexicalComposerContext();
  const embedding = useDatabaseEmbedding();
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => mergeRegister(
    editor.registerCommand(INSERT_DATABASE_VIEW_COMMAND, ({ databaseId, viewId }) => {
      if (!editor.isEditable()) return false;
      $insertEmbedBlock($createDatabaseViewNode(databaseId, viewId ?? null));
      return true;
    }, COMMAND_PRIORITY_HIGH),
    editor.registerCommand(REQUEST_DATABASE_VIEW_COMMAND, mode => {
      if (!editor.isEditable() || !embedding) return false;
      if (mode === 'link') { setFilter(''); setPicking(true); return true; }
      if (!embedding.createDatabase) return false;
      void embedding.createDatabase().then(id => {
        if (id) editor.update(() => { editor.dispatchCommand(INSERT_DATABASE_VIEW_COMMAND, { databaseId: id }); });
      });
      return true;
    }, COMMAND_PRIORITY_HIGH),
  ), [editor, embedding]);

  if (!picking || !embedding) return null;
  const q = filter.trim().toLocaleLowerCase();
  const choices = (embedding.databases ?? []).filter(item => (item.title || '未命名数据库').toLocaleLowerCase().includes(q));
  return <Modal title="插入已有数据库" onClose={() => setPicking(false)}>
    <input className="nb-db-input" autoFocus aria-label="搜索数据库" placeholder="搜索数据库" value={filter}
      onChange={event => setFilter(event.target.value)} />
    <div className="nb-db-picker-list">
      {choices.map(item => <button key={item.id} className="nb-db-option" onClick={() => {
        setPicking(false);
        editor.update(() => { editor.dispatchCommand(INSERT_DATABASE_VIEW_COMMAND, { databaseId: item.id }); });
      }}><span>{item.icon ?? '🗃️'} {item.title || '未命名数据库'}</span></button>)}
      {!choices.length && <p className="nb-db-empty-note">{embedding.databases?.length ? '没有匹配的数据库。' : '工作区里还没有数据库。'}</p>}
    </div>
  </Modal>;
}
