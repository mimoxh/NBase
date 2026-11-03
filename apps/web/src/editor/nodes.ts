import { CodeHighlightNode, CodeNode } from '@lexical/code';
import { AutoLinkNode, LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import { HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { ImageReferenceNode } from './nodes/ImageReferenceNode';
import { AttachmentNode } from './nodes/AttachmentNode';

/** The same registry is used for the UI, Markdown import and JSON reopening. */
export const EDITOR_NODES = [
  HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, CodeHighlightNode,
  LinkNode, AutoLinkNode, TableNode, TableRowNode, TableCellNode,
  HorizontalRuleNode, ImageReferenceNode, AttachmentNode,
];
