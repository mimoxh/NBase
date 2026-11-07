import { useEffect, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { COMMAND_PRIORITY_NORMAL, KEY_DOWN_COMMAND } from 'lexical';
import { Modal } from '../../components/Modal';
import { $applyBlockStyle, type BlockStyle } from '../blockStyles';

/** `code` values, so layouts and input methods that remap digits keep working. */
const blockKeys: Record<string, BlockStyle> = {
  Digit0: 'paragraph', Digit1: 'h1', Digit2: 'h2', Digit3: 'h3', Digit4: 'bullet',
  Digit5: 'number', Digit6: 'check', Digit7: 'quote', Digit8: 'code',
};

const help: [string, string][] = [
  ['Ctrl/Cmd+B / I', '粗体 / 斜体'],
  ['Ctrl/Cmd+Z / Shift+Z', '撤销 / 重做'],
  ['Ctrl/Cmd+Alt+0～3', '正文、标题 1～3'],
  ['Ctrl/Cmd+Alt+4 / 5 / 6', '项目列表 / 编号列表 / 待办'],
  ['Ctrl/Cmd+Alt+7 / 8', '引用 / 代码块'],
  ['Tab / Shift+Tab', '列表缩进 / 减少缩进'],
  ['Alt+Shift+↑ / ↓', '上移 / 下移当前块'],
  ['/ 或 、', '打开命令菜单'],
  ['Ctrl/Cmd+单击', '打开链接'],
  ['Ctrl/Cmd+F', '页内查找'],
  ['Ctrl/Cmd+K', '搜索页面'],
  ['Ctrl/Cmd+\\', '收起或展开侧栏'],
  ['Ctrl/Cmd+/', '显示本帮助'],
];

export function blockStyleForKey(event: Pick<KeyboardEvent, 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): BlockStyle | null {
  if (!event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return null;
  return blockKeys[event.code] ?? null;
}

/** Block style keys and the shortcut help. */
export function ShortcutsPlugin() {
  const [editor] = useLexicalComposerContext();
  const [open, setOpen] = useState(false);
  useEffect(() => editor.registerCommand(KEY_DOWN_COMMAND, event => {
    if (event.isComposing || editor.isComposing()) return false;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === '/') {
      event.preventDefault();
      setOpen(true);
      return true;
    }
    const style = blockStyleForKey(event);
    if (!style) return false;
    event.preventDefault();
    $applyBlockStyle(editor, style);
    return true;
  }, COMMAND_PRIORITY_NORMAL), [editor]);
  if (!open) return null;
  return <Modal title="键盘快捷键" onClose={() => { setOpen(false); editor.focus(); }}>
    <dl className="nbase-shortcut-list">
      {help.map(([keys, label]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{label}</dd></div>)}
    </dl>
  </Modal>;
}
