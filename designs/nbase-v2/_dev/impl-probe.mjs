import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const dir = fileURLToPath(new URL('.', import.meta.url));
const prof = join(dir, '.edge-probe');
await rm(prof, { recursive: true, force: true }).catch(() => {});
const b = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--remote-debugging-port=9387', `--user-data-dir=${prof}`, '--headless=new', '--no-first-run', '--disable-gpu', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
try {
  let t;
  for (let i = 0; i < 40 && !t; i++) { try { t = (await (await fetch('http://127.0.0.1:9387/json/list')).json()).find(x => x.type === 'page'); } catch { await sleep(200); } }
  const s = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => { s.onopen = r; });
  let id = 0; const p = new Map();
  s.onmessage = ({ data }) => { const m = JSON.parse(data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result); p.delete(m.id); } };
  const send = (m, pr = {}) => new Promise(r => { p.set(++id, r); s.send(JSON.stringify({ id, method: m, params: pr })); });
  const ev = async e => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.value;
  await send('Page.enable'); await send('Runtime.enable');
  s.onmessage && s.addEventListener?.('message', () => {});
  await send('Page.navigate', { url: 'http://127.0.0.1:4381/' }); await sleep(4000);
  console.log('DEMO BODY:', await ev(`document.body.innerText.slice(0,300)`));
  console.log('DEMO CLS:', await ev(`document.querySelector('.nb-app')?.className || 'none'`));
  console.log('DOC HEAD:', await ev(`!!document.querySelector('.nb-doc-head')`));
  // mobile drawer on persistent — metrics override BEFORE nav (driver's order)
  await fetch('http://127.0.0.1:4380/api/__reset', { method: 'POST' });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:4380/' }); await sleep(1800);
  await ev(`document.querySelector('.nb-login input').focus(); 'ok'`); await send('Input.insertText', { text: 'owner' });
  await ev(`document.querySelector('.nb-login input[type="password"]').focus(); 'ok'`); await send('Input.insertText', { text: 'dev' });
  await ev(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='登录').click(); 'ok'`); await sleep(2500);
  await ev(`[...document.querySelectorAll('.nb-tree-title')].find(x=>x.textContent.trim()==='产品原则').closest('button').click(); 'ok'`); await sleep(1500);
  console.log('W:', await ev(`window.innerWidth`));
  console.log('SB right:', await ev(`document.querySelector('.nb-sidebar')?.getBoundingClientRect().right`));
  console.log('TOGGLES:', await ev(`document.querySelectorAll('.nb-sidebar-toggle').length`));
  console.log('TOGGLE:', await ev(`(function(){var x=document.querySelector('.nb-sidebar-toggle');if(x){x.click();return 'clicked'}return 'none'})()`));
  await sleep(800);
  console.log('OPEN CLS:', await ev(`document.querySelector('.nb-sidebar')?.className`));
  console.log('APP CLS:', await ev(`document.querySelector('.nb-app')?.className`));
} finally { b.kill(); }
