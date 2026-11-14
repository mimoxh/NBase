import { CodeHighlightNode, CodeNode } from '@lexical/code';
import { AutoLinkNode, LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import { HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { ImageReferenceNode } from './nodes/ImageReferenceNode';
import { AttachmentNode } from './nodes/AttachmentNode';
import { EquationNode } from './nodes/EquationNode';
import { CalloutNode } from './nodes/CalloutNode';
import { PageReferenceNode } from './nodes/PageReferenceNode';
import { FootnoteDefinitionNode, FootnoteReferenceNode } from './nodes/FootnoteNodes';
import { MermaidNode } from './nodes/MermaidNode';
import { DatabaseViewNode } from './nodes/DatabaseViewNode';
import { WhiteboardViewNode } from './nodes/WhiteboardViewNode';
import { ToggleNode } from './nodes/ToggleNode';
import { BookmarkNode } from './nodes/BookmarkNode';
import { BlockReferenceNode } from './nodes/BlockReferenceNode';

/** The same registry is used for the UI, Markdown import and JSON reopening. */
export const EDITOR_NODES = [
  HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, CodeHighlightNode,
  LinkNode, AutoLinkNode, TableNode, TableRowNode, TableCellNode,
  HorizontalRuleNode, ImageReferenceNode, AttachmentNode, EquationNode, CalloutNode, PageReferenceNode,
  FootnoteDefinitionNode, FootnoteReferenceNode, MermaidNode, DatabaseViewNode, WhiteboardViewNode, ToggleNode, BookmarkNode, BlockReferenceNode,
];
