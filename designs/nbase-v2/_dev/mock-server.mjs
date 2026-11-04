// Dev-only mock of the NBase page API + static host for the built web bundle.
// Serves apps/web/dist on 127.0.0.1:4380 with an in-memory workspace.
// Usage: node designs/nbase-v2/_dev/mock-server.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const dir = fileURLToPath(new URL('.', import.meta.url));
const dist = join(dir, '..', '..', '..', 'apps', 'web', 'dist');
const port = Number(process.env.PORT || 4380);

const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const now = () => new Date().toISOString();
const text = (t, extra = {}) => ({ type: 'text', version: 1, detail: 0, format: 0, mode: 'normal', style: '', text: t, ...extra });
const para = (t) => ({ type: 'paragraph', version: 1, direction: 'ltr', format: '', indent: 0, children: t ? [text(t)] : [] });
const heading = (tag, t) => ({ type: 'heading', version: 1, direction: 'ltr', format: '', indent: 0, tag, children: [text(t)] });
const quote = (t) => ({ type: 'quote', version: 1, direction: 'ltr', format: '', indent: 0, children: [text(t)] });
const list = (kind, items, checks) => ({ type: 'list', version: 1, direction: 'ltr', format: '', indent: 0, listType: kind,
  children: items.map((t, i) => ({ type: 'listitem', version: 1, direction: 'ltr', format: '', indent: 0,
    ...(kind === 'check' ? { checked: checks?.[i] ?? false } : {}), children: [para(t) ? text(t) : text(t)] })) });
const doc = (...children) => ({ schemaVersion: 1, editorState: { root: { type: 'root', version: 1, direction: 'ltr', format: '', indent: 0, children } } });

const ws = { id: 'ws-1', name: '我的空间', role: 'owner' };
const session = { user: { id: 'u-1', loginName: 'owner' }, workspaces: [ws], csrfToken: 'csrf-dev', expiresAt: '2099-01-01T00:00:00Z' };
let authed = false;
let rev = { 'p-1': 4, 'p-2': 2, 'p-3': 1 };
const pages = new Map();
const trashed = new Map();
const favorites = new Set();
const versions = new Map(); // pageId -> [{revision,title,savedAt,operation,deleted,content,icon,cover,parentId}]

const addVersion = (p, operation) => {
  const list = versions.get(p.id) ?? [];
  list.push({ pageId: p.id, revision: p.revision, title: p.title, savedAt: now(), operation, deleted: false,
    parentId: p.parentId, icon: p.icon, cover: p.cover, content: p.content });
  versions.set(p.id, list);
};

const makePage = (id, opts) => {
  const p = { id, workspaceId: ws.id, parentId: opts.parentId ?? null, title: opts.title ?? '',
    icon: opts.icon ?? null, cover: opts.cover ?? null, revision: opts.revision ?? '1',
    createdAt: '2026-10-20T09:00:00Z', updatedAt: now(), content: opts.content };
  pages.set(id, p); return p;
};

function seed(empty = false) {
  authed = false; pages.clear(); trashed.clear(); favorites.clear(); versions.clear();
  if (empty) return;
  const p1v1 = doc(heading('h1', '产品原则'), para('第一版的正文，用于历史对比演示。'), list('bullet', ['保持简单', '数据可携带']));
  const p1v2 = doc(heading('h1', '产品原则'), para('第二版的正文，用于历史对比演示，内容略有改动。'),
    list('check', ['保持简单', '数据可携带', '默认离线可用'], [true, true, false]), quote('把复杂留给系统，把简单留给用户。'));
  const p1content = doc(heading('h1', '产品原则'), para('第三版的正文，用于历史对比演示，内容略有改动。'),
    para('页面可以有图标和封面，侧边目录帮助快速定位。'),
    list('check', ['保持简单', '数据可携带', '默认离线可用'], [true, true, false]),
    heading('h2', '优先级'), para('先做核心写作体验，再逐步补齐协作能力。'),
    heading('h2', '数据结构'), para('修订、快照与收据在同一事务内提交。'),
    quote('把复杂留给系统，把简单留给用户。'), heading('h2', '恢复'), para('回收站与历史版本提供多层保护。'));

  makePage('p-1', { title: '产品原则', icon: '📌', cover: 'sage', revision: '4', content: p1content });
  versions.set('p-1', [
    { pageId: 'p-1', revision: '1', title: '产品原则', savedAt: '2026-10-24T09:00:00Z', operation: 'create', deleted: false, parentId: null, icon: '📌', cover: null, content: p1v1 },
    { pageId: 'p-1', revision: '2', title: '产品原则', savedAt: '2026-10-25T14:30:00Z', operation: 'update', deleted: false, parentId: null, icon: '📌', cover: 'sage', content: p1v2 },
    { pageId: 'p-1', revision: '4', title: '产品原则', savedAt: now(), operation: 'update', deleted: false, parentId: null, icon: '📌', cover: 'sage', content: p1content },
  ]);
  makePage('p-2', { title: '会议纪要 1027', icon: '🗒', revision: '2', content: doc(para('议题：搜索体验与回收站交互。'), para('结论：搜索区分标题与正文命中。')) });
  makePage('p-3', { title: '子页面示例', parentId: 'p-1', revision: '1', content: doc(para('挂在「产品原则」下的子页面。')) });
  trashed.set('p-9', { id: 'p-9', workspaceId: ws.id, parentId: 'p-1', title: '旧草稿', icon: null, cover: null, revision: '3',
    createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-24T10:00:00Z', deletedAt: '2026-10-26T10:00:00Z',
    deletionGroupId: 'g-1', content: doc(para('已经移入回收站的内容。')) });
}
seed();

const summary = ({ content, ...rest }) => rest;
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
};
const readBody = async (req) => { let data = ''; for await (const chunk of req) data += chunk; try { return JSON.parse(data || '{}'); } catch { return {}; } };

const api = async (req, res, url) => {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  if (url.pathname === '/api/health') return json(res, 200, { service: 'nbase', status: 'ok', stage: 'foundation', persistence: process.env.NBASE_MOCK_DEMO === '1' ? 'not-configured' : 'page-api' });
  if (url.pathname === '/api/__reset' && req.method === 'POST') { seed(url.searchParams.get('empty') === '1'); res.writeHead(204); return res.end(); }
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.loginName || !body.password) return json(res, 400, { error: 'INVALID_REQUEST' });
    if (body.loginName === 'owner' && body.password === 'dev') { authed = true; return json(res, 200, session); }
    return json(res, 401, { error: 'INVALID_CREDENTIALS' });
  }
  if (url.pathname === '/api/auth/session') {
    if (!authed) return json(res, 401, { error: 'UNAUTHORIZED' });
    return json(res, 200, session);
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') { authed = false; res.writeHead(204); return res.end(); }
  if (!authed) return json(res, 401, { error: 'UNAUTHORIZED' });

  const workspaceId = parts[2];
  const tail = parts.slice(3).join('/');
  if (tail === 'page-tree') return json(res, 200, { pages: [...pages.values()].map(summary), truncated: false });
  if (tail === 'favorites' && req.method === 'GET') return json(res, 200, { pageIds: [...favorites] });
  const favMatch = tail.match(/^favorites\/([^/]+)$/);
  if (favMatch) {
    const id = decodeURIComponent(favMatch[1]);
    if (req.method === 'PUT') { favorites.add(id); res.writeHead(204); return res.end(); }
    if (req.method === 'DELETE') { favorites.delete(id); res.writeHead(204); return res.end(); }
  }
  if (tail === 'search') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const results = [...pages.values()].filter(p => (p.title || '').toLowerCase().includes(q)
      || JSON.stringify(p.content).includes(q)).slice(0, 30).map(p => ({
      pageId: p.id, title: p.title, icon: p.icon, parentId: p.parentId, revision: p.revision,
      updatedAt: p.updatedAt, matchField: (p.title || '').toLowerCase().includes(q) ? 'title' : 'content',
      snippet: (p.title || '').toLowerCase().includes(q) ? '仅标题匹配' : `……正文片段包含「${url.searchParams.get('q')}」……`,
    }));
    return json(res, 200, { results, truncated: false });
  }
  if (tail === 'trash' && req.method === 'GET') return json(res, 200, { pages: [...trashed.values()].map(summary), nextCursor: null });
  const trashGet = tail.match(/^trash\/([^/]+)$/);
  if (trashGet && req.method === 'GET') {
    const page = trashed.get(decodeURIComponent(trashGet[1]));
    return page ? json(res, 200, page) : json(res, 404, { error: 'NOT_FOUND' });
  }
  const pageMatch = tail.match(/^pages\/([^/]+)(\/(history|trash|restore|restore-version|history\/[^/]+|versions\/[^/]+))?$/);
  if (pageMatch) {
    const id = decodeURIComponent(pageMatch[1]);
    const action = pageMatch[3];
    const page = pages.get(id);
    if (action?.startsWith('history/')) {
      const revWanted = action.split('/')[1];
      const v = (versions.get(id) ?? []).find(item => item.revision === revWanted);
      return v ? json(res, 200, v) : json(res, 404, { error: 'NOT_FOUND' });
    }
    if (action === 'history' && req.method === 'GET') {
      const list = (versions.get(id) ?? []).slice().reverse()
        .map(({ revision, title, savedAt, operation, deleted }) => ({ revision, title, savedAt, operation, deleted }));
      return json(res, 200, { versions: list, nextBeforeRevision: null });
    }
    if (action?.startsWith('versions/')) {
      const revWanted = action.split('/')[1];
      const v = (versions.get(id) ?? []).find(item => item.revision === revWanted);
      return v ? json(res, 200, v) : json(res, 404, { error: 'NOT_FOUND' });
    }
    if (action === 'trash' && req.method === 'POST' && page) {
      pages.delete(id); favorites.delete(id);
      trashed.set(id, { ...page, deletedAt: now(), deletionGroupId: randomUUID() });
      return json(res, 200, page);
    }
    if (action === 'restore' && req.method === 'POST') {
      const dead = trashed.get(id);
      if (!dead) return json(res, 404, { error: 'NOT_FOUND' });
      const { deletedAt, deletionGroupId, ...rest } = dead;
      pages.set(id, rest); trashed.delete(id);
      return json(res, 200, rest);
    }
    if (action === 'restore-version' && req.method === 'POST' && page) {
      const body = await readBody(req);
      const v = (versions.get(id) ?? []).find(item => item.revision === body.sourceRevision);
      if (v) { page.title = v.title; page.content = v.content; }
      page.revision = String(Number(page.revision) + 1); page.updatedAt = now(); addVersion(page, 'restore-version');
      return json(res, 200, page);
    }
    if (!action && req.method === 'GET') {
      return page ? json(res, 200, page) : json(res, 404, { error: 'NOT_FOUND' });
    }
    if (!action && req.method === 'PATCH' && page) {
      const body = await readBody(req);
      if (body.expectedRevision && body.expectedRevision !== page.revision) {
        return json(res, 409, { error: 'REVISION_CONFLICT', currentRevision: page.revision });
      }
      page.revision = String(Number(page.revision) + 1); page.updatedAt = now();
      if ('title' in body) page.title = body.title ?? '';
      if ('content' in body) page.content = body.content;
      if ('parentId' in body) page.parentId = body.parentId;
      if ('icon' in body) page.icon = body.icon ?? null;
      if ('cover' in body) page.cover = body.cover ?? null;
      addVersion(page, 'update');
      return json(res, 200, page);
    }
  }
  if (tail === 'pages' && req.method === 'POST') {
    const body = await readBody(req);
    const id = 'p-' + randomUUID().slice(0, 8);
    const created = makePage(id, { title: body.title ?? '', parentId: body.parentId ?? null, content: body.content });
    addVersion(created, 'create');
    return json(res, 201, created);
  }
  return json(res, 404, { error: 'NOT_FOUND' });
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let path = normalize(url.pathname).replace(/^([/\\])+/, '');
    let file = join(dist, path);
    try { await readFile(file); } catch { file = join(dist, 'index.html'); }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(error) }));
  }
}).listen(port, '127.0.0.1', () => console.log(`mock on http://127.0.0.1:${port} (login owner/dev)`));
