/** Workspace members and invitation links (docs/architecture/members.md). Only the instance owner manages them. */
export type MemberRole = 'owner' | 'editor' | 'viewer';
/** Roles an invitation or a role change may grant; there is exactly one owner. */
export type InvitableRole = 'editor' | 'viewer';
export const invitableRoles: readonly InvitableRole[] = ['editor', 'viewer'];
export const invitationLifetimeDays = [1, 7, 30] as const;
export type InvitationLifetimeDays = typeof invitationLifetimeDays[number];
export const defaultInvitationLifetimeDays: InvitationLifetimeDays = 7;
/** Unaccepted, unrevoked and unexpired invitations a workspace may hold at once. */
export const pendingInvitationLimit = 50;
export const memberPasswordMinCharacters = 15;
/** Same rule as the users table: 3-64 lowercase ASCII letters, digits, dot, underscore or hyphen. */
export const loginNamePattern = /^[a-z0-9][a-z0-9._-]{2,63}$/;
/** The invitation token travels in the URL fragment so it stays out of server logs and Referer headers. */
export const invitationFragmentKey = 'invite';
export const invitationTokenPattern = /^[A-Za-z0-9_-]{43}$/;
/** Header that carries the token on the public status request, so the token never appears in a URL. */
export const invitationTokenHeader = 'x-nbase-invite';

export interface WorkspaceMember {
  userId: string;
  loginName: string;
  role: MemberRole;
  joinedAt: string;
  removedAt: string | null;
  lastLoginAt: string | null;
}

export interface MemberListResponse { members: WorkspaceMember[] }
export interface MemberRoleRequest { role: InvitableRole }

export type InvitationStatus = 'pending' | 'expired' | 'accepted' | 'revoked';

export interface WorkspaceInvitation {
  id: string;
  role: InvitableRole;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  acceptedAt: string | null;
  acceptedLoginName: string | null;
}

export interface InvitationListResponse { invitations: WorkspaceInvitation[] }
export interface CreateInvitationRequest { role: InvitableRole; expiresInDays: InvitationLifetimeDays }
/** The token and link are returned only here; the server keeps only a SHA-256 digest. */
export interface CreateInvitationResponse { invitation: WorkspaceInvitation; token: string; url: string }

/** Public status of a token. Workspace name and role are returned only while the invitation can be accepted. */
export type InvitationLookupResponse =
  | { status: 'pending'; workspaceName: string; role: InvitableRole; expiresAt: string }
  | { status: Exclude<InvitationStatus, 'pending'> };

export interface AcceptInvitationRequest { token: string; loginName: string; password: string }

export function invitationUrl(publicOrigin: string, token: string): string {
  return `${publicOrigin}/#${invitationFragmentKey}=${token}`;
}

/** Reads `#invite=<token>` from a location hash; anything else is ignored. */
export function invitationTokenFromHash(hash: string): string | null {
  const match = /^#invite=([A-Za-z0-9_-]{43})$/.exec(hash);
  return match ? match[1]! : null;
}

export function isInvitableRole(value: unknown): value is InvitableRole {
  return value === 'editor' || value === 'viewer';
}

export function isInvitationLifetime(value: unknown): value is InvitationLifetimeDays {
  return (invitationLifetimeDays as readonly unknown[]).includes(value);
}
