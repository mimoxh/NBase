import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { Icon } from '../../components/Icon';
import type { OutlineItem } from '../types';

export interface SectionFoldingHandle {
  refresh: (outline: OutlineItem[]) => void;
  reveal: (element: HTMLElement) => void;
  /** Opens this heading's own section; no effect on other blocks. */
  expand: (element: HTMLElement) => void;
  jump: (id: string) => void;
}

type Heading = OutlineItem & { element: HTMLElement; end: HTMLElement | null };
type Control = { id: string; text: string; expanded: boolean; top: number; left: number };

/** Visit whole subtrees after the heading, descending only to stop at a nested boundary. */
function* sectionElements(root: HTMLElement, heading: Heading): Generator<Element> {
  function nextSibling(element: Element): Element | null {
    for (let current: Element | null = element; current && current !== root; current = current.parentElement) {
      if (current.nextElementSibling) return current.nextElementSibling;
    }
    return null;
  }
  let element = nextSibling(heading.element);
  while (element && element !== heading.end) {
    if (heading.end && element.contains(heading.end)) element = element.firstElementChild;
    else {
      yield element;
      element = nextSibling(element);
    }
  }
}

export const SectionFoldingPlugin = forwardRef<SectionFoldingHandle>(function SectionFoldingPlugin(_, ref) {
  const [editor] = useLexicalComposerContext();
  const headings = useRef<Heading[]>([]);
  const collapsed = useRef(new Set<string>());
  const hidden = useRef(new Set<Element>());
  const [controls, setControls] = useState<Control[]>([]);
  const surface = editor.getRootElement()?.parentElement ?? null;

  const measure = () => {
    if (!headings.current.length) { setControls(previous => previous.length ? [] : previous); return; }
    const parent = editor.getRootElement()?.parentElement;
    if (!parent) return;
    const bounds = parent.getBoundingClientRect();
    const next = headings.current.flatMap(heading => {
      if (heading.element.closest('[data-nbase-folded]')) return [];
      const rect = heading.element.getBoundingClientRect();
      return [{ id: heading.id, text: heading.text, expanded: !collapsed.current.has(heading.id),
        top: rect.top - bounds.top, left: rect.left - bounds.left }];
    });
    setControls(previous => previous.length === next.length && previous.every((item, index) => {
      const current = next[index]!;
      return item.id === current.id && item.text === current.text && item.expanded === current.expanded
        && item.top === current.top && item.left === current.left;
    }) ? previous : next);
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const measureTimer = useRef<number | undefined>(undefined);
  const scheduleMeasure = () => {
    // ResizeObserver handles block growth immediately. Check equal-height
    // rearrangements after the typing burst without forcing layout per key.
    window.clearTimeout(measureTimer.current);
    measureTimer.current = window.setTimeout(() => measureRef.current(), 150);
  };

  const apply = () => {
    const root = editor.getRootElement();
    if (!root) return;
    const next = new Set<Element>();
    for (const heading of headings.current) {
      if (!collapsed.current.has(heading.id)) continue;
      for (const element of sectionElements(root, heading)) next.add(element);
    }
    for (const element of hidden.current) if (!next.has(element)) element.removeAttribute('data-nbase-folded');
    for (const element of next) if (!hidden.current.has(element)) element.setAttribute('data-nbase-folded', '');
    hidden.current = next;
  };

  const reveal = (element: HTMLElement) => {
    const root = editor.getRootElement();
    if (!root || !element.closest('[data-nbase-folded]')) return;
    for (const heading of headings.current) {
      if (!collapsed.current.has(heading.id)) continue;
      for (const part of sectionElements(root, heading)) {
        if (!part.contains(element)) continue;
        collapsed.current.delete(heading.id);
        break;
      }
    }
    apply();
    measure();
  };

  useImperativeHandle(ref, () => ({
    refresh(outline) {
      if (!outline.length && !headings.current.length) return;
      const stack: Heading[] = [];
      const ordered: Heading[] = [];
      for (const item of outline) {
        const element = editor.getElementByKey(item.id.slice('heading-'.length));
        if (!element) continue;
        if (element.id !== item.id) element.id = item.id;
        const heading = { ...item, element, end: null };
        while (stack.length && stack.at(-1)!.level >= item.level) stack.pop()!.end = element;
        stack.push(heading);
        ordered.push(heading);
      }
      const ids = new Set(ordered.map(heading => heading.id));
      for (const id of collapsed.current) if (!ids.has(id)) collapsed.current.delete(id);
      const sameHeadings = headings.current.length === ordered.length && headings.current.every((old, index) => {
        const next = ordered[index]!;
        return old.element === next.element && old.level === next.level && old.text === next.text;
      });
      headings.current = ordered;
      if (collapsed.current.size || hidden.current.size) apply();
      if (sameHeadings) scheduleMeasure();
      else measure();
    },
    reveal,
    expand(element) {
      const heading = headings.current.find(item => item.element === element);
      if (!heading || !collapsed.current.delete(heading.id)) return;
      apply();
      measure();
    },
    jump(id) {
      const heading = headings.current.find(item => item.id === id);
      if (!heading) return;
      reveal(heading.element);
      heading.element.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    },
  }));

  useLayoutEffect(() => {
    const resize = () => measureRef.current();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    const unregister = editor.registerRootListener((root, previous) => {
      if (previous) observer?.unobserve(previous);
      if (root) observer?.observe(root);
    });
    window.addEventListener('resize', resize);
    return () => {
      unregister();
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      window.clearTimeout(measureTimer.current);
      for (const element of hidden.current) element.removeAttribute('data-nbase-folded');
      hidden.current.clear();
    };
  }, [editor]);

  if (!surface || !controls.length) return null;
  return createPortal(controls.map(({ id, text, expanded, top, left }) => <button key={id}
    type="button" className="nbase-section-toggle" aria-expanded={expanded}
    aria-label={`${expanded ? '折叠章节' : '展开章节'} ${text}`} style={{ top, left }}
    onClick={() => {
      if (expanded) collapsed.current.add(id);
      else collapsed.current.delete(id);
      apply();
      measure();
    }}><Icon name={expanded ? 'chevron-down' : 'chevron'} size={15} /></button>), surface);
});
