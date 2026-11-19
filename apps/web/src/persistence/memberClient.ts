import type {
  AcceptInvitationRequest, AuthSessionResponse, CreateInvitationRequest, CreateInvitationResponse, InvitableRole,
  InvitationListResponse, InvitationLookupResponse, MemberListResponse, WorkspaceInvitation, WorkspaceMember,
} from '@nbase/contracts';
import { invitationTokenHeader } from '@nbase/contracts';
import { ApiError, request, workspacePath } from './client';

const memberPath = (workspaceId: string, userId: string) => `${workspacePath(workspaceId)}/members/${encodeURIComponent(userId)}`;

export const memberClient = {
  members: (workspaceId: string, signal?: AbortSignal) =>
    request<MemberListResponse>(`${workspacePath(workspaceId)}/members`, 'GET', undefined, undefined, signal),
  setRole: (workspaceId: string, userId: string, role: InvitableRole, csrfToken: string) =>
    request<WorkspaceMember>(memberPath(workspaceId, userId), 'PATCH', { role }, csrfToken),
  remove: (workspaceId: string, userId: string, csrfToken: string) =>
    request<WorkspaceMember>(`${memberPath(workspaceId, userId)}/remove`, 'POST', {}, csrfToken),
  restore: (workspaceId: string, userId: string, csrfToken: string) =>
    request<WorkspaceMember>(`${memberPath(workspaceId, userId)}/restore`, 'POST', {}, csrfToken),
  invitations: (workspaceId: string, signal?: AbortSignal) =>
    request<InvitationListResponse>(`${workspacePath(workspaceId)}/invitations`, 'GET', undefined, undefined, signal),
  createInvitation: (workspaceId: string, body: CreateInvitationRequest, csrfToken: string) =>
    request<CreateInvitationResponse>(`${workspacePath(workspaceId)}/invitations`, 'POST', body, csrfToken),
  revokeInvitation: (workspaceId: string, invitationId: string, csrfToken: string) =>
    request<WorkspaceInvitation>(`${workspacePath(workspaceId)}/invitations/${encodeURIComponent(invitationId)}/revoke`, 'POST', {}, csrfToken),
};

export const invitationClient = {
  /** The token goes in a header so it never lands in a URL, a server log or a Referer. */
  status: async (token: string, signal?: AbortSignal): Promise<InvitationLookupResponse> => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 8_000);
    try {
      const response = await fetch('/api/invitations/status', {
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal, headers: { [invitationTokenHeader]: token },
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code = (payload as { error?: unknown } | null)?.error;
        throw new ApiError(response.status, typeof code === 'string' ? code : 'SERVICE_UNAVAILABLE');
      }
      return payload as InvitationLookupResponse;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (controller.signal.aborted && !signal?.aborted) throw new ApiError(0, 'TIMEOUT');
      if (error instanceof TypeError) throw new ApiError(0, 'NETWORK_UNAVAILABLE');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  },
  // Password hashing on the server takes a moment, so this gets more time than an ordinary request.
  accept: (body: AcceptInvitationRequest) =>
    request<AuthSessionResponse>('/api/invitations/accept', 'POST', body, undefined, undefined, 20_000),
};
