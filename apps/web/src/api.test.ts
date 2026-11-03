import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTION_TIMEOUT_MS, getHealth } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('connection status', () => {
  it('accepts the foundation response without claiming persistence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      service: 'nbase', status: 'ok', stage: 'foundation', persistence: 'not-configured',
    }))));
    expect((await getHealth()).persistence).toBe('not-configured');
  });

  it('does not show a successful connection for a failing service', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(getHealth()).rejects.toThrow('服务暂时无法连接');
  });

  it('rejects an incompatible response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"status":"ok"}')));
    await expect(getHealth()).rejects.toThrow('服务返回了未知状态');
  });

  it('aborts an unresponsive request and reports a retryable timeout', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason));
      });
    }));
    const result = expect(getHealth()).rejects.toThrow('连接超时，请重试');
    await vi.advanceTimersByTimeAsync(CONNECTION_TIMEOUT_MS);
    await result;
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves caller cancellation and clears the pending timeout', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })));
    const result = expect(getHealth(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start fetching for an already cancelled caller', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(getHealth(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
