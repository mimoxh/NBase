// Quick measurements for the six-item rework report.
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const dir = fileURLToPath(new URL('.', import.meta.url));
const prof = join(dir, '.edge-measure');
await rm(prof, { recursive: true, force: true }).catch(() => {});
const b = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--remote-debugging-port=9388', `--user-data-dir=${prof}`, '--headless=new', '--no-first-run', '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
try {
  let t;
  for (let i = 0; i < 40 && !t; i++) { try { t = (await (await fetch('http://127.0.0.1:9388/json/list')).json()).find(x => x.type === 'page'); } catch { await sleep(200); } }
  const s = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => { s.onopen = r; });
  let id = 0; const p = new Map();
  s.onmessage = ({ data }) => { const m = JSON.parse(data); if (m.id && p.has(m.id)) { p.get(m.id)(m.result); p.delete(m.id); } };
  const send = (m, pr = {}) => new Promise(r => { p.set(++id, r); s.send(JSON.stringify({ id, method: m, params: pr })); });
  const ev = async e => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.value;
  await send('Page.enable'); await send('Runtime.enable');
  await fetch('http://127.0.0.1:4380/api/__reset', { method: 'POST' });
  await send('Page.navigate', { url: 'http://127.0.0.1:4380/' }); await sleep(1800);
  await ev(`document.querySelector('.nb-login input').focus(); 'ok'`); await send('Input.insertText', { text: 'owner' });
  await ev(`document.querySelector('.nb-login input[type="password"]').focus(); 'ok'`); await send('Input.insertText', { text: 'dev' });
  await ev(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='登录').click(); 'ok'`); await sleep(2500);
  await ev(`[...document.querySelectorAll('.nb-tree-title')].find(x=>x.textContent.trim()==='产品原则').closest('button').click(); 'ok'`); await sleep(2000);
  console.log('ICON font-size:', await ev(`getComputedStyle(document.querySelector('.nb-doc-icon')).fontSize`),
    'height:', await ev(`document.querySelector('.nb-doc-icon').getBoundingClientRect().height`));
  const trig = await ev(`(function(){var b=document.querySelector('.nb-topbar .nb-menu-trigger');var c=getComputedStyle(b);return c.borderTopWidth+'/'+c.borderTopStyle+'/'+c.boxShadow})()`);
  console.log('MORE trigger border/shadow:', trig);
  // history cur pill
  await ev(`document.querySelector('[aria-label="历史版本"]').click(); 'ok'`); await sleep(1200);
  console.log('CUR pill width:', await ev(`document.querySelector('.nb-hist-cur')?.getBoundingClientRect().width`),
    'display:', await ev(`getComputedStyle(document.querySelector('.nb-hist-cur')).display`));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  console.log('PILL height:', await ev(`document.querySelector('.nb-savepill')?.getBoundingClientRect().height`));
  console.log('TOOLBAR wrap/height:', await ev(`getComputedStyle(document.querySelector('.nbase-editor-toolbar')).flexWrap`),
    await ev(`document.querySelector('.nbase-editor-toolbar')?.getBoundingClientRect().height`));
} finally { b.kill(); }
