// Debug probe for the 3 failing checks: favorites, history diff, conflict.
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const dir = fileURLToPath(new URL('.', import.meta.url));
const base = 'http://127.0.0.1:4380/';
const browserPath = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9381;
const profile = join(dir, '.edge-profile-dbg');
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
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result); return; }
    for (const l of listeners) l(m);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const once = m => new Promise(res => { const l = msg => { if (msg.method === m) { listeners.delete(l); res(msg.params); } }; listeners.add(l); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
  const insert = async (v) => send('Input.insertText', { text: v });
  await send('Page.enable'); await send('Runtime.enable');
  await fetch(base + 'api/__reset', { method: 'POST' });
  const l = once('Page.loadEventFired'); await send('Page.navigate', { url: base }); await l; await sleep(800);
  await ev(`document.querySelector('.nb-login input').focus(); 'ok'`); await insert('owner');
  await ev(`document.querySelector('.nb-login input[type="password"]').focus(); 'ok'`); await insert('dev');
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='登录').click(); 'ok'`);
  await sleep(2000);
  await ev(`[...document.querySelectorAll('.nb-tree-title')].find(b=>b.textContent.trim()==='产品原则').closest('button').click(); 'ok'`);
  await sleep(1800);

  // favorites
  const star = await ev(`(function(){var b=document.querySelector('[aria-label="收藏页面"]');return b?b.outerHTML.slice(0,200):'NO STAR'})()`);
  console.log('STAR:', star);
  await ev(`document.querySelector('[aria-label="收藏页面"]').click(); 'ok'`);
  await sleep(1200);
  console.log('FAV SECTION:', await ev(`[...document.querySelectorAll('.nb-section-label')].map(e=>e.textContent).join('|')`));
  console.log('FAV ROWS:', await ev(`document.querySelectorAll('.nb-fav-row').length`));

  // history
  await ev(`document.querySelector('[aria-label="历史版本"]').click(); 'ok'`);
  await sleep(1600);
  console.log('HIST ITEMS:', await ev(`document.querySelectorAll('.nb-hist-item').length`));
  console.log('HIST TOGGLE:', await ev(`(function(){var i=document.querySelector('.nb-hist-toggle input');if(!i)return 'NO TOGGLE';i.click();return 'clicked'})()`));
  await sleep(1800);
  console.log('DIFF SPANS:', await ev(`document.querySelectorAll('.nb-diff-add,.nb-diff-del,.nb-diff-block-add,.nb-diff-block-del').length`));
  console.log('DIFF PREVIEW TXT:', (await ev(`(document.querySelector('.nb-hist-preview')||{innerText:''}).innerText.slice(0,300)`)));
  await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 'ok'`);
  await sleep(500);
  // close modal via its close button if still open
  await ev(`[...document.querySelectorAll('dialog,[role="dialog"]')].length; 'ok'`);
  console.log('MODAL STILL OPEN:', await ev(`document.querySelectorAll('.modal-large').length`));
  const closer = await ev(`(function(){var b=document.querySelector('.modal-large .icon-button');if(b){b.click();return 'closed'}return 'none'})()`);
  console.log('CLOSER:', closer);
  await sleep(400);

  // trash restore probe
  await ev(`window.__calls=[]; var f=window.fetch; window.fetch=function(u,o){window.__calls.push((o&&o.method||'GET')+' '+u);return f.apply(this,arguments)}; 'ok'`);
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='回收站').click(); 'ok'`);
  await sleep(1500);
  console.log('TRASH ROWS:', await ev(`document.querySelectorAll('.nb-trash-row').length`));
  console.log('TRASH PREVIEW:', await ev(`!!document.querySelector('.nb-trash-body .nbase-history-preview')`));
  console.log('RESTORE BTN:', await ev(`(function(){var b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='恢复');if(!b)return 'none';var d=b.disabled;b.click();return 'clicked disabled='+d})()`));
  await sleep(2500);
  console.log('IDB PROBE:', await ev(`new Promise(res => { setTimeout(() => res('TIMEOUT/HANG'), 2500);
    const r = indexedDB.open('nbase-drafts'); let ver;
    r.onsuccess = () => { ver = r.result.version; const names = [...r.result.objectStoreNames].join(',');
      const tx = r.result.transaction('pending-actions', 'readwrite');
      tx.objectStore('pending-actions').put({ key: 'probe', userId: 'u', workspaceId: 'w', pageId: 'p', operation: 'restore', affectedIds: [], createdAt: 'x', body: {} });
      tx.oncomplete = () => res('ok v' + ver + ' stores:' + names);
      tx.onerror = () => res('tx error ' + tx.error); };
    r.onerror = () => res('open error ' + r.error); r.onblocked = () => res('BLOCKED'); })`));
  console.log('CALLS:', await ev(`window.__calls.join(' | ')`));
  console.log('TOAST:', await ev(`(document.querySelector('.nb-toast')||{textContent:'none'}).textContent`));
  console.log('NOTICE BARS:', await ev(`[...document.querySelectorAll('.nb-notice')].map(n=>n.textContent.slice(0,80)).join(' | ')`));
  await ev(`(function(){var b=document.querySelector('.modal-large .icon-button, .modal-palette .icon-button, dialog .icon-button');if(b)b.click();return 'x'})()`);
  await sleep(400);

  // conflict: bump then edit
  console.log('BUMP:', await ev(`fetch('/api/workspaces/ws-1/pages/p-1').then(r=>r.json()).then(p=>fetch('/api/workspaces/ws-1/pages/p-1',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({clientMutationId:'bump',expectedRevision:p.revision,title:p.title})})).then(r=>r.status)`));
  await ev(`document.querySelector('.nbase-editor-content')?.focus(); 'ok'`);
  await insert(' 触发冲突文本');
  await sleep(2500);
  console.log('PILL:', await ev(`(document.querySelector('.nb-savepill')||{textContent:'none'}).textContent`));
  await sleep(6000);
  console.log('PILL2:', await ev(`(document.querySelector('.nb-savepill')||{textContent:'none'}).textContent`));
  console.log('CONFLICT:', await ev(`!!document.querySelector('.nb-conflict-card')`));
  console.log('BODY SNIP:', (await ev(`document.body.innerText.slice(0,400)`)).replace(/\n/g, ' | '));
} finally { browser.kill(); }
