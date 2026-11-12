import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceGraphResponse } from '@nbase/contracts';
import type { GraphSource } from './model';

interface GraphDataState { data: WorkspaceGraphResponse | null; error: string; loading: boolean }

/**
 * Loads the graph and reloads when `refreshKey` changes. The previous graph stays on screen during a
 * reload, and an identical response keeps the same object so the layout is not rebuilt.
 * `delay` debounces reloads after the first load (autosave bumps the revision often).
 */
export function useGraphData(source: GraphSource, refreshKey: unknown, delay = 0) {
  const [state, setState] = useState<GraphDataState>({ data: null, error: '', loading: true });
  const [attempt, setAttempt] = useState(0);
  const loaded = useRef<{ source: GraphSource; text: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const sameSource = loaded.current?.source === source;
    if (!sameSource) loaded.current = null;
    setState(previous => ({ data: sameSource ? previous.data : null, error: '', loading: true }));
    const timer = setTimeout(() => {
      source.load(controller.signal).then(data => {
        if (controller.signal.aborted) return;
        const text = JSON.stringify(data);
        const unchanged = loaded.current?.text === text;
        loaded.current = { source, text };
        setState(previous => ({ data: unchanged && previous.data ? previous.data : data, error: '', loading: false }));
      }).catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const status = typeof reason === 'object' && reason !== null && 'status' in reason ? (reason as { status: unknown }).status : null;
        setState(previous => ({ data: previous.data, loading: false,
          error: status === 401 ? '登录已失效，请重新登录后再查看关系图。' : '暂时无法读取关系图。' }));
      });
    }, sameSource ? delay : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [source, refreshKey, attempt, delay]);
  const reload = useCallback(() => setAttempt(value => value + 1), []);
  return { ...state, reload };
}
