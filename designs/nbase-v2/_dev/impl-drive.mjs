// CDP driver for the PHASE-2 implementation check against the mock server.
// Prereq: apps/web built, mock-server.mjs running on 127.0.0.1:4380.
// Usage: node impl-drive.mjs
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const dir = fileURLToPath(new URL('.', import.meta.url));
const shotsDir = join(dir, '..', '_shots', 'impl');
const base = 'http://127.0.0.1:4380/';
const browserPath = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9379;
const profile = join(dir, '.edge-profile-impl');

await rm(profile, { recursive: true, force: true }).catch(() => {});
await mkdir(profile, { recursive: true });
await mkdir(shotsDir, { recursive: true });
const browser = spawn(browserPath, [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900', 'about:blank'
], { stdio: 'ignore' });

const results = [];
const report = (name, ok, info) => { results.push({ name, ok }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (info ? '  -- ' + String(info).slice(0, 300) : '')); };

try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); }
    catch { await sleep(200); }
  }
  if (!target) throw new Error('no page target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  const consoleErrors = [];
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else {
      if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('exception: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
      for (const l of listeners) l(m);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const once = m => new Promise(res => {
    const l = msg => { if (msg.method === m) { listeners.delete(l); res(msg.params); } };
    listeners.add(l);
  });
  const nav = async url => { const l = once('Page.loadEventFired'); await send('Page.navigate', { url }); await l; await sleep(600); };
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval error').split('\n')[0]);
    return r.result.value;
  };
  const shot = async name => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(shotsDir, name), Buffer.from(data, 'base64'));
    console.log('shot:', name);
  };
  const clickText = async (text) => ev(`(function(){
    var els=[...document.querySelectorAll('button,[role="option"],[role="menuitem"],a')];
    var n=els.find(e=>e.textContent && e.textContent.trim()===${JSON.stringify(text)})
      || els.find(e=>e.textContent && e.textContent.includes(${JSON.stringify(text)}));
    if(!n) return 'MISSING ${text}';
    n.dispatchEvent(new MouseEvent('click',{bubbles:true})); return 'ok';
  })()`);
  const clickSel = async (sel) => ev(`(function(){var n=document.querySelector(${JSON.stringify(sel)});if(!n)return 'MISSING '+${JSON.stringify(sel)};n.dispatchEvent(new MouseEvent('click',{bubbles:true}));return 'ok'})()`);
  const text = async () => ev('document.body.innerText');
  const waitFor = async (expr, ms = 6000) => {
    const start = Date.now();
    while (Date.now() - start < ms) { if (await ev(`!!(${expr})`)) return true; await sleep(250); }
    return false;
  };
  const sendKeys = async (ch, opts = {}) => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: ch, text: opts.text ? ch : undefined, ...opts });
    }
  };
  const insert = async (value) => send('Input.insertText', { text: value });

  await send('Page.enable'); await send('Runtime.enable');
  await fetch(base + 'api/__reset', { method: 'POST' });

  // 1. Login screen
  await nav(base);
  await waitFor(`document.querySelector('.nb-login')`, 8000);
  report('login screen renders', await ev(`!!document.querySelector('.nb-login')`));
  await shot('login.png');

  await ev(`document.querySelector('.nb-login input').focus(); 'ok'`);
  await insert('owner');
  await ev(`document.querySelector('.nb-login input[type="password"]').focus(); 'ok'`);
  await insert('dev');
  await clickText('登录');
  report('sidebar loads after login', await waitFor(`document.querySelector('.nb-sidebar')`, 10000));

  // wait for the tree/home data before asserting content
  await waitFor(`document.querySelector('.nb-tree-page') || document.querySelector('.nb-home-row')`, 10000);

  // empty-ish home with 最近编辑
  await waitFor(`document.querySelector('.nb-home')`, 8000);
  report('home 最近编辑 visible', (await text()).includes('最近编辑'));

  // 2. Open page
  report('open page row', (await clickText('产品原则')) === 'ok');
  await waitFor(`document.querySelector('.nb-doc-head')`, 8000);
  await sleep(1500);
  report('cover renders', await ev(`!!document.querySelector('.nb-cover-sage')`));
  report('icon inline no box', await ev(`(function(){var el=document.querySelector('.nb-doc-icon');return el && getComputedStyle(el).backgroundColor==='rgba(0, 0, 0, 0)'})()`));
  report('icon renders at ~40px', await ev(`(function(){var el=document.querySelector('.nb-doc-icon');var r=el&&el.getBoundingClientRect();console.log('ICON H:',r&&r.height,'FS:',el&&getComputedStyle(el).fontSize);return r && r.height>=36})()`));
  report('more-menu trigger borderless', await ev(`(function(){var b=document.querySelector('.nb-topbar .nb-menu-trigger');var c=b&&getComputedStyle(b);console.log('MORE BORDER:',c&&c.borderTopWidth,c&&c.borderTopStyle);return c && (c.borderTopWidth==='0px'||c.borderTopStyle==='none')})()`));
  report('toc rail present', await ev(`!!document.querySelector('.nb-toc')`));
  await shot('editor-light.png');

  // 3. Edit -> save states
  await ev(`document.querySelector('.nbase-editor-content')?.focus(); 'ok'`);
  await insert(' 自动保存验证');
  report('pill shows editing/saving', await waitFor(`document.querySelector('.nb-savepill') && document.querySelector('.nb-savepill').textContent !== '已保存'`, 3000));
  report('pill reaches 已保存', await waitFor(`document.querySelector('.nb-savepill') && document.querySelector('.nb-savepill').textContent.includes('已保存')`, 9000));

  // 4. Favorite -> sidebar section
  await clickSel('.nb-star');
  await sleep(600);
  report('sidebar 收藏 section appears', await ev(`(function(){var g=[...document.querySelectorAll('.nb-section-label')].map(e=>e.textContent);return g.includes('收藏')})()`));

  // 5. Icon + cover pickers
  await clickSel('.nb-cover-edit');
  await sleep(300);
  await clickSel('.nb-cover-swatch.nb-cover-rose');
  await sleep(900);
  report('cover changed to rose', await ev(`!!document.querySelector('.nb-cover-rose')`));
  await ev(`(function(){var b=[...document.querySelectorAll('.nb-ghost button')].find(x=>x.textContent.includes('更换封面'));return b?'has':'none'})()`);
  await clickSel('.nb-doc-icon');
  await sleep(300);
  report('emoji picker opens', await ev(`!!document.querySelector('.nb-emoji-grid')`));
  await clickText('🔥');
  await sleep(900);
  report('icon updated', await ev(`(function(){var el=document.querySelector('.nb-doc-icon');return el && el.textContent.includes('🔥')})()`));

  // 6. Search palette
  await sendKeys('k', { modifiers: 2 }); // ctrl
  await waitFor(`document.querySelector('.modal-palette')`, 5000);
  await ev(`(function(){var i=document.querySelector('[aria-label="搜索标题或正文"]');i.focus();return 'ok'})()`);
  await insert('会议');
  await sleep(900);
  report('search groups render', await ev(`(function(){var g=[...document.querySelectorAll('.nb-pal-group')].map(e=>e.textContent);return g.includes('标题')})()`));
  report('search mark highlight', await ev(`!!document.querySelector('.nb-pal-item mark')`));
  await shot('search.png');
  await sendKeys('Escape');
  await sleep(400);

  // 7. History + diff
  await clickSel('[aria-label="历史版本"]');
  await waitFor(`document.querySelector('.modal-large')`, 5000);
  await sleep(800);
  await ev(`(function(){var it=[...document.querySelectorAll('.nb-hist-item')].find(x=>x.textContent.includes('修订 4'));if(it)it.click();return it?'ok':'MISSING'})()`);
  await sleep(800);
  await ev(`(function(){var i=[...document.querySelectorAll('input[type=checkbox]')].find(x=>x.closest('.nb-hist-toggle'));if(i)i.click();return i?'ok':'MISSING'})()`);
  await sleep(1200);
  report('history diff renders', await ev(`document.querySelectorAll('.nb-diff-add,.nb-diff-del,.nb-diff-block-add,.nb-diff-block-del').length > 0`));
  report('cur tag is inline pill <60px', await ev(`(function(){var c=document.querySelector('.nb-hist-cur');var r=c&&c.getBoundingClientRect();console.log('CUR W:',r&&r.width);return r && r.width<60})()`));
  await shot('history-diff.png');
  await sendKeys('Escape');
  await sleep(300);

  // 8. Conflict card: bump server revision, then edit (before trash — pending-action
  // IndexedDB writes can stall in headless Edge and would mask this step)
  await ev(`fetch('/api/workspaces/ws-1/pages/p-1').then(r=>r.json()).then(p=>fetch('/api/workspaces/ws-1/pages/p-1',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({clientMutationId:'bump',expectedRevision:p.revision,title:p.title})})).then(()=> 'ok')`);
  await ev(`document.querySelector('.nbase-editor-content')?.focus(); 'ok'`);
  await insert(' 触发冲突');
  report('conflict card appears', await waitFor(`document.querySelector('.nb-conflict-card')`, 12000));
  await shot('conflict.png');
  // clear conflict state: save-as-copy keeps the draft alive; just reload and re-open
  await fetch(base + 'api/__reset', { method: 'POST' });
  await nav(base);
  await sleep(1200);
  await ev(`document.querySelector('.nb-login input').focus(); 'ok'`);
  await insert('owner');
  await ev(`document.querySelector('.nb-login input[type="password"]').focus(); 'ok'`);
  await insert('dev');
  await clickText('登录');
  await waitFor(`document.querySelector('.nb-sidebar')`, 8000);
  await clickText('产品原则');
  await waitFor(`document.querySelector('.nb-doc-head')`, 8000);
  await sleep(1000);

  // 9. Trash
  await clickText('回收站');
  await waitFor(`document.querySelector('.nb-trash-row')`, 5000);
  report('trash header + rows', (await text()).includes('页面与附件不会自动清理'));
  await shot('trash.png');
  await waitFor(`document.querySelector('.nb-trash-body .nbase-history-preview')`, 6000);
  await clickText('恢复');
  await sleep(2500);
  report('toast after restore', await ev(`(function(){var t=document.querySelector('.nb-toast');return t && t.textContent.length>0})()`));
  await ev(`(function(){var b=document.querySelector('dialog .icon-button');if(b)b.click();return 'x'})()`);
  await sleep(300);

  // 9. Dark mode via account menu — reload+re-login if a dialog is still open (restore stall can leave one)
  if (await ev(`!!document.querySelector('dialog[open]')`)) {
    await nav(base); await sleep(1400);
    if (await ev(`!!document.querySelector('.nb-login input')`)) {
      await ev(`document.querySelector('.nb-login input').focus(); 'ok'`);
      await insert('owner');
      await ev(`document.querySelector('.nb-login input[type="password"]').focus(); 'ok'`);
      await insert('dev'); await clickText('登录');
      await waitFor(`document.querySelector('.nb-sidebar')`, 8000);
    }
    if (!(await ev(`!!document.querySelector('.nb-doc-head')`))) {
      await clickText('产品原则'); await waitFor(`document.querySelector('.nb-doc-head')`, 8000); await sleep(800);
    }
  }
  await clickSel('.nb-ws .nb-menu-trigger');
  await sleep(400);
  await clickText('深色');
  await sleep(700);
  report('dark theme applied', await ev(`document.documentElement.getAttribute('data-theme')==='dark' && !document.querySelector('dialog[open]')`));
  await shot('editor-dark.png');
  await clickSel('.nb-ws .nb-menu-trigger');
  await sleep(300);
  await clickText('浅色');
  await sleep(500);

  // 11. Empty workspace home
  await fetch(base + 'api/__reset?empty=1', { method: 'POST' });
  await nav(base);
  await sleep(1200);
  await ev(`document.querySelector('.nb-login input').focus(); 'ok'`);
  await insert('owner');
  await ev(`document.querySelector('.nb-login input[type="password"]').focus(); 'ok'`);
  await insert('dev');
  await clickText('登录');
  await waitFor(`document.querySelector('.nb-empty')`, 10000);
  report('empty home welcome renders', await ev(`!!document.querySelector('.nb-empty')`));
  await shot('empty.png');
  await fetch(base + 'api/__reset', { method: 'POST' });

  // 12. Mobile: editor at 390px + drawer
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await nav(base);
  await sleep(1200);
  await ev(`document.querySelector('.nb-login input').focus(); 'ok'`);
  await insert('owner');
  await ev(`document.querySelector('.nb-login input[type="password"]').focus(); 'ok'`);
  await insert('dev');
  await clickText('登录');
  await waitFor(`document.querySelector('.nb-sidebar')`, 8000);
  await clickText('产品原则');
  await waitFor(`document.querySelector('.nb-doc-head')`, 8000);
  await sleep(1000);
  report('mobile: sidebar off-canvas', await ev(`(function(){var s=document.querySelector('.nb-sidebar');return s && s.getBoundingClientRect().right<=0})()`));
  report('mobile: pill single line', await ev(`(function(){var p=document.querySelector('.nb-savepill');var r=p&&p.getBoundingClientRect();console.log('PILL H:',r&&r.height);return r && r.height<=32})()`));
  report('mobile: toolbar single row', await ev(`(function(){var t=document.querySelector('.nbase-editor-toolbar');var r=t&&t.getBoundingClientRect();console.log('TOOLBAR H:',r&&r.height,'wrap:',t&&getComputedStyle(t).flexWrap);return t && getComputedStyle(t).flexWrap==='nowrap' && r && r.height<=44})()`));
  await shot('mobile-editor.png');
  console.log('mobile innerWidth:', await ev(`window.innerWidth`));
  await ev(`document.querySelector('.nb-sidebar-toggle').click(); 'ok'`);
  await sleep(600);
  console.log('sidebar cls after click:', await ev(`document.querySelector('.nb-sidebar')?.className`));
  let drawerOk = await waitFor(`document.querySelector('.nb-sidebar-open')`, 5000);
  if (!drawerOk) { // retry once: the first click can land before hydration
    await ev(`document.querySelector('.nb-sidebar-toggle').click(); 'ok'`);
    await sleep(400);
    console.log('sidebar cls after retry:', await ev(`document.querySelector('.nb-sidebar')?.className`));
    drawerOk = await waitFor(`document.querySelector('.nb-sidebar-open')`, 4000);
  }
  report('mobile: drawer opens', drawerOk && await ev(`(function(){var s=document.querySelector('.nb-sidebar');return s && s.getBoundingClientRect().left>=0})()`));
  await shot('mobile-drawer.png');
  await send('Emulation.clearDeviceMetricsOverride');

  // 13. Demo mode (second mock on 4381 returns non-persistent health)
  await nav('http://127.0.0.1:4381/');
  await sleep(2200);
  report('demo: editor renders on shell', await ev(`!!document.querySelector('.demo-workspace .nb-doc-head')`));
  await shot('demo-editor.png');
  await clickText('回收站');
  await waitFor(`document.querySelector('.nb-trash-row')`, 5000);
  report('demo: trash rows + restore', await ev(`document.querySelectorAll('.nb-trash-row .nb-trash-restore').length > 0`));
  await shot('demo-trash.png');
  await sendKeys('Escape');

  // Empty workspace variant: separate mock? skip — covered by unit of Sidebar (favorites hidden).
  report('console clean', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  browser.kill();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) process.exitCode = 1;
}
