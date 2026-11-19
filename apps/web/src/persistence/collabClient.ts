import type {
  CommentAnchor, CommentThread, CommentThreadListResponse, CreatePageShareRequest, CreatePageShareResponse, PageShare,
  PageShareListResponse, SharedPageResponse, SharedRootResponse,
} from '@nbase/contracts';
import { shareTokenHeader } from '@nbase/contracts';
import { ApiError, request, workspacePath } from './client';

const id = (value: string) => encodeURIComponent(value);

export const commentClient = {
  list: (workspaceId: string, pageId: string, signal?: AbortSignal) =>
    request<CommentThreadListResponse>(`${workspacePath(workspaceId)}/pages/${id(pageId)}/comments`, 'GET', undefined, undefined, signal),
  create: (workspaceId: string, pageId: string, anchor: CommentAnchor, body: string, ids: { id: string; commentId: string }, csrfToken: string) =>
    request<CommentThread>(`${workspacePath(workspaceId)}/pages/${id(pageId)}/comments`, 'POST', { ...ids, anchor, body }, csrfToken),
  reply: (workspaceId: string, threadId: string, commentId: string, body: string, csrfToken: string) =>
    request<CommentThread>(`${workspacePath(workspaceId)}/comment-threads/${id(threadId)}/replies`, 'POST', { id: commentId, body }, csrfToken),
  edit: (workspaceId: string, commentId: string, body: string, csrfToken: string) =>
    request<CommentThread>(`${workspacePath(workspaceId)}/comments/${id(commentId)}`, 'PATCH', { body }, csrfToken),
  remove: (workspaceId: string, commentId: string, csrfToken: string) =>
    request<CommentThread>(`${workspacePath(workspaceId)}/comments/${id(commentId)}/delete`, 'POST', {}, csrfToken),
  resolve: (workspaceId: string, threadId: string, resolved: boolean, csrfToken: string) =>
    request<CommentThread>(`${workspacePath(workspaceId)}/comment-threads/${id(threadId)}/${resolved ? 'resolve' : 'reopen'}`, 'POST', {}, csrfToken),
};

export const shareClient = {
  list: (workspaceId: string, pageId: string, signal?: AbortSignal) =>
    request<PageShareListResponse>(`${workspacePath(workspaceId)}/pages/${id(pageId)}/shares`, 'GET', undefined, undefined, signal),
  create: (workspaceId: string, pageId: string, body: CreatePageShareRequest, csrfToken: string) =>
    request<CreatePageShareResponse>(`${workspacePath(workspaceId)}/pages/${id(pageId)}/shares`, 'POST', body, csrfToken),
  revoke: (workspaceId: string, shareId: string, csrfToken: string) =>
    request<PageShare>(`${workspacePath(workspaceId)}/shares/${id(shareId)}/revoke`, 'POST', {}, csrfToken),
};

/** Public reads behind a share link. The token travels in a header, never in the request URL. */
async function sharedRequest<T>(path: string, token: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 10_000);
  try {
    const response = await fetch(path, {
      cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: { [shareTokenHeader]: token },
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = (payload as { error?: unknown } | null)?.error;
      throw new ApiError(response.status, typeof code === 'string' ? code : 'SERVICE_UNAVAILABLE');
    }
    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted && !signal?.aborted) throw new ApiError(0, 'TIMEOUT');
    if (error instanceof TypeError) throw new ApiError(0, 'NETWORK_UNAVAILABLE');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export const sharedClient = {
  root: (shareId: string, token: string, signal?: AbortSignal) =>
    sharedRequest<SharedRootResponse>(`/api/shared/${id(shareId)}`, token, signal),
  page: (shareId: string, token: string, pageId: string, signal?: AbortSignal) =>
    sharedRequest<SharedPageResponse>(`/api/shared/${id(shareId)}/pages/${id(pageId)}`, token, signal),
  attachmentUrl: (shareId: string, attachmentId: string) => `/api/shared/${id(shareId)}/attachments/${id(attachmentId)}`,
};
