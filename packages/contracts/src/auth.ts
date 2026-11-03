/** Authentication is per user; workspace membership is always checked on the server. */
export interface AuthUser {
  id: string;
  loginName: string;
}

export interface AuthWorkspace {
  id: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
}

export interface AuthSessionResponse {
  user: AuthUser;
  workspaces: AuthWorkspace[];
  csrfToken: string;
  expiresAt: string;
}

export interface LoginRequest {
  loginName: string;
  password: string;
}

export type AuthErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'AUTH_EXPIRED'
  | 'CSRF_INVALID'
  | 'ORIGIN_INVALID'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE';

export interface ApiErrorResponse {
  error: AuthErrorCode | 'NOT_FOUND' | 'INVALID_REQUEST' | 'REVISION_CONFLICT' | 'FORBIDDEN'
    | 'CONTENT_INVALID' | 'CONTENT_VERSION_UNSUPPORTED' | 'MUTATION_CONFLICT' | 'PAGE_TREE_INVALID' | 'PAGE_TREE_CHANGED';
}
