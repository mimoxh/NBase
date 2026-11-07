import { useCallback, useEffect, useState } from 'react';
import type { MenuItem } from './Menu';

export const editorSizes = ['small', 'normal', 'large'] as const;
export type EditorSize = typeof editorSizes[number];
export interface ReadingPrefs { focus: boolean; wide: boolean; size: EditorSize }

const storageKey = 'nbase.reading';
const defaults: ReadingPrefs = { focus: false, wide: false, size: 'normal' };
const sizeLabels: Record<EditorSize, string> = { small: '小', normal: '标准', large: '大' };

export function parseReadingPrefs(raw: string | null): ReadingPrefs {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object') return defaults;
    const { focus, wide, size } = value as Record<string, unknown>;
    return { focus: focus === true, wide: wide === true,
      size: editorSizes.includes(size as EditorSize) ? size as EditorSize : 'normal' };
  } catch { return defaults; }
}

function stored(): ReadingPrefs {
  try { return parseReadingPrefs(localStorage.getItem(storageKey)); }
  catch { return defaults; }
}

/** View state only: kept per browser, never part of a document, draft or revision. */
export function useReadingPrefs(): [ReadingPrefs, (patch: Partial<ReadingPrefs>) => void] {
  const [prefs, setPrefs] = useState<ReadingPrefs>(stored);
  useEffect(() => {
    const root = document.documentElement.dataset;
    if (prefs.focus) root.nbFocus = ''; else delete root.nbFocus;
    if (prefs.wide) root.nbWide = ''; else delete root.nbWide;
    root.nbEditorSize = prefs.size;
    return () => { delete root.nbFocus; delete root.nbWide; delete root.nbEditorSize; };
  }, [prefs]);
  const update = useCallback((patch: Partial<ReadingPrefs>) => setPrefs(previous => {
    const next = { ...previous, ...patch };
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Preferences are best-effort UI state. */ }
    return next;
  }), []);
  return [prefs, update];
}

export function readingMenuItems(prefs: ReadingPrefs, update: (patch: Partial<ReadingPrefs>) => void): MenuItem[] {
  const nextSize = editorSizes[(editorSizes.indexOf(prefs.size) + 1) % editorSizes.length]!;
  return [
    { key: 'focus-mode', label: prefs.focus ? '退出专注模式' : '专注模式', icon: 'focus', onSelect: () => update({ focus: !prefs.focus }) },
    { key: 'wide', label: prefs.wide ? '标准页宽' : '全宽页面', icon: 'page', onSelect: () => update({ wide: !prefs.wide }) },
    { key: 'size', label: `正文字号：${sizeLabels[prefs.size]}`, icon: 'page', onSelect: () => update({ size: nextSize }) },
    { key: 'print', label: '打印或存为 PDF', icon: 'download', onSelect: () => window.print() },
  ];
}
