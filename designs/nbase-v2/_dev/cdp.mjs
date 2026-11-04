// CDP driver for the nbase-v2 prototype: console check, screenshots, functional checks.
// Usage: node cdp.mjs check|shots|func [subargs...]
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const dir = fileURLToPath(new URL('.', import.meta.url));
const shotsDir = join(dir, '..', '_shots');
const base = 'http://127.0.0.1:4311/nbase-v2/';
const browserPath = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9377;
const profile = join(dir, '.edge-profile');
const mode = process.argv[2] || 'check';

await rm(profile, { recursive: true, force: true }).catch(() => {});
await mkdir(profile, { recursive: true });
await mkdir(shotsDir, { recursive: true });
const browser = spawn(browserPath, [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900', 'about:blank'
], { stdio: 'ignore' });

const results = [];
function report(name, ok, info) {
  results.push({ name, ok, info });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (info ? '  — ' + info : ''));
}

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
      if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('exception: ' + JSON.stringify(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
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
  const nav = async url => { const l = once('Page.loadEventFired'); await send('Page.navigate', { url }); await l; await sleep(500); };
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
  const click = sel => `(function(){var n=document.querySelector(${JSON.stringify(sel)});if(!n)return 'MISSING '+${JSON.stringify(sel)};n.dispatchEvent(new MouseEvent('click',{bubbles:true}));return 'ok'})()`;
  const key = (keyName, opts) => `(function(){var t=document.activeElement||document.body;t.dispatchEvent(new KeyboardEvent('keydown',Object.assign({key:${JSON.stringify(keyName)},bubbles:true},${JSON.stringify(opts||{})})));return 'ok'})()`;

  await send('Page.enable'); await send('Runtime.enable');

  /* ============ check: console errors ============ */
  if (mode === 'check' || mode === 'all') {
    for (const u of ['Workspace.html', 'Compare Directions.html']) {
      consoleErrors.length = 0;
      await nav(base + encodeURI(u));
      await sleep(800);
      report('console clean: ' + u, consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 500));
    }
    // a few parameterized loads
    for (const u of ['Workspace.html?dir=b&theme=dark', 'Workspace.html?dir=c&screen=history', 'Workspace.html?dir=a&vp=mobile', 'Workspace.html?screen=login&loginvar=init']) {
      consoleErrors.length = 0;
      await nav(base + u);
      await sleep(500);
      report('console clean: ?' + u.split('?')[1], consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 500));
    }
  }

  /* ============ shots ============ */
  if (mode === 'shots' || mode === 'all') {
    const defs = [
      ['a-editor-light.png', 'Workspace.html?dir=a&theme=light&chrome=0', ''],
      ['a-editor-dark.png', 'Workspace.html?dir=a&theme=dark&chrome=0', ''],
      ['b-editor-light.png', 'Workspace.html?dir=b&theme=light&chrome=0', ''],
      ['b-editor-dark.png', 'Workspace.html?dir=b&theme=dark&chrome=0', ''],
      ['c-editor-light.png', 'Workspace.html?dir=c&theme=light&chrome=0', ''],
      ['c-editor-dark.png', 'Workspace.html?dir=c&theme=dark&chrome=0', ''],
      ['search.png', 'Workspace.html?dir=a&theme=light&chrome=0',
        `(function(){document.querySelector('[data-act=search]').click();var q=document.querySelector('#pal-q');q.value='备份';q.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()`],
      ['history-diff.png', 'Workspace.html?dir=a&theme=light&chrome=0',
        `(function(){document.querySelector('[data-act=history]').click();document.querySelector('#diffsw').click();return 'ok'})()`],
      ['trash.png', 'Workspace.html?dir=a&theme=light&chrome=0', `(function(){document.querySelector('[data-act=trash]').click();return 'ok'})()`],
      ['login.png', 'Workspace.html?dir=a&theme=light&screen=login&chrome=0', ''],
      ['empty.png', 'Workspace.html?dir=a&theme=light&screen=empty&chrome=0', ''],
      ['conflict.png', 'Workspace.html?dir=a&theme=light&screen=conflict&chrome=0', ''],
      ['mobile-a-editor.png', 'Workspace.html?dir=a&theme=light&vp=mobile&chrome=0', '']
    ];
    for (const [name, u, setup] of defs) {
      await nav(base + u);
      await sleep(600);
      if (setup) { await ev(setup); await sleep(500); }
      await shot(name);
    }
    // compare canvas (first rows; lazy iframes near viewport)
    await nav(base + 'Compare%20Directions.html');
    await sleep(5000);
    await shot('compare.png');
  }

  /* ============ func ============ */
  if (mode === 'func' || mode === 'all') {
    await nav(base + 'Workspace.html?chrome=0');
    let r;
    // 0a. default save pill is 已保存 even with sticky persisted state
    r = await ev(`(function(){
      localStorage.setItem('nbase-v2-tweaks', JSON.stringify({save:'conflict'}));
      return document.querySelector('.save-pill .s-label').textContent;})()`);
    await nav(base + 'Workspace.html?chrome=0');
    let r0 = await ev(`document.querySelector('.save-pill .s-label').textContent`);
    report('save pill defaults to 已保存 despite persisted 冲突', r === '已保存' && r0 === '已保存', r0);
    // 0b. page icon has no background box
    r = await ev(`(function(){var i=document.querySelector('.doc-icon');
      return {bg:getComputedStyle(i).backgroundColor,shadow:getComputedStyle(i).boxShadow};})()`);
    report('page icon has no box', (r.bg === 'rgba(0, 0, 0, 0)' || r.bg === 'transparent') && r.shadow === 'none', JSON.stringify(r));

    // 1. tree expand + open
    r = await ev(`(function(){
      var kidsBefore=!!document.querySelector('.trow[data-id=pg]');
      document.querySelector('[data-chev=dev]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      var collapsed=!document.querySelector('.trow[data-id=pg]');
      document.querySelector('[data-chev=dev]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      var row=document.querySelector('.trow[data-id=notes]');row.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      var title=document.querySelector('.doc-title').textContent;
      return {kidsBefore:kidsBefore,collapsed:collapsed,title:title};})()`);
    report('tree collapse/expand + row open', r.kidsBefore && r.collapsed && r.title === '读书笔记', JSON.stringify(r));
    // back to pg
    r = await ev(click('.trow[data-id=pg]')); await sleep(300);
    report('navigate back to pg page', r === 'ok', r);

    // 2. slash menu (insert via +, convert via /)
    r = await ev(`(function(){
      var blk=document.querySelector('#docbody .blk');var plus=blk.querySelector('.gbtn.plus');
      plus.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      var menu=!!document.querySelector('.menu.slash');
      var item=document.querySelector('.slash-item[data-si=divider]');
      var before=document.querySelectorAll('.blk[data-blk=divider]').length;
      item.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      var after=document.querySelectorAll('.blk[data-blk=divider]').length;
      return {menu:menu,before:before,after:after};})()`);
    await sleep(200);
    report('slash menu via + inserts divider', r.menu && r.after === r.before + 1, JSON.stringify(r));
    // '/' convert path: select the empty p that followed the new divider
    r = await ev(`(function(){
      var ps=[].slice.call(document.querySelectorAll('#docbody > .blk[data-blk=p] p'));
      var p=ps.find(function(x){return !x.textContent.trim();});
      if(!p)return {fail:'no empty p'};
      var range=document.createRange();range.selectNodeContents(p);range.collapse(false);
      var sel=getSelection();sel.removeAllRanges();sel.addRange(range);
      document.querySelector('#docbody').dispatchEvent(new KeyboardEvent('keydown',{key:'/',bubbles:true}));
      return {ok:true};})()`);
    await sleep(150);
    r = await ev(`(function(){
      var menu=!!document.querySelector('.menu.slash');
      var item=document.querySelector('.slash-item[data-si=h2]');
      if(item)item.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      return {menu:menu,h2:document.querySelectorAll('#docbody h2').length};})()`);
    report('slash menu via / converts to h2', r.menu && r.h2 >= 4, JSON.stringify(r));

    // 3. Ctrl+K search + Enter opens result
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`);
    await sleep(200);
    r = await ev(`(function(){
      var q=document.querySelector('#pal-q');if(!q)return {fail:'no palette'};
      q.value='备份';q.dispatchEvent(new Event('input',{bubbles:true}));
      var n=document.querySelectorAll('.pal-item').length;
      q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      return {n:n,title:document.querySelector('.doc-title')?document.querySelector('.doc-title').textContent:''};})()`);
    await sleep(300);
    report('Ctrl+K search 备份 + Enter opens page', r.n > 0 && r.title.indexOf('备份') >= 0, JSON.stringify(r));
    // 3b. search dedupe: pg only in 标题 group
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`);
    await sleep(200);
    r = await ev(`(function(){
      var q=document.querySelector('#pal-q');q.value='备份';q.dispatchEvent(new Event('input',{bubbles:true}));
      var secs=[].slice.call(document.querySelectorAll('.pal-sec')).map(function(s){return s.textContent});
      var items=[].slice.call(document.querySelectorAll('.pal-item'));
      var pgRows=items.filter(function(it){return it.textContent.indexOf('PostgreSQL 备份恢复手册')>=0}).length;
      var sel=document.querySelector('.pal-item.sel');return {secs:secs,pgRows:pgRows,selFirst:items[0]===sel};})()`);
    report('search dedupe: page once, in 标题, first selected', r.pgRows === 1 && r.secs.indexOf('标题') >= 0 && r.selFirst, JSON.stringify(r));
    await ev(`(function(){var q=document.querySelector('#pal-q');q.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return 'ok'})()`);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);

    // 4. history restore
    await ev(click('[data-act=history]')); await sleep(300);
    r = await ev(`(function(){
      document.querySelector('#diffsw').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      var spans=document.querySelectorAll('#hist-preview .diff-view span.diff-del').length +
        document.querySelectorAll('#hist-preview .diff-view span.diff-add').length;
      var todoStrike=[].slice.call(document.querySelectorAll('#hist-preview .diff-view .todo.done .li-content'))
        .filter(function(n){return getComputedStyle(n).textDecoration.indexOf('line-through')>=0}).length;
      return {inlineSpans:spans,todoStrike:todoStrike};})()`);
    report('history diff: inline char diff, no todo strikethrough', r.inlineSpans > 0 && r.todoStrike === 0, JSON.stringify(r));
    await ev(`(function(){document.querySelector('#diffsw').dispatchEvent(new MouseEvent('click',{bubbles:true}));return 'ok'})()`);
    r = await ev(`(function(){
      var items=document.querySelectorAll('.hist-item');if(items.length<2)return {fail:'no versions'};
      items[1].dispatchEvent(new MouseEvent('click',{bubbles:true}));
      document.querySelector('[data-hrestore]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      var toast=document.querySelector('.toast')?document.querySelector('.toast').textContent:'';
      return {toast:toast};})()`);
    report('history restore shows toast', r.toast.indexOf('已恢复') >= 0, JSON.stringify(r));

    // 5. trash restore incl root-fallback
    await ev(click('[data-act=trash]')); await sleep(300);
    r = await ev(`(function(){return {header:!!document.querySelector('.trash-titlebar'),
      note:document.querySelector('.trash-titlebar .tn')?document.querySelector('.trash-titlebar .tn').textContent:''};})()`);
    report('trash header + note', r.header && r.note.indexOf('自动清理') >= 0, JSON.stringify(r));
    r = await ev(`(function(){
      var btns=[].slice.call(document.querySelectorAll('[data-tr]'));
      var orphanBtn=btns.find(function(b){return b.closest('.trash-item').textContent.indexOf('装修报价单')>=0;});
      if(!orphanBtn)return {fail:'orphan not found'};
      orphanBtn.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      return {toast:document.querySelector('.toast')?document.querySelector('.toast').textContent:''};})()`);
    await sleep(300);
    report('trash restore orphan → root toast', r.toast && r.toast.indexOf('根目录') >= 0, JSON.stringify(r));

    // 6. delete current page + undo
    await ev(click('[data-act=pagemenu]')); await sleep(200);
    r = await ev(`(function(){
      var del=document.querySelector('[data-m=del]');if(!del)return {fail:'no del'};
      var title=document.querySelector('.doc-title').textContent;
      del.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      return {title:title};})()`);
    await sleep(300);
    r = await ev(`(function(){
      var undo=document.querySelector('.toast button');if(!undo)return {fail:'no undo btn'};
      undo.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      var back=!!document.querySelector('.trow[data-id=pg]');
      return {back:back};})()`);
    report('delete → toast 撤销 restores tree row', r.back === true, JSON.stringify(r));

    // 7. conflict 另存为副本
    await nav(base + 'Workspace.html?chrome=0&screen=conflict'); await sleep(300);
    r = await ev(`(function(){
      var b=document.querySelector('[data-c=copy]');if(!b)return {fail:'no copy btn'};
      b.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      var t=document.querySelector('.doc-title');return {title:t?t.textContent:''};})()`);
    report('conflict 另存为副本 opens copy page', r.title.indexOf('副本') >= 0, JSON.stringify(r));

    // 8. login validation
    await nav(base + 'Workspace.html?chrome=0&screen=login'); await sleep(200);
    r = await ev(`(function(){
      document.querySelector('[data-act=login]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      var e1=document.querySelector('[data-err=user]').textContent;
      document.querySelector('#lg-user').value='林';
      document.querySelector('#lg-pass').value='wrong';
      document.querySelector('[data-act=login]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      var e2=document.querySelector('[data-err=pass]').textContent;
      document.querySelector('#lg-pass').value='ok';
      document.querySelector('[data-act=login]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      return {e1:e1,e2:e2};})()`);
    await sleep(900);
    var r2 = await ev(`(function(){return {editor:!!document.querySelector('.shell'),login:!!document.querySelector('.login-screen')}})()`);
    report('login validation + success enters editor', r.e1.length > 0 && r.e2.indexOf('不正确') >= 0 && r2.editor && !r2.login, JSON.stringify([r, r2]));

    // 9. URL params override
    await nav(base + 'Workspace.html?chrome=0&dir=b&theme=dark&screen=empty&vp=desktop');
    r = await ev(`(function(){var h=document.documentElement;return {dir:h.dataset.dir,theme:h.dataset.theme,empty:!!document.querySelector('.empty-hero')}})()`);
    report('URL params override (dir=b dark empty)', r.dir === 'b' && r.theme === 'dark' && r.empty, JSON.stringify(r));
  }

  const fails = results.filter(x => !x.ok);
  console.log('\n' + (fails.length ? fails.length + ' FAILURES' : 'ALL PASSED') + ' (' + results.length + ' checks)');
} finally {
  browser.kill();
  try { await rm(profile, { recursive: true, force: true }); } catch {}
}
process.exit(results.some(r => !r.ok) ? 1 : 0);
