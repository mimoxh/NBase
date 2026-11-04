import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey } from 'lexical';
import type { NodeKey } from 'lexical';
import { $isCodeNode, CodeNode } from '@lexical/code';
import { Icon } from '../../components/Icon';

type Props = { onNotice?: ((message: string) => void) | undefined };
type Block = { key: string; top: number; left: number };

function sameBlocks(a: Block[], b: Block[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index]!;
    return item.key === other.key && item.top === other.top && item.left === other.left;
  });
}

/**
 * Copy buttons pinned to the top-right of each code block. The buttons live in
 * `.nbase-editor-surface`, outside the contentEditable DOM, so they never
 * disturb Lexical's reconciler — and they also work in read-only previews.
 * Code-node keys are tracked by the mutation listener; rectangle measurement
 * runs at most once per animation frame, only for tracked keys, and publishes
 * only when positions actually change.
 */
export function CodeCopyPlugin({ onNotice }: Props) {
  const [editor] = useLexicalComposerContext();
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [copied, setCopied] = useState('');
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;
  const keysRef = useRef<Set<NodeKey>>(new Set());

  useEffect(() => {
    const keys = keysRef.current;
    let pending = false;
    let fallbackId = 0;
    const measure = () => {
      const surfaceElement = editor.getRootElement()?.closest<HTMLElement>('.nbase-editor-surface') ?? null;
      setSurface(previous => previous === surfaceElement ? previous : surfaceElement);
      if (!surfaceElement || !keys.size) { setBlocks(previous => previous.length ? [] : previous); return; }
      const surfaceRect = surfaceElement.getBoundingClientRect();
      const items: Block[] = [];
      for (const key of keys) {
        const element = editor.getElementByKey(key);
        if (!element) { keys.delete(key); continue; }
        const rect = element.getBoundingClientRect();
        items.push({ key, top: rect.top - surfaceRect.top + 6, left: rect.right - surfaceRect.left - 34 });
      }
      items.sort((a, b) => a.top - b.top);
      setBlocks(previous => sameBlocks(previous, items) ? previous : items);
    };
    // rAF coalesces bursts to one measure per frame; a plain timer runs in
    // parallel because hidden/headless pages can starve rAF entirely — a
    // never-fired rAF must not leave the flag stuck and skip all work.
    const run = () => {
      if (!pending) return;
      pending = false;
      window.clearTimeout(fallbackId);
      measure();
    };
    const schedule = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(run);
      fallbackId = window.setTimeout(run, 60);
    };
    // skipInitialization: false reports every pre-existing code node as
    // 'created', so the set starts complete without a manual tree walk.
    const unregister = editor.registerMutationListener(CodeNode, mutated => {
      for (const [key, mutation] of mutated) {
        if (mutation === 'created') keys.add(key);
        else if (mutation === 'destroyed') keys.delete(key);
        // 'updated' needs a re-measure too: edited code can resize the block.
      }
      schedule();
    }, { skipInitialization: false });
    const onResize = () => schedule();
    window.addEventListener('resize', onResize);
    schedule();
    return () => {
      unregister();
      window.removeEventListener('resize', onResize);
      pending = false;
      window.clearTimeout(fallbackId);
    };
  }, [editor]);

  const copy = async (key: string) => {
    const text = editor.read('latest', () => {
      const node = $getNodeByKey(key);
      return $isCodeNode(node) ? node.getTextContent() : null;
    });
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(current => current === key ? '' : current), 1600);
    } catch {
      noticeRef.current?.('复制失败，请在代码块中手动选择内容复制。');
    }
  };

  if (!surface || !blocks.length) return null;
  return <>{blocks.map(block => createPortal(
    <button key={block.key} type="button"
      className={`nbase-code-copy${copied === block.key ? ' is-copied' : ''}`}
      style={{ top: block.top, left: block.left }} onClick={() => void copy(block.key)}
      title={copied === block.key ? '已复制' : '复制代码'}
      aria-label={copied === block.key ? '已复制' : '复制代码'}>
      <Icon name={copied === block.key ? 'check' : 'copy'} size={14} />
    </button>, surface))}</>;
}
