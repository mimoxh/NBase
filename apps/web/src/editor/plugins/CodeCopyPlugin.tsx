import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { $getNodeByKey } from 'lexical';
import type { NodeKey } from 'lexical';
import { $isCodeNode, CodeNode } from '@lexical/code';
import { Icon } from '../../components/Icon';
import { CODE_LANGUAGES } from '../codeLanguages';
import { EditorMenu } from './EditorMenu';
import { codeLanguageEntries, menuHost, setCodeLanguage } from './BlockContextMenuPlugin';

type Props = { onNotice?: ((message: string) => void) | undefined };
type Block = { key: string; top: number; right: number; language: string };

function sameBlocks(a: Block[], b: Block[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index]!;
    return item.key === other.key && item.top === other.top && item.right === other.right && item.language === other.language;
  });
}

function languageLabel(language: string): string {
  return CODE_LANGUAGES.find(([value]) => value === (language || 'plain'))?.[1] ?? language;
}

/**
 * A language badge and copy button pinned to the top-right of each code block. The buttons live in
 * `.nbase-editor-surface`, outside the contentEditable DOM, so they never
 * disturb Lexical's reconciler — and they also work in read-only previews.
 * Code-node keys are tracked by the mutation listener; rectangle measurement
 * runs at most once per animation frame, only for tracked keys, and publishes
 * only when positions actually change.
 */
export function CodeCopyPlugin({ onNotice }: Props) {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const [languageMenu, setLanguageMenu] = useState<{ key: string; language: string; x: number; y: number } | null>(null);
  // The menu's outside-click handler closes it before the badge's click, which must not reopen it.
  const closedByBadge = useRef(false);
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
      const languages = editor.read('latest', () => new Map([...keys].map(key => {
        const node = $getNodeByKey(key);
        return [key, $isCodeNode(node) ? node.getLanguage() ?? '' : ''];
      })));
      for (const key of keys) {
        const element = editor.getElementByKey(key);
        if (!element) { keys.delete(key); continue; }
        if (element.closest('[data-nbase-folded]')) continue;
        const rect = element.getBoundingClientRect();
        items.push({ key, top: rect.top - surfaceRect.top + 6, right: surfaceRect.right - rect.right + 10, language: languages.get(key) ?? '' });
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
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
    const unregisterRoot = editor.registerRootListener((root, previous) => {
      if (previous) observer?.unobserve(previous);
      if (root) observer?.observe(root);
    });
    window.addEventListener('resize', onResize);
    schedule();
    return () => {
      unregister();
      unregisterRoot();
      observer?.disconnect();
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
    <div key={block.key} className="nbase-code-controls" style={{ top: block.top, right: block.right }}>
      {editable
        ? <button type="button" className="nbase-code-lang" aria-haspopup="menu" title="切换代码语言"
          aria-label={`代码语言：${languageLabel(block.language)}`} aria-expanded={languageMenu?.key === block.key}
          onMouseDown={event => { event.preventDefault(); closedByBadge.current = languageMenu?.key === block.key; }}
          onClick={event => {
            if (closedByBadge.current) { closedByBadge.current = false; return; }
            const rect = event.currentTarget.getBoundingClientRect();
            setLanguageMenu({ key: block.key, language: block.language, x: rect.left, y: rect.bottom + 4 });
          }}>{languageLabel(block.language)}</button>
        : <span className="nbase-code-lang">{languageLabel(block.language)}</span>}
      <button type="button"
        className={`nbase-code-copy${copied === block.key ? ' is-copied' : ''}`}
        onClick={() => void copy(block.key)}
        title={copied === block.key ? '已复制' : '复制代码'}
        aria-label={copied === block.key ? '已复制' : '复制代码'}>
        <Icon name={copied === block.key ? 'check' : 'copy'} size={14} />
      </button>
    </div>, surface))}
    {languageMenu && <EditorMenu label="代码语言" x={languageMenu.x} y={languageMenu.y} host={menuHost(editor)}
      items={codeLanguageEntries(languageMenu.language, language => { setCodeLanguage(editor, languageMenu.key, language); editor.focus(); })}
      onClose={restore => { setLanguageMenu(null); if (restore) editor.focus(); }} />}
  </>;
}
