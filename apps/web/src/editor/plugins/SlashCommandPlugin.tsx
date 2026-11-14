import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { LexicalTypeaheadMenuPlugin, MenuOption } from '@lexical/react/LexicalTypeaheadMenuPlugin';
import type { MenuRenderFn, MenuTextMatch } from '@lexical/react/LexicalTypeaheadMenuPlugin';
import { $getSelection, $isParagraphNode, $isRangeSelection, $isTextNode, COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from 'lexical';
import { $isCodeNode } from '@lexical/code';
import type { LexicalEditor, TextNode } from 'lexical';
import { $getTableCellNodeFromLexicalNode, INSERT_TABLE_COMMAND } from '@lexical/table';
import { INSERT_HORIZONTAL_RULE_COMMAND } from '@lexical/react/LexicalHorizontalRuleNode';
import { $applyBlockStyle } from '../blockStyles';
import type { BlockStyle } from '../blockStyles';
import { $createEquationNode, $insertEquationNode, $requestEquationEdit } from '../nodes/EquationNode';
import { $applyCallout, calloutLabels } from '../nodes/CalloutNode';
import { $applyToggle } from '../nodes/ToggleNode';
import { REQUEST_BOOKMARK_COMMAND } from '../nodes/BookmarkNode';
import { INSERT_MERMAID_COMMAND } from '../nodes/MermaidNode';
import { REQUEST_DATABASE_VIEW_COMMAND, useDatabaseEmbedding } from '../nodes/DatabaseViewNode';
import { REQUEST_WHITEBOARD_VIEW_COMMAND } from '../nodes/WhiteboardViewNode';
import { useEmbeddedPages } from '../../embed/source';
import { calloutKinds, type CalloutKind } from '@nbase/contracts';
import type { AttachmentPickKind } from '../types';

type SlashAction =
  | { kind: 'block'; value: BlockStyle }
  | { kind: 'hr' }
  | { kind: 'table' }
  | { kind: 'mermaid' }
  | { kind: 'toggle' }
  | { kind: 'bookmark' }
  | { kind: 'database'; mode: 'new' | 'link' }
  | { kind: 'whiteboard'; mode: 'new' | 'link' }
  | { kind: 'attachment'; value: AttachmentPickKind }
  | { kind: 'callout'; value: CalloutKind }
  | { kind: 'equation'; inline: boolean };

type SlashCommand = {
  key: string; label: string; hint: string; keywords: string[]; action: SlashAction; hideInTable?: boolean;
};

const COMMANDS: SlashCommand[] = [
  { key: 'paragraph', label: '正文', hint: '普通段落', keywords: ['text', 'paragraph', 'p', '正文', '段落', 'zhengwen', 'zw', 'duanluo', 'dl'], action: { kind: 'block', value: 'paragraph' } },
  { key: 'h1', label: '标题 1', hint: '# 大标题', keywords: ['h1', 'heading1', 'heading', '标题', '一级标题', 'biaoti', 'bt', 'bt1', 'yijibiaoti', 'yjbt'], action: { kind: 'block', value: 'h1' } },
  { key: 'h2', label: '标题 2', hint: '## 小节标题', keywords: ['h2', 'heading2', 'heading', '标题', '二级标题', 'biaoti', 'bt', 'bt2', 'erjibiaoti', 'ejbt'], action: { kind: 'block', value: 'h2' } },
  { key: 'h3', label: '标题 3', hint: '### 子标题', keywords: ['h3', 'heading3', 'heading', '标题', '三级标题', 'biaoti', 'bt', 'bt3', 'sanjibiaoti', 'sjbt'], action: { kind: 'block', value: 'h3' } },
  { key: 'bullet', label: '项目列表', hint: '- 无序列表', keywords: ['ul', 'bullet', 'list', '列表', '无序列表', 'xiangmuliebiao', 'xmlb', 'liebiao', 'lb', 'wuxuliebiao', 'wxlb'], action: { kind: 'block', value: 'bullet' } },
  { key: 'number', label: '编号列表', hint: '1. 有序列表', keywords: ['ol', 'number', 'numbered', 'list', '列表', '有序列表', '编号', 'bianhaoliebiao', 'bhlb', 'liebiao', 'lb', 'youxuliebiao', 'yxlb', 'bianhao', 'bh'], action: { kind: 'block', value: 'number' } },
  { key: 'check', label: '待办列表', hint: '[ ] 任务清单', keywords: ['todo', 'check', 'task', '待办', '任务', 'daiban', 'daibanliebiao', 'renwu', 'rw'], action: { kind: 'block', value: 'check' } },
  { key: 'quote', label: '引用', hint: '> 引用文字', keywords: ['quote', 'blockquote', '引用', 'yinyong', 'yy'], action: { kind: 'block', value: 'quote' } },
  { key: 'code', label: '代码块', hint: '``` 代码', keywords: ['code', 'codeblock', '代码', 'daima', 'dm', 'daimakuai', 'dmk'], action: { kind: 'block', value: 'code' } },
  { key: 'hr', label: '分割线', hint: '--- 水平线', keywords: ['hr', 'divider', 'line', '分割线', '分隔线', 'fengexian', 'fgx'], action: { kind: 'hr' } },
  { key: 'table', label: '表格', hint: '3 × 3 表格', keywords: ['table', '表格', 'biaoge', 'bg'], action: { kind: 'table' }, hideInTable: true },
  { key: 'toggle', label: '折叠块', hint: '可展开和收起的内容', keywords: ['toggle', 'details', 'collapse', 'fold', '折叠', '折叠块', '收起', 'zhedie', 'zhediekuai', 'zd', 'zdk'], action: { kind: 'toggle' }, hideInTable: true },
  { key: 'bookmark', label: '网页书签', hint: '网址卡片，显示标题和简介', keywords: ['bookmark', 'link', 'url', 'web', '书签', '网页', '链接卡片', 'shuqian', 'sq', 'wangye', 'wy'], action: { kind: 'bookmark' }, hideInTable: true },
  { key: 'mermaid', label: '图表', hint: 'Mermaid 流程图或时序图', keywords: ['mermaid', 'diagram', '图表', '流程图', '时序图', 'tubiao', 'tb', 'liuchengtu', 'lct', 'shixutu', 'sxt'], action: { kind: 'mermaid' }, hideInTable: true },
  { key: 'database', label: '数据库', hint: '新建多维表格并插入视图', keywords: ['database', 'db', 'table', '数据库', '多维表格', '表格视图', 'shujuku', 'sjk', 'duoweibiaoge', 'dwbg'],
    action: { kind: 'database', mode: 'new' }, hideInTable: true },
  { key: 'database-link', label: '关联数据库', hint: '插入已有数据库的视图', keywords: ['database', 'link', 'db', '数据库', '关联', '多维表格', 'guanlianshujuku', 'glsjk', 'shujuku', 'sjk', 'guanlian', 'gl'],
    action: { kind: 'database', mode: 'link' }, hideInTable: true },
  { key: 'whiteboard', label: '白板', hint: '新建白板并嵌入正文', keywords: ['whiteboard', 'board', 'canvas', '白板', '画布', '画板', 'baiban', 'bb', 'huabu', 'hb'],
    action: { kind: 'whiteboard', mode: 'new' }, hideInTable: true },
  { key: 'whiteboard-link', label: '关联白板', hint: '嵌入已有白板', keywords: ['whiteboard', 'link', 'board', '白板', '关联', '画布', 'guanlianbaiban', 'glbb', 'baiban', 'bb', 'guanlian', 'gl'],
    action: { kind: 'whiteboard', mode: 'link' }, hideInTable: true },
  { key: 'image', label: '图片', hint: '上传图片', keywords: ['image', 'img', 'picture', 'photo', '图片', '图像', '照片', 'tupian', 'tp', 'tuxiang', 'zhaopian'], action: { kind: 'attachment', value: 'image' } },
  { key: 'attachment', label: '附件', hint: '上传文件', keywords: ['file', 'attachment', 'upload', '附件', '文件', '上传', 'fujian', 'fj', 'wenjian', 'wj', 'shangchuan', 'sc'], action: { kind: 'attachment', value: 'file' } },
  ...calloutKinds.map((kind): SlashCommand => ({
    key: 'callout-' + kind, label: '提示 · ' + calloutLabels[kind], hint: '提示块',
    keywords: ['提示', 'callout', kind, 'tishi', 'ts'], action: { kind: 'callout', value: kind }, hideInTable: true,
  })),
  { key: 'equation-block', label: '块级公式', hint: '$$ LaTeX', keywords: ['math', 'equation', 'formula', 'latex', 'block', '公式', '块级公式', 'gongshi', 'gs', 'kuaijigongshi', 'kjgs'], action: { kind: 'equation', inline: false }, hideInTable: true },
  { key: 'equation-inline', label: '行内公式', hint: '$ LaTeX', keywords: ['inline', 'math', 'equation', 'formula', 'latex', '公式', '行内公式', 'gongshi', 'gs', 'hangneigongshi', 'hngs'], action: { kind: 'equation', inline: true } },
];

class SlashOption extends MenuOption {
  label: string;
  hint: string;
  command: SlashCommand;
  constructor(command: SlashCommand) {
    super(command.key);
    this.command = command;
    this.label = command.label;
    this.hint = command.hint;
    this.title = command.label;
  }
}

function rank(command: SlashCommand, query: string): number {
  if (!query) return 0;
  for (const haystack of [command.label, ...command.keywords]) {
    const index = haystack.toLowerCase().indexOf(query);
    if (index === 0) return 0;
    if (index > 0) return 1;
  }
  return Number.POSITIVE_INFINITY;
}

export function filterSlashCommands(query: string, inTable: boolean, canUpload = false, canDatabase = false,
  whiteboards: 'none' | 'link' | 'all' = 'none'): SlashCommand[] {
  const q = query.trim().toLowerCase();
  return COMMANDS
    .map((command, index) => ({ command, index, order: rank(command, q) }))
    .filter(item => item.order < Infinity && !(inTable && item.command.hideInTable)
      && (canUpload || item.command.action.kind !== 'attachment')
      && (canDatabase || item.command.action.kind !== 'database')
      && (item.command.action.kind !== 'whiteboard' || whiteboards === 'all' || (whiteboards === 'link' && item.command.action.mode === 'link')))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(item => item.command);
}

// `/` or `、` at a text-node start or after whitespace, then up to 20
// non-space, non-trigger characters. `a/b` and 苹果、香蕉 never match.
const TRIGGER = /(?:^|\s)[\/、]([^\s\/、]{0,20})$/;

export function slashTriggerMatch(text: string, editor: LexicalEditor): MenuTextMatch | null {
  if (!editor.isEditable()) return null;
  const match = TRIGGER.exec(text);
  if (!match) return null;
  const blocked = editor.read('latest', () => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return true;
    const node = selection.anchor.getNode();
    if ($isTextNode(node) && node.hasFormat('code')) return true;
    for (let parent = node.getParent(); parent; parent = parent.getParent()) {
      if ($isCodeNode(parent)) return true;
    }
    return false;
  });
  if (blocked) return null;
  // match[0] may carry one leading whitespace before the trigger character.
  const leadOffset = match.index + (/\s/.test(match[0][0] ?? '') ? 1 : 0);
  return { leadOffset, matchingString: match[1] ?? '', replaceableString: text.slice(leadOffset) };
}

function selectionInTable(editor: LexicalEditor): boolean {
  return editor.read('latest', () => {
    const selection = $getSelection();
    return $isRangeSelection(selection) && Boolean($getTableCellNodeFromLexicalNode(selection.anchor.getNode()));
  });
}

const menuRender: MenuRenderFn<SlashOption> = (anchorElementRef, itemProps) => {
  if (!anchorElementRef.current || !itemProps.options.length) return null;
  return createPortal(
    <ul className="nbase-slash-menu" role="listbox" aria-label="编辑命令">
      {itemProps.options.map((option, index) => (
        <li key={option.key} ref={option.setRefElement.bind(option)} role="option"
          aria-selected={index === itemProps.selectedIndex}
          className={index === itemProps.selectedIndex ? 'is-selected' : ''}
          onMouseDown={event => event.preventDefault()}
          onMouseEnter={() => itemProps.setHighlightedIndex(index)}
          onClick={() => itemProps.selectOptionAndCleanUp(option)}>
          <span>{option.label}</span><small>{option.hint}</small>
        </li>))}
    </ul>, anchorElementRef.current);
};

/** `/` or `、` opens a block-style command menu; queries match labels and aliases. */
export function SlashCommandPlugin({ onPickAttachment }: { onPickAttachment?: ((kind: AttachmentPickKind) => void) | undefined }) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const pickAttachment = useRef(onPickAttachment);
  pickAttachment.current = onPickAttachment;
  const canUpload = Boolean(onPickAttachment);
  const canDatabase = Boolean(useDatabaseEmbedding());
  const embeds = useEmbeddedPages();
  const whiteboards = !embeds ? 'none' : embeds.createWhiteboard ? 'all' : 'link';
  const options = useMemo(
    () => filterSlashCommands(query ?? '', selectionInTable(editor), canUpload, canDatabase, whiteboards).map(command => new SlashOption(command)),
    [canUpload, canDatabase, whiteboards, editor, query]);

  const selectOption = useCallback((option: SlashOption, nodeToRemove: TextNode | null, closeMenu: () => void) => {
    editor.update(() => {
      const { action } = option.command;
      // Inline equations replace the trigger text node directly so they land
      // exactly where typed; other commands remove the trigger text first.
      if (action.kind === 'equation' && action.inline && nodeToRemove) {
        const equation = nodeToRemove.replace($createEquationNode('', true));
        equation.selectNext();
        $requestEquationEdit(equation);
        closeMenu();
        return;
      }
      const tableTriggerParagraph = action.kind === 'table' ? nodeToRemove?.getParent() : null;
      nodeToRemove?.remove();
      if (action.kind === 'block') $applyBlockStyle(editor, action.value);
      else if (action.kind === 'hr') editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined);
      else if (action.kind === 'table') {
        const inserted = editor.dispatchCommand(INSERT_TABLE_COMMAND, { columns: '3', rows: '3', includeHeaders: { rows: true, columns: false } });
        // Consume the command's own now-empty paragraph, retaining the new
        // paragraph after the table so the user can move out of its last cell.
        if (inserted && $isParagraphNode(tableTriggerParagraph) && tableTriggerParagraph.isAttached()
          && tableTriggerParagraph.isEmpty()) tableTriggerParagraph.remove();
      }
      else if (action.kind === 'mermaid') editor.dispatchCommand(INSERT_MERMAID_COMMAND, undefined);
      else if (action.kind === 'database') editor.dispatchCommand(REQUEST_DATABASE_VIEW_COMMAND, action.mode);
      else if (action.kind === 'whiteboard') editor.dispatchCommand(REQUEST_WHITEBOARD_VIEW_COMMAND, action.mode);
      else if (action.kind === 'callout') $applyCallout(action.value);
      else if (action.kind === 'toggle') $applyToggle();
      else if (action.kind === 'bookmark') editor.dispatchCommand(REQUEST_BOOKMARK_COMMAND, undefined);
      else if (action.kind === 'attachment') { /* The file picker opens after this update. */ }
      else $requestEquationEdit($insertEquationNode('', false));
      closeMenu();
    });
    // Still inside the key or click activation that browsers require for a file picker.
    if (option.command.action.kind === 'attachment') pickAttachment.current?.(option.command.action.value);
  }, [editor]);

  useEffect(() => editor.registerCommand(KEY_ENTER_COMMAND, event => {
    // During IME composition Enter confirms the candidate, never a menu item.
    if (editor.isComposing() || (event && (event.isComposing || event.keyCode === 229))) {
      event?.preventDefault();
      return true;
    }
    return false;
  }, COMMAND_PRIORITY_HIGH), [editor]);

  return <LexicalTypeaheadMenuPlugin<SlashOption>
    options={options}
    triggerFn={text => slashTriggerMatch(text, editor)}
    onQueryChange={setQuery}
    onSelectOption={selectOption}
    menuRenderFn={menuRender}
    anchorClassName="nbase-slash-anchor"
    preselectFirstItem />;
}
