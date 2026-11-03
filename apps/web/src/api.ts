import { isHealthResponse, type HealthResponse } from '@nbase/contracts';

export const CONNECTION_TIMEOUT_MS = 8_000;

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('连接超时，请重试', 'TimeoutError'));
  }, CONNECTION_TIMEOUT_MS);

  try {
    controller.signal.throwIfAborted();
    const response = await fetch('/api/health', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('服务暂时无法连接');
    const data: unknown = await response.json();
    if (!isHealthResponse(data)) throw new Error('服务返回了未知状态');
    return data;
  } catch (error) {
    if (controller.signal.reason instanceof DOMException
        && controller.signal.reason.name === 'TimeoutError') {
      throw new Error('连接超时，请重试');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
