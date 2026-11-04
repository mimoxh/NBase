import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
const storageKey = 'nbase.theme';
const darkQuery = { matches: false, addEventListener: () => undefined, removeEventListener: () => undefined };
const media = () => typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)') : darkQuery as unknown as MediaQueryList;

function stored(): ThemePreference {
  try {
    const value = localStorage.getItem(storageKey);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch { /* Preferences are best-effort UI state. */ }
  return 'system';
}

function apply(preference: ThemePreference) {
  const dark = preference === 'dark' || (preference === 'system' && media().matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** UI theme only; persistence and document logic do not depend on it. */
export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(stored);
  useEffect(() => {
    apply(preference);
    if (preference !== 'system') return;
    const listener = () => apply('system');
    media().addEventListener('change', listener);
    return () => media().removeEventListener('change', listener);
  }, [preference]);
  const set = useCallback((next: ThemePreference) => {
    setPreference(next);
    try { localStorage.setItem(storageKey, next); } catch { /* Ignore storage failures. */ }
  }, []);
  return [preference, set];
}
