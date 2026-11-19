// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AuthSessionResponse, CreateInvitationResponse, WorkspaceInvitation, WorkspaceMember } from '@nbase/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PageTree } from '../shell/PageTree';
import { ApiError, pageClient } from './client';
import { InvitePage, invitationFromLocation } from './InvitePage';
import { invitationClient, memberClient } from './memberClient';
import { MembersPanel } from './MembersDialog';

vi.mock('../components/Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => <section role="dialog">{children}</section> }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

const token = 'A'.repeat(43);
const member = (loginName: string, role: WorkspaceMember['role'], extra: Partial<WorkspaceMember> = {}): WorkspaceMember => ({
  userId: `${loginName}-id`, loginName, role, joinedAt: '2026-11-01T00:00:00Z', removedAt: null, lastLoginAt: null, ...extra });
const invitation = (status: WorkspaceInvitation['status'], extra: Partial<WorkspaceInvitation> = {}): WorkspaceInvitation => ({
  id: `${status}-id`, role: 'viewer', status, createdAt: '2026-11-01T00:00:00Z', expiresAt: '2026-11-08T00:00:00Z',
  revokedAt: null, acceptedAt: null, acceptedLoginName: null, ...extra });
const session: AuthSessionResponse = { user: { id: 'u', loginName: 'reader' },
  workspaces: [{ id: 'w', name: '团队', role: 'viewer' }], csrfToken: 'csrf', expiresAt: '2099-01-01T00:00:00Z' };
const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent === text);
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

it('shows a new invitation link once, and removal waits for confirmation', async () => {
  vi.spyOn(memberClient, 'members').mockResolvedValue({ members: [member('owner', 'owner'), member('writer', 'editor')] });
  vi.spyOn(memberClient, 'invitations').mockResolvedValue({ invitations: [invitation('accepted', { acceptedLoginName: 'writer' })] });
  const created: CreateInvitationResponse = { invitation: invitation('pending', { role: 'editor' }), token, url: `http://127.0.0.1/#invite=${token}` };
  const create = vi.spyOn(memberClient, 'createInvitation').mockResolvedValue(created);
  const remove = vi.spyOn(memberClient, 'remove').mockResolvedValue(member('writer', 'editor', { removedAt: '2026-11-02T00:00:00Z' }));
  await act(async () => root.render(<MembersPanel workspaceId="w" csrfToken="csrf" onAuthError={() => {}} />));
  expect(host.textContent).toContain('成员 · 2 人');
  expect(host.textContent).toContain('由 writer 接受');
  // The owner row has no role picker or remove button.
  expect(host.querySelectorAll('select[aria-label$="的角色"]').length).toBe(1);

  await act(async () => button('生成邀请链接')!.click());
  expect(create).toHaveBeenCalledWith('w', { role: 'editor', expiresInDays: 7 }, 'csrf');
  expect(host.querySelector<HTMLInputElement>('#nb-invite-link')!.value).toBe(created.url);
  expect(host.textContent).toContain('链接只显示这一次');
  expect(host.textContent).toContain('编辑者 · 待接受');

  await act(async () => button('移除')!.click());
  expect(remove).not.toHaveBeenCalled();
  expect(host.textContent).toContain('会立即退出登录');
  await act(async () => button('确认移除')!.click());
  expect(remove).toHaveBeenCalledWith('w', 'writer-id', 'csrf');
  expect(host.textContent).toContain('编辑者 · 已移除');
  expect(button('恢复')).toBeTruthy();
});

it('accepts an invitation with a new account and clears the link from the address', async () => {
  history.replaceState(null, '', `/#invite=${token}`);
  expect(invitationFromLocation(location.hash)).toBe(token);
  expect(invitationFromLocation('#invite=short')).toBe('');
  expect(invitationFromLocation('#other')).toBeNull();
  vi.spyOn(pageClient, 'session').mockRejectedValue(new ApiError(401, 'AUTH_REQUIRED'));
  vi.spyOn(invitationClient, 'status').mockResolvedValue({ status: 'pending', workspaceName: '团队', role: 'viewer', expiresAt: '2026-11-08T00:00:00Z' });
  const accept = vi.spyOn(invitationClient, 'accept').mockResolvedValue(session);
  const done = vi.fn();
  await act(async () => root.render(<InvitePage token={token} onDone={done} />));
  expect(host.querySelector('h1')!.textContent).toBe('加入「团队」');
  expect(host.textContent).toContain('只读成员');
  const [name, password, confirm] = [...host.querySelectorAll('input')] as HTMLInputElement[];
  await act(async () => { type(name!, 'Reader'); type(password!, 'too short'); type(confirm!, 'too short'); });
  await act(async () => button('创建账号并加入')!.click());
  expect(accept).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('至少需要 15 个字符');
  await act(async () => { type(password!, 'a long enough passphrase'); type(confirm!, 'a long enough passphrase'); });
  await act(async () => button('创建账号并加入')!.click());
  expect(accept).toHaveBeenCalledWith({ token, loginName: 'reader', password: 'a long enough passphrase' });
  expect(location.hash).toBe('');
  expect(done).toHaveBeenCalledOnce();
});

it('asks a signed-in user to sign out, and explains a spent link', async () => {
  vi.spyOn(pageClient, 'session').mockResolvedValue(session);
  const logout = vi.spyOn(pageClient, 'logout').mockResolvedValue(undefined);
  const status = vi.spyOn(invitationClient, 'status').mockResolvedValue({ status: 'accepted' });
  await act(async () => root.render(<InvitePage token={token} onDone={() => {}} />));
  expect(host.textContent).toContain('当前登录的账号是 reader');
  expect(status).not.toHaveBeenCalled();
  await act(async () => button('退出当前账号并继续')!.click());
  expect(logout).toHaveBeenCalledWith('csrf');
  expect(host.querySelector('h1')!.textContent).toBe('邀请链接已被使用');
});

it('leaves structure actions out of the tree when they are not offered', async () => {
  const pages = [{ id: 'p', parentId: null, title: '页面', revision: '1', updatedAt: '2026-11-01T00:00:00Z', icon: null, cover: null }];
  await act(async () => root.render(<PageTree pages={pages as never} activeId={null} favorites={new Set()}
    actions={{ onOpen: () => {}, onFavorite: () => {} }} />));
  expect(host.querySelector('[aria-label^="在「页面」下新建子页面"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="「页面」页面操作"]')!.click());
  const items = [...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent);
  expect(items).toEqual(['收藏']);
});
