import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { mergeRegister } from '@lexical/utils';
import {
  $getNearestNodeFromDOMNode, $getNodeByKey, $getSelection, $isRangeSelection, COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND, KEY_ARROW_UP_COMMAND, KEY_DOWN_COMMAND,
} from 'lexical';
import type { LexicalNode, NodeKey } from 'lexical';
import {
  $canConvertBlock, $canDuplicateBlock, $deleteBlock, $duplicateBlock, $moveBlockBy, $moveBlockTo, $selectWholeBlock,
  $topLevelBlock, type BlockPlacement,
} from '../blockActions';
import { $applyBlockStyle, type BlockStyle } from '../blockStyles';
import './blockHandle.css';

type Props = { onBeforeMove?: ((element: HTMLElement) => void) | undefined };
type Hover = { key: NodeKey; top: number };
type Menu = { key: NodeKey; top: number; canConvert: boolean; canCopy: boolean };
type DropTarget = { key: NodeKey; placement: BlockPlacement; top: number };

const styles: [BlockStyle, string][] = [
  ['paragraph', '正文'], ['h1', '标题 1'], ['h2', '标题 2'], ['h3', '标题 3'], ['bullet', '项目列表'],
  ['number', '编号列表'], ['check', '待办列表'], ['quote', '引用'], ['code', '代码块'],
];

/** A hover handle for top-level blocks: drag to reorder, click for the block menu. */
export function BlockHandlePlugin({ onBeforeMove }: Props) {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const [hover, setHover] = useState<Hover | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [line, setLine] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dragged = useRef<NodeKey | null>(null);
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  useEffect(() => editor.registerRootListener(root => setSurface(root?.parentElement ?? null)), [editor]);
  const beforeMove = useRef(onBeforeMove);
  beforeMove.current = onBeforeMove;

  const offsetTop = useCallback((element: HTMLElement) => {
    const parent = editor.getRootElement()?.parentElement;
    return parent ? element.getBoundingClientRect().top - parent.getBoundingClientRect().top : 0;
  }, [editor]);

  const visible = useCallback((node: LexicalNode) => {
    const element = editor.getElementByKey(node.getKey());
    return Boolean(element && !element.hasAttribute('data-nbase-folded'));
  }, [editor]);

  /** A block's fold follows the heading, so its section opens before the heading moves away. */
  const unfold = useCallback((key: NodeKey) => {
    const element = editor.getElementByKey(key);
    if (element) beforeMove.current?.(element);
  }, [editor]);

  const blockElementAt = useCallback((y: number): HTMLElement | null => {
    const root = editor.getRootElement();
    if (!root) return null;
    const x = root.getBoundingClientRect().left + 2;
    let element = document.elementFromPoint(x, y);
    while (element && element.parentElement !== root) element = element.parentElement;
    return element instanceof HTMLElement ? element : null;
  }, [editor]);

  useEffect(() => {
    const parent = surface?.parentElement;
    if (!parent || !editable) return;
    let frame = 0;
    const onMove = (event: MouseEvent) => {
      const { clientY } = event;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (dragged.current || editor.isComposing()) return;
        const element = blockElementAt(clientY);
        if (!element) return;
        const key = editor.read('latest', () => {
          const node = $getNearestNodeFromDOMNode(element);
          return node ? $topLevelBlock(node)?.getKey() ?? null : null;
        });
        if (key) setHover({ key, top: offsetTop(element) });
      });
    };
    const onLeave = () => { if (!dragged.current) setHover(null); };
    parent.addEventListener('mousemove', onMove);
    parent.addEventListener('mouseleave', onLeave);
    return () => {
      cancelAnimationFrame(frame);
      parent.removeEventListener('mousemove', onMove);
      parent.removeEventListener('mouseleave', onLeave);
    };
  }, [blockElementAt, editable, editor, offsetTop, surface]);

  useEffect(() => {
    const move = (direction: -1 | 1) => (event: KeyboardEvent) => {
      if (!event.altKey || !event.shiftKey || !editor.isEditable()) return false;
      const selection = $getSelection();
      const block = $isRangeSelection(selection) ? $topLevelBlock(selection.anchor.getNode()) : null;
      if (!block) return false;
      event.preventDefault();
      unfold(block.getKey());
      $moveBlockBy(block, direction, visible);
      return true;
    };
    return mergeRegister(
      editor.registerCommand(KEY_ARROW_UP_COMMAND, move(-1), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, move(1), COMMAND_PRIORITY_HIGH),
      // Typing hides the handle so it never sits beside the caret.
      editor.registerCommand(KEY_DOWN_COMMAND, () => { setHover(null); return false; }, COMMAND_PRIORITY_HIGH),
    );
  }, [editor, unfold, visible]);

  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node && menuRef.current?.contains(event.target))) setMenu(null);
    };
    document.addEventListener('pointerdown', onPointer);
    menuRef.current?.querySelector('button')?.focus();
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [menu]);

  const dropTargetAt = (event: DragEvent): DropTarget | null => {
    const root = editor.getRootElement();
    const key = dragged.current;
    if (!root || !key) return null;
    const bounds = root.getBoundingClientRect();
    if (event.clientX < bounds.left - 70 || event.clientX > bounds.right + 40) return null;
    const blocks = [...root.children].filter((item): item is HTMLElement => item instanceof HTMLElement
      && !item.hasAttribute('data-nbase-folded'));
    const first = blocks[0];
    const last = blocks.at(-1);
    if (!first || !last) return null;
    const element = event.clientY < first.getBoundingClientRect().top ? first
      : event.clientY > last.getBoundingClientRect().bottom ? last
        : blockElementAt(event.clientY) ?? blocks.find(item => event.clientY <= item.getBoundingClientRect().bottom) ?? last;
    const rect = element.getBoundingClientRect();
    const placement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const target = editor.read('latest', () => {
      const node = $getNearestNodeFromDOMNode(element);
      return node ? $topLevelBlock(node)?.getKey() ?? null : null;
    });
    if (!target) return null;
    return { key: target, placement, top: offsetTop(element) + (placement === 'after' ? rect.height : 0) };
  };

  const startDrag = (event: React.DragEvent<HTMLButtonElement>) => {
    if (!hover) return;
    unfold(hover.key);
    dragged.current = hover.key;
    setMenu(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-nbase-block', hover.key);
    const element = editor.getElementByKey(hover.key);
    if (element) event.dataTransfer.setDragImage(element, 0, 0);
    const finish = () => {
      document.removeEventListener('dragover', onOver, true);
      document.removeEventListener('drop', onDrop, true);
      document.removeEventListener('dragend', finish, true);
      dragged.current = null;
      setLine(null);
    };
    const onOver = (dragEvent: DragEvent) => {
      const target = dropTargetAt(dragEvent);
      setLine(target?.top ?? null);
      if (!target) return;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = 'move';
    };
    const onDrop = (dragEvent: DragEvent) => {
      const target = dropTargetAt(dragEvent);
      const key = dragged.current;
      // Capturing keeps this drop away from the editor's own text-drop handling.
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      if (target && key) editor.update(() => {
        const block = $getNodeByKey(key);
        const destination = $getNodeByKey(target.key);
        if (block && destination) $moveBlockTo(block, destination, target.placement);
      });
      finish();
    };
    document.addEventListener('dragover', onOver, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dragend', finish, true);
  };

  const openMenu = () => {
    if (!hover) return;
    const info = editor.read('latest', () => {
      const block = $getNodeByKey(hover.key);
      return block ? { canConvert: $canConvertBlock(block), canCopy: $canDuplicateBlock(block) } : null;
    });
    if (info) setMenu({ ...hover, ...info });
  };

  const run = (action: (block: LexicalNode) => void) => {
    const key = menu?.key;
    setMenu(null);
    setHover(null);
    if (!key) return;
    editor.update(() => {
      const block = $getNodeByKey(key);
      if (block) action(block);
    });
    editor.focus();
  };
  const moveMenuBlock = (direction: -1 | 1) => {
    if (menu) unfold(menu.key);
    run(block => { $moveBlockBy(block, direction, visible); });
  };
  const convert = (style: BlockStyle) => run(block => {
    $selectWholeBlock(block);
    $applyBlockStyle(editor, style);
  });

  if (!surface || !editable) return null;
  return createPortal(<>
    {hover && <button type="button" className="nbase-block-handle" aria-label="拖动移动，单击打开块菜单" title="拖动移动，单击打开块菜单"
      aria-haspopup="menu" aria-expanded={Boolean(menu)} draggable style={{ top: hover.top }}
      onMouseDown={event => { if (event.button !== 0) event.preventDefault(); }}
      onDragStart={startDrag} onClick={openMenu}><span aria-hidden="true">⠿</span></button>}
    {line !== null && <div className="nbase-block-drop-line" style={{ top: line }} />}
    {menu && <div ref={menuRef} className="nbase-block-menu" role="menu" aria-label="块操作" style={{ top: menu.top + 26 }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); setMenu(null); editor.focus(); }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }}>
      <button type="button" role="menuitem" onClick={() => moveMenuBlock(-1)}>上移</button>
      <button type="button" role="menuitem" onClick={() => moveMenuBlock(1)}>下移</button>
      <button type="button" role="menuitem" disabled={!menu.canCopy}
        title={menu.canCopy ? undefined : '脚注定义不能复制'} onClick={() => run(block => { $duplicateBlock(block); })}>复制</button>
      <button type="button" role="menuitem" className="is-danger" onClick={() => run($deleteBlock)}>删除</button>
      {menu.canConvert && <>
        <div className="nbase-block-menu-label">转换为</div>
        {styles.map(([style, label]) => <button key={style} type="button" role="menuitem" onClick={() => convert(style)}>{label}</button>)}
      </>}
    </div>}
  </>, surface);
}
