// Disposable P3-06 performance baseline only. Never point this at a personal/production instance.
// Usage: node -- scripts/p3-perf-baseline.mjs seed|measure
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem, release, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const envFile = '.env.p3.perf';
const config = Object.fromEntries((await readFile(join(root, envFile), 'utf8')).trim().split(/\r?\n/)
  .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const project = config.NBASE_COMPOSE_PROJECT;
assert.match(project, /^nbase-p3-perf-\d{8}$/);
const origin = 'http://127.0.0.1:4328';
assert.equal(config.NBASE_PUBLIC_ORIGIN, origin);
const password = (await readFile(join(root, '.secrets', project, 'owner-password'), 'utf8')).trimEnd();
const statePath = join(root, '.data', `${project}-perf-state.json`);
const mode = process.argv[2];
assert.ok(['seed', 'measure'].includes(mode), 'mode must be seed or measure');

const fixture = {
  roots: 50, childrenPerRoot: 9, smallParagraphs: 12, smallChars: 80,
  long300: { paragraphs: 300, chars: 100, headingEvery: 25 },
  long1500: { paragraphs: 1500, chars: 100, headingEvery: 50 },
  historyParagraphs: 20, historyUpdates: 300, longUpdates: 20,
  images: 30, imageSide: 320,
  rarePhrase: '青石桥边的灯塔', tailPhrase: '灯塔尽头的回声', mixedPhrase: 'NBase 同步方案', missPhrase: '不存在的短语甲乙丙',
};

async function request(path, { method = 'GET', session, body, bytes, status = 200 } = {}) {
  const started = performance.now();
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(60000),
    headers: { origin, ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}),
      ...(body ? { 'content-type': 'application/json' } : bytes ? { 'content-type': 'application/octet-stream' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : bytes ? { body: bytes } : {}),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const ms = performance.now() - started;
  assert.equal(response.status, status, `${method} ${path}: expected ${status}, received ${response.status} ${buffer.toString('utf8', 0, 200)}`);
  return { response, buffer, ms, json: () => JSON.parse(buffer.toString('utf8')) };
}
async function login() {
  const { response, json } = await request('/api/auth/login', { method: 'POST', body: { loginName: 'owner', password } });
  const body = json();
  return { cookie: response.headers.get('set-cookie').split(';', 1)[0], csrfToken: body.csrfToken, workspaceId: body.workspaces[0].id };
}

function rng(seed) {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const words = ['知识库', '文档', '整理', '记录', '项目', '计划', '会议', '总结', '需求', '设计', '实现', '测试', '部署', '备份',
  '恢复', '搜索', '历史', '附件', '目录', '页面', '编辑', '保存', '草稿', '冲突', '版本', '数据', '服务', '网络', '中文', '输入',
  '排版', '表格', '列表', '引用', '代码', '链接', '图片', '想法', '阅读', '笔记', '方法', '问题', '结论', '步骤', '资料', '下一步', '继续'];
const latin = ['PostgreSQL', 'Docker', 'Lexical', 'Markdown', 'API', 'React', 'NAS'];
function sentence(next, chars) {
  let value = '';
  while (value.length < chars) {
    value += next() < 0.06 ? ` ${latin[Math.floor(next() * latin.length)]} ` : words[Math.floor(next() * words.length)];
    if (next() < 0.12) value += '，';
  }
  return value.slice(0, chars) + '。';
}
const text = value => ({ detail: 0, format: 0, mode: 'normal', style: '', text: value, type: 'text', version: 1 });
const element = (type, children, extra = {}) => ({ children, direction: 'ltr', format: '', indent: 0, type, version: 1, ...extra });
const paragraph = value => element('paragraph', [text(value)], { textFormat: 0, textStyle: '' });
const heading = value => element('heading', [text(value)], { tag: 'h2' });
const attachmentParagraph = item => element('paragraph', [{ type: 'attachment', version: 1, attachmentId: item.id,
  alt: item.alt, fileName: item.fileName, mediaType: 'image/png' }], { direction: null, textFormat: 0, textStyle: '' });
const documentOf = children => ({ schemaVersion: 1, editorState: { root: element('root', children) } });
const bytesOf = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

function longChildren(next, spec, tail) {
  const children = [];
  for (let i = 1; i <= spec.paragraphs; i++) {
    if (i % spec.headingEvery === 1) children.push(heading(`第 ${Math.ceil(i / spec.headingEvery)} 节`));
    children.push(paragraph(i === spec.paragraphs && tail ? `${tail}在最后一段。` : `${i}. ${sentence(next, spec.chars)}`));
  }
  return children;
}
function png(side, next) {
  const stride = side * 3 + 1;
  const raw = Buffer.alloc(stride * side);
  for (let i = 0; i < raw.length; i++) raw[i] = i % stride === 0 ? 0 : Math.floor(next() * 256);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0); header.writeUInt32BE(side, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = q => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const round = value => Math.round(value * 10) / 10;
  return { n: sorted.length, min: round(sorted[0]), median: round(pick(0.5)), p95: round(pick(0.95)), max: round(sorted.at(-1)),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) };
}
async function repeat(count, action, warmup = 2) {
  for (let i = 0; i < warmup; i++) await action(i);
  const samples = [];
  for (let i = 0; i < count; i++) { const started = performance.now(); await action(i); samples.push(performance.now() - started); }
  return stats(samples);
}
function compose(...args) {
  return execFileSync('docker', ['compose', '--env-file', envFile, ...args], { cwd: root, encoding: 'utf8' }).trim();
}

if (mode === 'seed') {
  try { await readFile(statePath); throw new Error('Perf state already exists; use measure or a new dated project'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await request('/api/ready');
  const session = await login();
  const base = `/api/workspaces/${session.workspaceId}`;
  assert.equal((await request(`${base}/pages`, { session })).json().pages.length, 0, 'perf instance must start empty');
  const next = rng(20261103);
  const timings = { createSmall: [], updateHistory: [], updateLong1500: [], uploadImage: [] };
  const create = async (title, parentId, content, bucket) => {
    const result = await request(`${base}/pages`, { session, method: 'POST', status: 201,
      body: { clientMutationId: randomUUID(), title, parentId, content } });
    bucket?.push(result.ms);
    return result.json();
  };
  const update = async (page, content, bucket) => {
    const result = await request(`${base}/pages/${page.id}`, { session, method: 'PATCH',
      body: { clientMutationId: randomUUID(), expectedRevision: page.revision, content } });
    bucket?.push(result.ms);
    return result.json();
  };
  const started = performance.now();
  const small = [];
  for (let r = 1; r <= fixture.roots; r++) {
    const smallContent = index => {
      const children = Array.from({ length: fixture.smallParagraphs }, () => paragraph(sentence(next, fixture.smallChars)));
      if (index % 10 === 0) children.push(paragraph(`${fixture.mixedPhrase}需要复核。`));
      if (r === 37 && index === 5) children.push(paragraph(`${fixture.rarePhrase}仍在记录里。`));
      return documentOf(children);
    };
    const rootPage = await create(`资料集 ${String(r).padStart(2, '0')}`, null, smallContent(0), timings.createSmall);
    small.push(rootPage);
    for (let c = 1; c <= fixture.childrenPerRoot; c++) {
      small.push(await create(`资料集 ${String(r).padStart(2, '0')}-${c}`, rootPage.id, smallContent(c), timings.createSmall));
    }
  }
  const rarePage = small.find(page => page.title === '资料集 37-5');
  const long300Content = documentOf(longChildren(next, fixture.long300));
  const long300 = await create('长文档 300 段', null, long300Content);
  let long1500Children = longChildren(next, fixture.long1500, fixture.tailPhrase);
  const long1500Bytes = bytesOf(documentOf(long1500Children));
  assert.ok(long1500Bytes < 1024 * 1024, `long1500 content ${long1500Bytes} bytes exceeds server limit`);
  let long1500 = await create('长文档 1500 段', null, documentOf(long1500Children));
  for (let i = 1; i <= fixture.longUpdates; i++) {
    long1500Children = long1500Children.map((node, index) => index === i * 10 ? paragraph(`${i}. ${sentence(next, fixture.long1500.chars)}`) : node);
    long1500 = await update(long1500, documentOf(long1500Children), timings.updateLong1500);
  }
  let historyChildren = Array.from({ length: fixture.historyParagraphs }, () => paragraph(sentence(next, fixture.smallChars)));
  let historyPage = await create('多历史页面', null, documentOf(historyChildren));
  for (let i = 1; i <= fixture.historyUpdates; i++) {
    historyChildren = historyChildren.map((node, index) => index === i % fixture.historyParagraphs
      ? paragraph(`${sentence(next, fixture.smallChars)} 第${i}次修改`) : node);
    historyPage = await update(historyPage, documentOf(historyChildren), timings.updateHistory);
  }
  const images = [];
  for (let i = 1; i <= fixture.images; i++) {
    const item = { id: randomUUID(), alt: `基准图片 ${i}`, fileName: `perf-${String(i).padStart(2, '0')}.png` };
    const bytes = png(fixture.imageSide, next);
    const result = await request(`${base}/attachments/${item.id}?name=${item.fileName}`, { session, method: 'PUT', bytes, status: 201 });
    timings.uploadImage.push(result.ms);
    images.push({ ...item, bytes: bytes.length });
  }
  const imageDoc = await create(`图片文档 ${fixture.images} 张`, null, documentOf(images.flatMap(item =>
    [paragraph(`${item.alt}：${sentence(next, 40)}`), attachmentParagraph(item)])));
  const seedMs = performance.now() - started;
  await mkdir(join(root, '.data'), { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify({ session, fixture,
    ids: { smallId: small[0].id, rareId: rarePage.id, long300Id: long300.id, long1500Id: long1500.id,
      historyId: historyPage.id, imageDocId: imageDoc.id, imageIds: images.map(item => item.id) },
    sizes: { long300Bytes: bytesOf(long300Content), long1500Bytes, imageBytes: images.reduce((sum, item) => sum + item.bytes, 0) },
    seed: { totalMs: Math.round(seedMs), pages: small.length + 4,
      timings: Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, stats(value)])) },
  }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`Seeded ${small.length + 4} pages, ${fixture.historyUpdates + fixture.longUpdates} updates and ${images.length} images in ${Math.round(seedMs)} ms.`);
} else {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  await request('/api/ready');
  const session = await login();
  const base = `/api/workspaces/${session.workspaceId}`;
  const { ids } = state;
  const results = {};

  let treeRequests = 0;
  let treePages = 0;
  results.treeLoadSequential = await repeat(5, async () => {
    const pending = [null]; treeRequests = 0; treePages = 0;
    while (pending.length) {
      const parentId = pending.shift();
      let cursor;
      do {
        const query = new URLSearchParams({ limit: '100' });
        if (parentId) query.set('parentId', parentId);
        if (cursor) query.set('cursor', cursor);
        const batch = (await request(`${base}/pages?${query}`, { session })).json();
        treeRequests++;
        for (const page of batch.pages) { treePages++; pending.push(page.id); }
        cursor = batch.nextCursor ?? undefined;
      } while (cursor);
    }
  }, 1);
  results.treeLoadSequential.requests = treeRequests;
  results.treeLoadSequential.pages = treePages;
  const treeProbe = await fetch(`${origin}${base}/page-tree`, { headers: { origin, cookie: session.cookie } });
  if (treeProbe.status === 200) {
    let single;
    results.treeLoadSingle = await repeat(20, async () => { single = (await request(`${base}/page-tree`, { session })).json(); });
    assert.equal(single.pages.length, treePages, 'single tree request must return the same pages as sequential loading');
    assert.equal(single.truncated, false);
    Object.assign(results.treeLoadSingle, { requests: 1, pages: single.pages.length });
  } else await treeProbe.arrayBuffer();

  for (const [name, id] of [['getSmall', ids.smallId], ['getLong300', ids.long300Id], ['getLong1500', ids.long1500Id], ['getImageDoc', ids.imageDocId]]) {
    let bytes = 0;
    results[name] = await repeat(20, async () => { bytes = (await request(`${base}/pages/${id}`, { session })).buffer.length; });
    results[name].responseBytes = bytes;
  }

  const next = rng(20261104);
  for (const [name, id, count] of [['saveSmall', ids.smallId, 20], ['saveLong1500', ids.long1500Id, 10]]) {
    let page = (await request(`${base}/pages/${id}`, { session })).json();
    results[name] = await repeat(count, async () => {
      const children = page.content.editorState.root.children.map((node, index) => index === 1 ? paragraph(sentence(next, 80)) : node);
      page = (await request(`${base}/pages/${id}`, { session, method: 'PATCH',
        body: { clientMutationId: randomUUID(), expectedRevision: page.revision, content: documentOf(children) } })).json();
    }, 1);
  }

  const phrases = { commonWord: '知识库', mixed: state.fixture.mixedPhrase, rare: state.fixture.rarePhrase,
    longTail: state.fixture.tailPhrase, miss: state.fixture.missPhrase, titlePartial: '资料集 4' };
  for (const [name, phrase] of Object.entries(phrases)) {
    let summary;
    results[`search_${name}`] = await repeat(20, async () => {
      const body = (await request(`${base}/search?q=${encodeURIComponent(phrase)}&limit=30`, { session })).json();
      summary = { results: body.results.length, truncated: body.truncated, firstPageId: body.results[0]?.pageId ?? null };
    });
    Object.assign(results[`search_${name}`], { phrase, ...summary });
  }
  assert.equal(results.search_rare.firstPageId, ids.rareId, 'rare phrase must find its page');
  assert.equal(results.search_longTail.firstPageId, ids.long1500Id, 'tail phrase must find the long page');
  assert.equal(results.search_miss.results, 0);

  results.historyFirstPage = await repeat(20, () => request(`${base}/pages/${ids.historyId}/history?limit=30`, { session }));
  let historyVersions = 0;
  results.historyFullPagination = await repeat(5, async () => {
    let before; historyVersions = 0;
    do {
      const body = (await request(`${base}/pages/${ids.historyId}/history?limit=30${before ? `&beforeRevision=${before}` : ''}`, { session })).json();
      historyVersions += body.versions.length;
      before = body.nextBeforeRevision;
    } while (before);
  }, 1);
  results.historyFullPagination.versions = historyVersions;
  results.getLong1500Version1 = await repeat(20, () => request(`${base}/pages/${ids.long1500Id}/history/1`, { session }));
  results.getImage = await repeat(20, () => request(`${base}/attachments/${ids.imageIds[0]}/content`, { session }));
  results.getAllImagesSequential = await repeat(3, async () => {
    for (const id of ids.imageIds) await request(`${base}/attachments/${id}/content`, { session });
  }, 1);

  const storage = JSON.parse(compose('exec', '-T', 'postgres', 'psql', '-U', 'nbase', '-d', 'nbase', '-At', '-c',
    `SELECT json_build_object('databaseBytes', pg_database_size(current_database()),
      'tables', (SELECT json_object_agg(c.relname, pg_total_relation_size(c.oid)) FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'),
      'counts', json_build_object('pages', (SELECT count(*) FROM pages), 'pageVersions', (SELECT count(*) FROM page_versions),
        'receipts', (SELECT count(*) FROM page_mutation_receipts), 'attachments', (SELECT count(*) FROM attachments)))`));
  storage.attachmentDirKiB = Number(compose('exec', '-T', 'nbase', 'du', '-sk', '/data/attachments').split(/\s+/)[0]);
  const containers = execFileSync('docker', ['stats', '--no-stream', '--format', '{{json .}}', `${project}-nbase-1`, `${project}-postgres-1`],
    { encoding: 'utf8' }).trim().split(/\r?\n/).map(line => JSON.parse(line))
    .map(({ Name, CPUPerc, MemUsage, MemPerc }) => ({ Name, CPUPerc, MemUsage, MemPerc }));
  const environment = { measuredAt: new Date().toISOString(), node: process.version, platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, hostMemoryGiB: Math.round(totalmem() / 2 ** 30 * 10) / 10,
    docker: execFileSync('docker', ['version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'], { encoding: 'utf8' }).trim(),
    image: compose('images', 'nbase', '--format', 'json') };
  const report = { project, environment, fixture: state.fixture, sizes: state.sizes, seed: state.seed, results, storage, containers };
  const outDir = join(root, '.data', 'perf');
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const outPath = join(outDir, `${project}-api-${environment.measuredAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(outPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.table(Object.fromEntries(Object.entries(results).map(([key, value]) => [key, { n: value.n, median: value.median, p95: value.p95, max: value.max }])));
  console.log(JSON.stringify({ storage, containers }, null, 2));
  console.log(`Report: ${outPath}`);
}
