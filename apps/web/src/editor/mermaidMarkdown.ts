import type { MultilineElementTransformer } from '@lexical/markdown';
import { $getEditor } from 'lexical';
import { fencedMermaidSource, mermaidFenceStart } from './mermaidSource';
import { $createMermaidNode, $isMermaidNode, INSERT_MERMAID_COMMAND, MermaidNode } from './nodes/MermaidNode';

export const MERMAID_TRANSFORMER: MultilineElementTransformer = {
  type: 'multiline-element',
  dependencies: [MermaidNode],
  regExpStart: mermaidFenceStart,
  handleImportAfterStartMatch({ lines, rootNode, startLineIndex, startMatch }) {
    const length = startMatch[1]?.length ?? 3;
    for (let index = startLineIndex + 1; index < lines.length; index += 1) {
      const end = /^ {0,3}(`{3,})[ \t]*$/.exec(lines[index] ?? '');
      if ((end?.[1]?.length ?? 0) >= length) {
        rootNode.append($createMermaidNode(lines.slice(startLineIndex + 1, index).join('\n')));
        return [true, index];
      }
    }
    return null;
  },
  replace(parent, children, _start, _end, _lines, isImport) {
    return !isImport && children?.length === 0 && $getEditor().dispatchCommand(INSERT_MERMAID_COMMAND, parent.getKey());
  },
  export: node => $isMermaidNode(node) ? fencedMermaidSource(node.getTextContent()) : null,
};
