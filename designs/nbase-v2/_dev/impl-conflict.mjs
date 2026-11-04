// Minimal conflict-card check + shot: login, open page, bump revision, edit.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const dir = fileURLToPath(new URL('.', import.meta.url));
const shotsDir = join(dir, '..', '_shots', 'impl');
const base = 'http://127.0.0.1:4380/';
const browserPath = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9383;
const profile = join(dir, '.edge-profile-conf');
await rm(profile, { recursive: true, force: true }).catch(() => {});
await mkdir(profile, { recursive: true });
const browser = spawn(browserPath, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new',
  '--no-first-run', '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); }
    catch { await sleep(200); }
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => { socket.onopen = r; });
  let nextId = 0; const pending = new Map(); const listeners = new Set();
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result); return; }
    for (const l of listeners) l(m);
  };
  const send = (m, p = {}) => new Promise((res, rej) => { const id = ++nextId; pending.set(id, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id, method: m, params: p })); });
  const once = m => new Promise(res => { const l = msg => { if (msg.method === m) { listeners.delete(l); res(msg.params); } }; listeners.add(l); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.value;
  const insert = async (v) => send('Input.insertText', { text: v });
  await send('Page.enable'); await send('Runtime.enable');
  await fetch(base + 'api/__reset', { method: 'POST' });
  const l = once('Page.loadEventFired'); await send('Page.navigate', { url: base }); await l; await sleep(700);
  await ev(`document.querySelector('.nb-login input').focus(); 'ok'`); await insert('owner');
  await ev(`document.querySelector('.nb-login input[type="password"]').focus(); 'ok'`); await insert('dev');
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='登录').click(); 'ok'`);
  await sleep(2200);
  await ev(`[...document.querySelectorAll('.nb-tree-title')].find(b=>b.textContent.trim()==='产品原则').closest('button').click(); 'ok'`);
  await sleep(1800);
  console.log('BUMP:', await ev(`fetch('/api/workspaces/ws-1/pages/p-1').then(r=>r.json()).then(p=>fetch('/api/workspaces/ws-1/pages/p-1',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({clientMutationId:'bump',expectedRevision:p.revision,title:p.title})})).then(r=>r.status)`));
  await ev(`document.querySelector('.nbase-editor-content')?.focus(); 'ok'`);
  await insert(' 冲突文本');
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    if (await ev(`!!document.querySelector('.nb-conflict-card')`)) break;
  }
  console.log('CONFLICT:', await ev(`!!document.querySelector('.nb-conflict-card')`));
  console.log('PILL:', await ev(`(document.querySelector('.nb-savepill')||{textContent:'none'}).textContent`));
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(shotsDir, 'conflict.png'), Buffer.from(data, 'base64'));
  console.log('shot: conflict.png');
} finally { browser.kill(); }
