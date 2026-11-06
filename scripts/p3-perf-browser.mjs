// Disposable P3-06 browser baseline via Chrome DevTools Protocol (local Edge/Chrome, no extra npm dependency).
// Requires a seeded perf instance: node -- scripts/p3-perf-baseline.mjs seed
// Usage: node -- scripts/p3-perf-browser.mjs [path-to-msedge-or-chrome]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = Object.fromEntries((await readFile(join(root, '.env.p3.perf'), 'utf8')).trim().split(/\r?\n/)
  .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const project = config.NBASE_COMPOSE_PROJECT;
assert.match(project, /^nbase-p3-perf-\d{8}$/);
const origin = 'http://127.0.0.1:4328';
assert.equal(config.NBASE_PUBLIC_ORIGIN, origin);
const password = (await readFile(join(root, '.secrets', project, 'owner-password'), 'utf8')).trimEnd();
const state = JSON.parse(await readFile(join(root, '.data', `${project}-perf-state.json`), 'utf8'));
const browserPath = process.argv[2] ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const expectedPages = state.seed.pages;
const port = 9334;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const profile = join(root, '.data', 'perf', `edge-profile-${stamp}`);
await mkdir(profile, { recursive: true });

const browser = spawn(browserPath, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new',
  '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); }
    catch { await sleep(200); }
  }
  assert.ok(target, 'browser did not expose a page target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    } else for (const listener of listeners) listener(message);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const once = method => new Promise(resolve => {
    const listener = message => { if (message.method === method) { listeners.delete(listener); resolve(message.params); } };
    listeners.add(listener);
  });
  const evaluate = async (expression, timeoutMs = 60000) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = (condition, timeoutMs = 60000) => `new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => { let value; try { value = (${condition})(); } catch (error) { return reject(error); }
      if (value) return resolve(value);
      if (performance.now() - started > ${timeoutMs}) return reject(new Error('timeout waiting for ' + ${JSON.stringify(condition)}));
      requestAnimationFrame(tick); };
    tick(); })`;
  const navigate = async url => { const loaded = once('Page.loadEventFired'); await send('Page.navigate', { url }); await loaded; };
  const metrics = async () => {
    await send('HeapProfiler.collectGarbage');
    const values = Object.fromEntries((await send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
    return { jsHeapUsedMiB: Math.round(values.JSHeapUsedSize / 2 ** 20 * 10) / 10, domNodes: values.Nodes };
  };
  const stats = samples => {
    const sorted = [...samples].sort((a, b) => a - b);
    const pick = q => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
    const round = value => Math.round(value * 10) / 10;
    return { n: sorted.length, min: round(sorted[0]), median: round(pick(0.5)), p95: round(pick(0.95)), max: round(sorted.at(-1)) };
  };

  await send('Page.enable'); await send('Runtime.enable'); await send('Performance.enable'); await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'performance.setResourceTimingBufferSize(10000);' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate(origin + '/');
  const loginStatus = await evaluate(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginName: 'owner', password: ${JSON.stringify(password)} }) }).then(r => r.status)`);
  assert.equal(loginStatus, 200);

  const treeReady = waitFor(`() => !document.querySelector('.nb-tree-message') && document.querySelectorAll('.nb-tree-page').length >= ${expectedPages}
    && performance.now()`, 120000);
  const workbench = { cold: [], warm: [] };
  let assets;
  for (const kind of ['cold', 'warm']) {
    for (let i = 0; i < 3; i++) {
      if (kind === 'cold') await send('Network.clearBrowserCache');
      await navigate(origin + '/');
      workbench[kind].push(await evaluate(treeReady, 120000));
      assets ??= await evaluate(`(() => { const entries = performance.getEntriesByType('resource');
        const sum = filter => entries.filter(filter).reduce((total, item) => total + (item.encodedBodySize || 0), 0);
        const nav = performance.getEntriesByType('navigation')[0];
        return { jsBytes: sum(item => item.name.endsWith('.js')), cssBytes: sum(item => item.name.endsWith('.css')),
          apiRequests: entries.filter(item => item.name.includes('/api/')).length, domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd) }; })()`);
    }
  }
  const treeMetrics = await metrics();

  const titles = { small: '资料集 01', long300: '长文档 300 段', long1500: '长文档 1500 段', image: `图片文档 ${state.fixture.images} 张` };
  const readyCondition = {
    small: `() => document.querySelector('.nbase-editor-content')?.children.length >= ${state.fixture.smallParagraphs}`,
    long300: `() => document.querySelector('.nbase-editor-content')?.lastElementChild?.textContent.startsWith('${state.fixture.long300.paragraphs}.')`,
    long1500: `() => document.querySelector('.nbase-editor-content')?.lastElementChild?.textContent.includes(${JSON.stringify(state.fixture.tailPhrase)})`,
    image: `() => { const images = [...document.querySelectorAll('.nbase-editor-content img')];
      return images.length === ${state.fixture.images} && images.every(image => image.complete && image.naturalWidth > 0); }`,
  };
  const open = async name => evaluate(`(async () => {
    const button = [...document.querySelectorAll('.nb-tree-page')].find(item => item.querySelector('.nb-tree-title')?.textContent === ${JSON.stringify(titles[name])});
    if (!button) throw new Error('tree item missing: ' + ${JSON.stringify(titles[name])});
    const started = performance.now(); button.click();
    await ${waitFor(`() => document.querySelector('.page-title')?.value === ${JSON.stringify(titles[name])} && (${readyCondition[name]})()`)};
    return performance.now() - started; })()`);
  const openResults = {};
  for (const name of ['long300', 'long1500', 'image']) {
    const samples = [];
    for (let i = 0; i < 5; i++) { await open('small'); samples.push(await open(name)); }
    openResults[name] = { ...stats(samples), afterOpen: await metrics() };
  }
  const smallSamples = [];
  for (let i = 0; i < 5; i++) { await open('long300'); smallSamples.push(await open('small')); }
  openResults.small = { ...stats(smallSamples), afterOpen: await metrics() };

  const typing = {};
  for (const name of ['small', 'long300', 'long1500']) {
    await open(name);
    await evaluate(`(() => { const editor = document.querySelector('.nbase-editor-content'); editor.focus();
      const node = editor.children[1].lastChild.lastChild ?? editor.children[1].lastChild;
      const range = document.createRange(); range.setStart(node, node.textContent.length); range.collapse(true);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); })()`);
    await sleep(300);
    const typed = '基准输入延迟测量'.repeat(5);
    const samples = [];
    for (const character of typed) {
      const started = performance.now();
      await send('Input.insertText', { text: character });
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      samples.push(performance.now() - started);
    }
    const lastKey = performance.now();
    const inserted = await evaluate(`document.querySelector('.nbase-editor-content').children[1].textContent.includes(${JSON.stringify(typed)})`);
    assert.ok(inserted, `${name}: typed text did not land in the second block`);
    await evaluate(waitFor(`() => !document.querySelector('.nb-savepill.nb-save-saved')`, 2000)).catch(() => {});
    await evaluate(waitFor(`() => !!document.querySelector('.nb-savepill.nb-save-saved')`, 120000), 120000);
    typing[name] = { keystrokeToFrame: stats(samples), lastKeyToServerSavedMs: Math.round(performance.now() - lastKey), afterTyping: await metrics() };
  }

  const version = await send('Browser.getVersion');
  const report = { project, measuredAt: new Date().toISOString(), browser: version.product, viewport: '1440x900 headless',
    expectedPages, assets, workbenchTreeReadyMs: { cold: stats(workbench.cold), warm: stats(workbench.warm) }, treeMetrics,
    openPageMs: openResults, typing };
  const outPath = join(root, '.data', 'perf', `${project}-browser-${stamp}.json`);
  await writeFile(outPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report: ${outPath}`);
  socket.close();
} finally {
  if (process.platform === 'win32' && browser.pid && browser.exitCode === null) {
    spawnSync('taskkill.exe', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else browser.kill();
}
