import type {
  AttachmentMetadata, AuthSessionResponse, CreatePageRequest, PageDocument, PageTreeResponse, SearchResponse,
  PageSummary, PageHistoryResponse, PageVersion, PageStateRequest, RestorePageVersionRequest,
  TrashedPageDocument, TrashListResponse, TrashPageRequest, UpdatePageRequest,
} from '@nbase/contracts';

const timeoutMs = 8_000;

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string,
    public readonly currentRevision?: string) {
    super(code);
  }
}

async function request<T>(path: string, method = 'GET', body?: unknown, csrfToken?: string,
  signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const response = await fetch(path, {
      method, cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
      ...(body === undefined ? {} : { headers: {
        'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      } }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return undefined as T;
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new ApiError(response.status, 'INVALID_RESPONSE'); }
    if (!response.ok) {
      const error = payload as { error?: unknown; currentRevision?: unknown };
      throw new ApiError(response.status, typeof error?.error === 'string' ? error.error : 'SERVICE_UNAVAILABLE',
        typeof error?.currentRevision === 'string' ? error.currentRevision : undefined);
    }
    return payload as T;
  } catch (error) {
    if (controller.signal.reason instanceof DOMException && controller.signal.reason.name === 'TimeoutError') {
      throw new ApiError(0, 'TIMEOUT');
    }
    if (error instanceof TypeError) throw new ApiError(0, 'NETWORK_UNAVAILABLE');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

const workspacePath = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}`;

export const pageClient = {
  session: (signal?: AbortSignal) => request<AuthSessionResponse>('/api/auth/session', 'GET', undefined, undefined, signal),
  login: (loginName: string, password: string) =>
    request<AuthSessionResponse>('/api/auth/login', 'POST', { loginName, password }),
  logout: (csrfToken: string) => request<void>('/api/auth/logout', 'POST', {}, csrfToken),
  tree: (workspaceId: string, signal?: AbortSignal) =>
    request<PageTreeResponse>(`${workspacePath(workspaceId)}/page-tree`, 'GET', undefined, undefined, signal),
  get: (workspaceId: string, pageId: string, signal?: AbortSignal) =>
    request<PageDocument>(`${workspacePath(workspaceId)}/pages/${encodeURIComponent(pageId)}`, 'GET', undefined, undefined, signal),
  receipt: (workspaceId: string, mutationId: string) =>
    request<{ statusCode: number; response: PageDocument }>(
      `${workspacePath(workspaceId)}/mutations/${encodeURIComponent(mutationId)}`),
  create: (workspaceId: string, body: CreatePageRequest, csrfToken: string) =>
    request<PageDocument>(`${workspacePath(workspaceId)}/pages`, 'POST', body, csrfToken),
  update: (workspaceId: string, pageId: string, body: UpdatePageRequest, csrfToken: string) =>
    request<PageDocument>(`${workspacePath(workspaceId)}/pages/${encodeURIComponent(pageId)}`, 'PATCH', body, csrfToken),
  search: (workspaceId: string, phrase: string, signal?: AbortSignal) =>
    request<SearchResponse>(`${workspacePath(workspaceId)}/search?q=${encodeURIComponent(phrase)}&limit=30`,
      'GET', undefined, undefined, signal),
  history: (workspaceId: string, pageId: string, before?: string, signal?: AbortSignal) =>
    request<PageHistoryResponse>(`${workspacePath(workspaceId)}/pages/${encodeURIComponent(pageId)}/history?limit=30${before ? `&beforeRevision=${encodeURIComponent(before)}` : ''}`,
      'GET', undefined, undefined, signal),
  version: (workspaceId: string, pageId: string, revision: string, signal?: AbortSignal) =>
    request<PageVersion>(`${workspacePath(workspaceId)}/pages/${encodeURIComponent(pageId)}/history/${encodeURIComponent(revision)}`,
      'GET', undefined, undefined, signal),
  trashList: (workspaceId: string, cursor?: string, signal?: AbortSignal) =>
    request<TrashListResponse>(`${workspacePath(workspaceId)}/trash?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      'GET', undefined, undefined, signal),
  trashed: (workspaceId: string, pageId: string, signal?: AbortSignal) =>
    request<TrashedPageDocument>(`${workspacePath(workspaceId)}/trash/${encodeURIComponent(pageId)}`, 'GET', undefined, undefined, signal),
  trash: (workspaceId: string, pageId: string, body: TrashPageRequest, csrfToken: string) =>
    request<PageDocument>(`${workspacePath(workspaceId)}/pages/${encodeURIComponent(pageId)}/trash`, 'POST', body, csrfToken),
  restore: (workspaceId: string, pageId: string, body: PageStateRequest, csrfToken: string) =>
    request<PageDocument>(`${workspacePath(workspaceId)}/pages/${encodeURIComponent(pageId)}/restore`, 'POST', body, csrfToken),
  restoreVersion: (workspaceId: string, pageId: string, body: RestorePageVersionRequest, csrfToken: string) =>
    request<PageDocument>(`${workspacePath(workspaceId)}/pages/${encodeURIComponent(pageId)}/restore-version`, 'POST', body, csrfToken),
};

export const attachmentClient = {
  upload: async (workspaceId: string, id: string, file: File, csrfToken: string): Promise<AttachmentMetadata> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const path = `${workspacePath(workspaceId)}/attachments/${encodeURIComponent(id)}?name=${encodeURIComponent(file.name || 'image')}`;
      const response = await fetch(path, {
        method: 'PUT', cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrfToken }, body: file,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code = (payload as { error?: unknown } | null)?.error;
        throw new ApiError(response.status, typeof code === 'string' ? code : 'SERVICE_UNAVAILABLE');
      }
      if (!payload || typeof payload !== 'object' || (payload as AttachmentMetadata).id !== id
        || typeof (payload as AttachmentMetadata).mediaType !== 'string'
        || typeof (payload as AttachmentMetadata).fileName !== 'string') {
        throw new ApiError(response.status, 'INVALID_RESPONSE');
      }
      return payload as AttachmentMetadata;
    } catch (error) {
      if (controller.signal.aborted) throw new ApiError(0, 'TIMEOUT');
      if (error instanceof TypeError) throw new ApiError(0, 'NETWORK_UNAVAILABLE');
      throw error;
    } finally { clearTimeout(timer); }
  },
  download: async (workspaceId: string, id: string): Promise<Blob> => {
    const response = await fetch(`${workspacePath(workspaceId)}/attachments/${encodeURIComponent(id)}/content?download=1`, {
      credentials: 'same-origin', cache: 'no-store',
    });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const code = (payload as { error?: unknown } | null)?.error;
      throw new ApiError(response.status, typeof code === 'string' ? code : 'SERVICE_UNAVAILABLE');
    }
    return response.blob();
  },
};

/** Loads the bounded page tree without silently hiding later pages. */
export async function loadPageTree(workspaceId: string, signal?: AbortSignal): Promise<PageSummary[]> {
  const { pages, truncated } = await pageClient.tree(workspaceId, signal);
  if (truncated) throw new ApiError(0, 'PAGE_LIMIT_EXCEEDED');
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.id)) throw new ApiError(0, 'PAGE_TREE_INVALID');
    seen.add(page.id);
  }
  return pages;
}
