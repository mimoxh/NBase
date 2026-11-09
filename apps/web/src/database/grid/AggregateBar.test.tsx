// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { DatabaseView, PropertyDefinition } from '@nbase/contracts';
import { expect, it, vi } from 'vitest';
import { AggregateBar } from './AggregateBar';
import type { DatabaseDataSource } from '../source';

it('refreshes a stale aggregate until the computed cache catches up', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const formula: PropertyDefinition = {
    id: 'formula', name: '双倍', type: 'formula', formula: { expression: '21 * 2', resultType: 'number' },
  };
  const view: DatabaseView = {
    id: 'view', name: '表格', type: 'table', filters: [], sorts: [], hiddenPropertyIds: [], propertyOrder: [],
    widths: {}, aggregates: { [formula.id]: 'sum' },
  };
  const aggregate = vi.fn<DatabaseDataSource['aggregate']>()
    .mockResolvedValueOnce({ values: [20], computedStale: true })
    .mockResolvedValue({ values: [42] });
  try {
    await act(() => root.render(<AggregateBar source={{ aggregate }} databaseId="db" request={{ filters: [], sorts: [] }}
      view={view} columns={[formula]} canWrite={false} version={1} gutter={0} end={0} widthOf={() => 120}
      frozen={{ count: 0, leftOf: () => 0 }} barRef={createRef<HTMLDivElement>()} onChange={() => undefined} />));

    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(host.querySelector('button')?.textContent).toBe('求和 —');

    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(host.querySelector('button')?.textContent).toBe('求和 42');
    expect(aggregate).toHaveBeenCalledTimes(2);
  } finally {
    await act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
