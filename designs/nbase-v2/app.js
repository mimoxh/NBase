/* NBase v2 design prototype — vanilla JS app.
   State + rendering + interactions. No modules, no deps. */
(function () {
  'use strict';
  var D = window.NBASE_DATA;
  var app = document.getElementById('app');
  var vp = document.getElementById('vp');
  var root = document.documentElement;

  /* ================= state ================= */
  var LS_KEY = 'nbase-v2-tweaks';
  var params = new URLSearchParams(location.search);
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) {}
  function pick(name, valid, dflt) {
    var v = params.get(name);
    if (v && valid.indexOf(v) >= 0) return v;
    if (saved[name] && valid.indexOf(saved[name]) >= 0) return saved[name];
    return dflt;
  }
  var SAVE_STATES = ['editing', 'saving', 'saved', 'offline', 'failed', 'conflict'];
  var STICKY_SAVES = ['offline', 'failed', 'conflict'];
  function resolveSave() {
    var sp = params.get('save');
    if (sp && SAVE_STATES.indexOf(sp) >= 0) return sp;
    if (params.get('screen') === 'conflict') return 'conflict';
    if (params.get('screen')) return 'saved';
    if (saved.save && STICKY_SAVES.indexOf(saved.save) >= 0) return 'saved';
    return saved.save && SAVE_STATES.indexOf(saved.save) >= 0 ? saved.save : 'saved';
  }
  var state = {
    dir: pick('dir', ['a', 'b', 'c'], 'a'),
    theme: pick('theme', ['light', 'dark'], 'light'),
    screen: pick('screen', ['editor', 'search', 'history', 'trash', 'login', 'empty', 'conflict'], 'editor'),
    save: resolveSave(),
    vpMode: pick('vp', ['desktop', 'mobile'], 'desktop'),
    bodyfont: pick('bodyfont', ['serif', 'sans'], 'serif'),
    loginvar: pick('loginvar', ['login', 'init'], 'login'),
    tweaks: params.has('tweaks') ? params.get('tweaks') === '1' : !!saved.tweaks,
    chrome: params.get('chrome') !== '0'
  };
  var pages = D.pages, rootOrder = D.rootOrder.slice(), trashList = D.trash.slice();
  var currentId = 'pg';
  var expanded = { notes: true, dev: true };
  var recent = D.recent.slice();
  var openOverlay = null;       // 'palette'|'history'|'trash'|'menu'|'dialog'|'src'|'emoji'|'conflict'
  var overlayEl = null;
  var saveTimers = [];
  var toastTimer = null;
  var sidebarHidden = state.vpMode === 'mobile' || state.dir === 'c';
  var sidebarPeek = false;
  var sidebarPinned = false;
  var lastFocus = null;

  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        dir: state.dir, theme: state.theme, screen: state.screen, save: state.save,
        vp: state.vpMode, bodyfont: state.bodyfont, loginvar: state.loginvar, tweaks: state.tweaks
      }));
    } catch (e) {}
  }

  /* ================= helpers ================= */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  function richHTML(rich) {
    return (rich || []).map(function (r) {
      if (typeof r === 'string') return esc(r);
      var inner = esc(r.t);
      if (r.eq) return '<span class="eq-inline">' + inner + '</span>';
      if (r.code) return '<code class="inl">' + inner + '</code>';
      if (r.link) return '<a href="#" onclick="return false">' + inner + '</a>';
      var out = inner;
      if (r.b) out = '<strong>' + out + '</strong>';
      if (r.i) out = '<em>' + out + '</em>';
      if (r.s) out = '<s>' + out + '</s>';
      return out;
    }).join('');
  }
  function uid() { return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 999); }

  var SVG = {
    search: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9h6.6L12 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    menu: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    side: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="M6.5 2.5v11" stroke="currentColor" stroke-width="1.3"/></svg>',
    dl: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2.5v8m0 0L5 7.5m3 3l3-3M3 12.5h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    img: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="1.5" y="2.5" width="15" height="13" rx="2" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="7" r="1.4" fill="currentColor"/><path d="M3 13.5l4-4 3 3 2.5-2.5 2.5 2.5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    restore: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2.5 6.5A6 6 0 1 1 2 9.5M2.5 6.5V3m0 3.5H6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    check: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5L13 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    eye: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/></svg>',
    chevD: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  function icon(name) { return SVG[name] || ''; }

  /* ================= block rendering ================= */
  var GUTTER = '<span class="gutter" contenteditable="false"><button class="gbtn plus" title="添加块" aria-label="添加块">+</button><button class="gbtn drag" title="拖动" aria-label="拖动块">⋮⋮</button></span>';

  function blockHTML(b, opts) {
    var g = opts && opts.noGutter ? '' : GUTTER;
    var ce = opts && opts.static ? ' contenteditable="false"' : '';
    switch (b.t) {
      case 'h1': return '<div class="blk" data-blk="h1"' + ce + '>' + g + '<h1>' + richHTML(b.rich) + '</h1></div>';
      case 'h2': return '<div class="blk" data-blk="h2"' + ce + '>' + g + '<h2>' + richHTML(b.rich) + '</h2></div>';
      case 'h3': return '<div class="blk" data-blk="h3"' + ce + '>' + g + '<h3>' + richHTML(b.rich) + '</h3></div>';
      case 'bullet': return '<div class="blk" data-blk="bullet"' + ce + '>' + g + '<div class="li"><span class="li-marker">•</span><span class="li-content">' + richHTML(b.rich) + '</span></div></div>';
      case 'num': return '<div class="blk" data-blk="num"' + ce + '>' + g + '<div class="li"><span class="li-marker">' + (b.n || '') + '.</span><span class="li-content">' + richHTML(b.rich) + '</span></div></div>';
      case 'todo': return '<div class="blk" data-blk="todo"' + ce + '>' + g + '<div class="todo' + (b.checked ? ' done' : '') + '"><input type="checkbox"' + (b.checked ? ' checked' : '') + ' aria-label="待办"><span class="li-content">' + richHTML(b.rich) + '</span></div></div>';
      case 'callout': return '<div class="blk" data-blk="callout"' + ce + '>' + g + '<div class="callout"><span class="c-icon">' + esc(b.icon || '💡') + '</span><span class="li-content">' + richHTML(b.rich) + '</span></div></div>';
      case 'quote': return '<div class="blk" data-blk="quote"' + ce + '>' + g + '<div class="quote"><span class="li-content">' + richHTML(b.rich) + '</span></div></div>';
      case 'code': return '<div class="blk" data-blk="code" contenteditable="false">' + g + '<div class="codeblock"><div class="code-head"><span class="lang">' + esc(b.lang || 'text') + '</span><button class="code-copy">复制</button></div><pre>' + colorCode(b.code || '') + '</pre></div></div>';
      case 'eq': return '<div class="blk" data-blk="eq" contenteditable="false">' + g + '<div class="equation">' + esc(b.tex || '') + '</div></div>';
      case 'table': return '<div class="blk" data-blk="table" contenteditable="false">' + g + '<table><tbody>' + (b.rows || []).map(function (row, ri) {
        var tag = ri === 0 ? 'th' : 'td';
        return '<tr>' + row.map(function (cell) { return '<' + tag + '>' + esc(cell) + '</' + tag + '>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
      case 'attachment': return '<div class="blk" data-blk="attachment" contenteditable="false">' + g + '<div class="attach"><span class="a-thumb">' + icon('img') + '</span><span class="a-meta"><span class="a-name">' + esc(b.name) + '</span><br><span class="a-size">' + esc(b.size) + '</span></span><button class="a-dl" aria-label="下载附件">' + icon('dl') + '</button></div></div>';
      case 'divider': return '<div class="blk" data-blk="divider" contenteditable="false">' + g + '<hr class="hr"></div>';
      case 'page': {
        var p = pages[b.page];
        return '<div class="blk" data-blk="page" data-page="' + esc(b.page) + '" contenteditable="false">' + g +
          '<div class="pagelink" role="link"><span>' + (p ? esc(p.icon) : '📄') + '</span><span class="pl-title">' + (p ? esc(p.title) : '（页面已删除）') + '</span></div></div>';
      }
      default: return '<div class="blk" data-blk="p"' + ce + '>' + g + '<p>' + richHTML(b.rich) + '</p></div>';
    }
  }
  function blocksToHTML(blocks, opts) {
    var n = 0;
    return blocks.map(function (b) {
      var c = Object.assign({}, b);
      if (c.t === 'num') c.n = ++n; else n = 0;
      return blockHTML(c, opts);
    }).join('');
  }
  function colorCode(code) {
    return esc(code).split('\n').map(function (line) {
      if (/^\s*#/.test(line)) return '<span class="tok-c">' + line + '</span>';
      return line
        .replace(/^(\s*)([a-z_]+)/i, '$1<span class="tok-f">$2</span>')
        .replace(/("[^"]*")/g, '<span class="tok-s">$1</span>')
        .replace(/(--[a-z-]+)/g, '<span class="tok-k">$1</span>');
    }).join('\n');
  }

  /* ================= markdown ================= */
  function innerToMd(node) {
    var out = '';
    node.childNodes.forEach(function (n) {
      if (n.nodeType === 3) { out += n.textContent; return; }
      var t = n.textContent;
      if (n.classList && n.classList.contains('eq-inline')) out += '$' + t + '$';
      else if (n.tagName === 'CODE') out += '`' + t + '`';
      else if (n.tagName === 'STRONG' || n.tagName === 'B') out += '**' + innerToMd(n) + '**';
      else if (n.tagName === 'EM' || n.tagName === 'I') out += '*' + innerToMd(n) + '*';
      else if (n.tagName === 'S') out += '~~' + innerToMd(n) + '~~';
      else if (n.tagName === 'A') out += '[' + t + '](url)';
      else if (n.tagName === 'BR') out += '\n';
      else out += innerToMd(n);
    });
    return out;
  }
  function domToMarkdown(bodyEl, title) {
    var lines = [];
    bodyEl.querySelectorAll(':scope > .blk').forEach(function (blk) {
      var t = blk.dataset.blk;
      var leaf = blk.querySelector('h1,h2,h3,p,.li-content,.quote,.callout');
      var md = leaf ? innerToMd(leaf).trim() : '';
      switch (t) {
        case 'h1': lines.push('# ' + md); break;
        case 'h2': lines.push('## ' + md); break;
        case 'h3': lines.push('### ' + md); break;
        case 'bullet': lines.push('- ' + md); break;
        case 'num': lines.push('1. ' + md); break;
        case 'todo': lines.push('- [' + (blk.querySelector('input').checked ? 'x' : ' ') + '] ' + md); break;
        case 'callout': lines.push('> [!NOTE] ' + md); break;
        case 'quote': lines.push('> ' + md); break;
        case 'code': lines.push('```' + (blk.querySelector('.lang').textContent || '') + '\n' + blk.querySelector('pre').textContent + '\n```'); break;
        case 'eq': lines.push('$$' + blk.querySelector('.equation').textContent.trim() + '$$'); break;
        case 'table': {
          var rows = [].slice.call(blk.querySelectorAll('tr')).map(function (tr) {
            return '| ' + [].slice.call(tr.children).map(function (c) { return c.textContent.trim(); }).join(' | ') + ' |';
          });
          if (rows.length) rows.splice(1, 0, '|' + ' --- |'.repeat(blk.querySelectorAll('tr')[0].children.length));
          lines.push(rows.join('\n'));
          break;
        }
        case 'attachment': lines.push('[附件: ' + blk.querySelector('.a-name').textContent + ']'); break;
        case 'divider': lines.push('---'); break;
        case 'page': lines.push('→ ' + blk.querySelector('.pl-title').textContent); break;
        default: lines.push(md);
      }
      lines.push('');
    });
    return '# ' + title + '\n\n' + lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }
  function download(name, text) {
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }

  /* ================= page model ops ================= */
  function pagePath(id) {
    var chain = [], cur = pages[id];
    while (cur) { chain.unshift(cur); cur = cur.parent ? pages[cur.parent] : null; }
    return chain;
  }
  function pagePathText(id) {
    return pagePath(id).map(function (p) { return p.title; }).join(' / ');
  }
  function descendants(id) {
    var out = [];
    (pages[id].children || []).forEach(function (c) { out.push(c); out = out.concat(descendants(c)); });
    return out;
  }
  function openPage(id) {
    if (!pages[id]) return;
    currentId = id;
    var p = pages[id], cur = p.parent;
    while (cur) { expanded[cur] = true; cur = pages[cur] ? pages[cur].parent : null; }
    recent = [id].concat(recent.filter(function (r) { return r !== id; })).slice(0, 5);
    render();
  }
  function createPage(parentId, title) {
    var id = uid();
    pages[id] = { id: id, icon: '📄', cover: null, title: title || '无标题', parent: parentId || null, children: [], blocks: [{ t: 'p', rich: [''] }] };
    if (parentId) { pages[parentId].children.push(id); expanded[parentId] = true; }
    else rootOrder.push(id);
    if (state.screen === 'empty') state.screen = 'editor';
    openPage(id);
    var t = app.querySelector('.doc-title');
    if (t && t.textContent === '无标题') { placeCaret(t); }
    return id;
  }
  function subtreeIds(id) { return [id].concat(descendants(id)); }
  function deletePage(id) {
    var p = pages[id];
    var ids = subtreeIds(id);
    var entry = { id: 't' + Date.now().toString(36), icon: p.icon, title: p.title, origParent: p.parent, deletedAt: '刚刚', childCount: ids.length - 1, restoreIds: ids };
    trashList.unshift(entry);
    if (p.parent && pages[p.parent]) {
      var arr = pages[p.parent].children;
      arr.splice(arr.indexOf(id), 1);
      entry.parentId = p.parent;
    } else {
      rootOrder.splice(rootOrder.indexOf(id), 1);
      entry.parentId = null;
    }
    ids.forEach(function (x) { pages[x]._deleted = true; });
    var next = entry.parentId && pages[entry.parentId] ? entry.parentId : rootOrder[0];
    return { entry: entry, next: next };
  }
  function undoDelete(entry) {
    var ti = trashList.indexOf(entry);
    if (ti >= 0) trashList.splice(ti, 1);
    (entry.restoreIds || []).forEach(function (x) { delete pages[x]._deleted; });
    var id = entry.restoreIds[0];
    if (entry.parentId && pages[entry.parentId]) pages[entry.parentId].children.push(id);
    else if (!entry.parentId) rootOrder.push(id);
  }
  function restoreTrash(item) {
    var i = trashList.indexOf(item);
    if (i < 0) return;
    if (item.restoreIds) { // page deleted this session: bring back the real subtree
      trashList.splice(i, 1);
      var rid = item.restoreIds[0];
      var parentOk = item.parentId && pages[item.parentId] && !pages[item.parentId]._deleted;
      item.restoreIds.forEach(function (x) { delete pages[x]._deleted; });
      if (parentOk) { pages[item.parentId].children.push(rid); expanded[item.parentId] = true; }
      else { pages[rid].parent = null; rootOrder.push(rid); }
      render();
      toast(parentOk ? '已恢复「' + item.title + '」' : '原上级页面已不在，已恢复到根目录');
      return;
    }
    trashList.splice(i, 1);
    var ok = item.origParent && pages[item.origParent] && !pages[item.origParent]._deleted;
    var id = item.id + '-r';
    pages[id] = { id: id, icon: item.icon, title: item.title, parent: ok ? item.origParent : null, children: [], blocks: [{ t: 'p', rich: ['（从回收站恢复的演示页面）'] }] };
    if (ok) { pages[item.origParent].children.push(id); expanded[item.origParent] = true; }
    else rootOrder.push(id);
    render();
    toast(ok ? '已恢复「' + item.title + '」' : '原上级页面已不在，已恢复到根目录');
  }

  /* ================= toast ================= */
  function toast(msg, action) {
    var w = app.querySelector('.toast-wrap');
    if (!w) { w = el('<div class="toast-wrap"></div>'); app.appendChild(w); }
    w.innerHTML = '<div class="toast"><span>' + esc(msg) + '</span>' + (action ? '<button>' + esc(action.label) + '</button>' : '') + '</div>';
    if (action) w.querySelector('button').onclick = function () { clearTimeout(toastTimer); w.innerHTML = ''; action.fn(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { w.innerHTML = ''; }, 4200);
  }

  /* ================= save cycle ================= */
  var SAVE_LABEL = { editing: '编辑中', saving: '保存中', saved: '已保存', offline: '离线', failed: '保存失败', conflict: '冲突' };
  function setSave(s) {
    state.save = s;
    var pill = app.querySelector('.save-pill');
    if (pill) { pill.dataset.state = s; pill.querySelector('.s-label').textContent = SAVE_LABEL[s]; }
    renderBanners();
    var sel = document.querySelector('.tweaks select[data-tw="save"]');
    if (sel) sel.value = s;
  }
  function bumpSave() {
    if (['offline', 'failed', 'conflict'].indexOf(state.save) >= 0) { setSave(state.save); return; }
    saveTimers.forEach(clearTimeout); saveTimers = [];
    setSave('editing');
    saveTimers.push(setTimeout(function () { setSave('saving'); }, 800));
    saveTimers.push(setTimeout(function () { setSave('saved'); }, 1500));
  }
  function renderBanners() {
    var host = app.querySelector('.banner-host');
    if (!host) return;
    var h = '';
    if (state.save === 'offline') h = '<div class="banner amber">离线 · 修改已保存在本机草稿，恢复连接后自动继续保存</div>';
    if (state.save === 'failed') h = '<div class="banner red"><span style="flex:1">保存失败 · 最新修改仍在本机草稿中</span><button class="b-btn" data-act="retry">重试</button><button class="b-btn" data-act="dl">下载内容</button></div>';
    host.innerHTML = h;
    var r = host.querySelector('[data-act="retry"]');
    if (r) r.onclick = function () { setSave('saving'); setTimeout(function () { setSave('saved'); }, 900); };
    var d = host.querySelector('[data-act="dl"]');
    if (d) d.onclick = function () { download(pages[currentId].title + '.md', domToMarkdown(app.querySelector('.doc-body'), pages[currentId].title)); };
  }

  /* ================= shell render ================= */
  function treeRows(ids, depth) {
    var out = '';
    ids.forEach(function (id) {
      var p = pages[id];
      if (!p || p._deleted) return;
      var kids = (p.children || []).filter(function (c) { return pages[c] && !pages[c]._deleted; });
      var open = !!expanded[id];
      out += '<div class="trow' + (id === currentId ? ' active' : '') + '" data-id="' + id + '" style="padding-left:' + (depth * 14) + 'px">' +
        '<button class="chev' + (kids.length ? (open ? ' open' : '') : ' leaf') + '" data-chev="' + id + '" aria-label="展开">▸</button>' +
        '<span class="ticon">' + esc(p.icon) + '</span><span class="ttitle">' + esc(p.title) + '</span>' +
        '<button class="tbtn more" data-more="' + id + '" aria-label="更多">⋯</button>' +
        '<button class="tbtn add" data-add="' + id + '" aria-label="新建子页面">+</button></div>';
      if (kids.length && open) out += '<div class="tree-children">' + treeRows(kids, depth + 1) + '</div>';
    });
    return out;
  }

  function sidebarHTML(emptyMode) {
    var recentRows = recent.filter(function (id) { return pages[id] && !pages[id]._deleted; }).slice(0, 4).map(function (id) {
      var p = pages[id];
      return '<button class="sb-row" data-open="' + id + '"><span class="ticon">' + esc(p.icon) + '</span><span class="grow">' + esc(p.title) + '</span></button>';
    }).join('');
    var sections = '';
    if (state.dir === 'b') {
      sections = '<div class="sb-sec">收藏</div>' +
        '<button class="sb-row" data-open="pg"><span class="ticon">🐘</span><span class="grow">备份恢复手册</span></button>' +
        '<button class="sb-row" data-open="beef"><span class="ticon">🍅</span><span class="grow">番茄牛腩</span></button>' +
        '<div class="sb-sec">页面</div>';
    } else {
      sections = '<div class="sb-sec">页面</div>';
    }
    var tree = emptyMode
      ? '<div class="tree-empty">还没有页面<br>点击下方「新建页面」开始</div>'
      : '<div class="tree">' + treeRows(rootOrder, 0) + '</div>';
    var pinBtn = state.dir === 'c'
      ? '<button class="sb-row" data-act="pin" style="margin-top:4px"><span>📌</span><span class="grow">' + (sidebarPinned ? '取消固定侧栏' : '固定侧栏') + '</span></button>'
      : '';
    return '<aside class="sidebar" id="sidebar">' +
      '<div class="sidebar-scroll">' +
        '<button class="ws-switcher" data-act="ws"><span class="ws-avatar">林</span><span class="ws-name">林的空间</span><span style="color:var(--faint)">' + icon('chevD') + '</span></button>' +
        '<button class="sb-row" data-act="search">' + icon('search') + '<span class="grow">搜索</span><kbd>Ctrl K</kbd></button>' +
        (emptyMode ? '' : '<div class="sb-sec">最近</div>' + (recentRows || '<div class="tree-empty">暂无</div>')) +
        '<button class="sb-row" data-act="trash">' + icon('trash') + '<span class="grow">回收站</span></button>' +
        sections + tree + pinBtn +
      '</div>' +
      '<div class="sb-bottom">' +
        '<button class="sb-row" data-act="newpage"><span style="width:20px">＋</span><span class="grow">新建页面</span></button>' +
        '<button class="sb-row" data-act="import"><span style="width:20px">⇪</span><span class="grow">导入</span></button>' +
      '</div></aside>';
  }

  function topbarHTML() {
    var chain = pagePath(currentId);
    var crumbs = chain.map(function (p, i) {
      var sep = i > 0 ? '<span class="c-sep">/</span>' : '';
      var last = i === chain.length - 1;
      return sep + (last
        ? '<span class="c-item" style="color:var(--text)">' + esc(p.icon) + ' ' + esc(p.title) + '</span>'
        : '<button class="c-item" data-open="' + p.id + '">' + esc(p.icon) + ' ' + esc(p.title) + '</button>');
    }).join('');
    var histBtn = '<button class="tb-textbtn" data-act="history">' + icon('clock') + ' 历史</button>';
    return '<header class="topbar" id="topbar">' +
      '<button class="tb-btn" data-act="sidebar" aria-label="侧栏">' + icon('menu') + '</button>' +
      '<nav class="crumbs">' + crumbs + '</nav>' +
      '<span class="tb-edited">林 · 3 分钟前编辑</span>' +
      '<div class="tb-right">' +
        '<span class="save-pill" data-state="' + state.save + '"><span class="dot"></span><span class="s-label">' + SAVE_LABEL[state.save] + '</span></span>' +
        histBtn +
        '<button class="tb-btn" data-act="pagemenu" aria-label="页面菜单">⋯</button>' +
      '</div></header>';
  }

  function docHTML() {
    var p = pages[currentId];
    var coverCls = p.cover ? 'cover ' + 'cover-' + p.cover : 'cover none';
    var iconOverlap = state.dir === 'b' ? '0' : '1';
    var head = state.dir === 'b'
      ? '<div class="doc-head-row"><button class="doc-icon" data-act="emoji" style="font-size:var(--icon-size);width:auto;height:auto">' + esc(p.icon) + '</button>' +
        '<div style="flex:1;min-width:0"><div class="ghost-actions"><button class="ghost-btn" data-act="emoji">☺ 添加图标</button><button class="ghost-btn" data-act="cover">🖼 更换封面</button></div>' +
        '<h1 class="doc-title" contenteditable="true" spellcheck="false">' + esc(p.title) + '</h1></div></div>'
      : '<button class="doc-icon" data-act="emoji">' + esc(p.icon) + '</button>' +
        '<div class="ghost-actions"><button class="ghost-btn" data-act="emoji">☺ 添加图标</button><button class="ghost-btn" data-act="cover">🖼 更换封面</button></div>' +
        '<h1 class="doc-title" contenteditable="true" spellcheck="false">' + esc(p.title) + '</h1>';
    var toc = state.dir === 'b' ? '<div class="toc" id="toc"></div>' : '';
    var emptyDoc = p.blocks.length === 0 || (p.blocks.length === 1 && p.blocks[0].t === 'p' && !D.helpers.blockText(p.blocks[0]).trim());
    return '<div class="doc-scroll" id="docscroll">' +
      '<div class="' + coverCls + '"></div>' + toc +
      '<div class="doc-col" data-icon-overlap="' + iconOverlap + '">' +
        '<div class="doc-head" data-act-zone="head">' + head + '</div>' +
        '<div class="doc-body" id="docbody" data-empty="' + (emptyDoc ? '1' : '0') + '" contenteditable="true" spellcheck="false">' + blocksToHTML(p.blocks) + '</div>' +
      '</div></div>';
  }

  function shellHTML(emptyMode) {
    var scrim = (state.vpMode === 'mobile' || state.dir === 'c') ? '' : '';
    var main = emptyMode
      ? '<div class="empty-hero" data-screen-label="空工作区"><div class="e-emoji">📝</div><div class="e-title">开始写第一篇页面</div>' +
        '<div class="e-sub">页面可以层层嵌套，组织你的笔记、计划和资料。</div>' +
        '<div class="e-actions"><button class="btn primary" data-act="newpage">新建页面</button><button class="btn" data-act="import">导入 Markdown</button></div></div>'
      : topbarHTML() + '<div class="banner-host"></div>' + docHTML();
    var peek = state.dir === 'c' ? '<div class="peek-strip" id="peekstrip"></div>' : '';
    return '<div class="shell" data-screen-label="编辑主页">' + sidebarHTML(emptyMode) + peek +
      '<main class="main">' + main + '</main>' + scrim + '</div>';
  }

  function loginHTML() {
    var init = state.loginvar === 'init';
    return '<div class="login-screen" data-screen-label="登录"><div class="login-card">' +
      '<div class="login-logo">N</div>' +
      '<div class="login-title">' + (init ? '初始化所有者账号' : '登录 NBase') + '</div>' +
      '<div class="field"><label>账号名</label><div class="f-wrap"><input id="lg-user" autocomplete="off" placeholder="账号名"></div><div class="f-err" data-err="user"></div></div>' +
      '<div class="field"><label>密码</label><div class="f-wrap"><input id="lg-pass" type="password" placeholder="密码"><button class="eye" data-act="eye" aria-label="显示密码">' + icon('eye') + '</button></div><div class="f-err" data-err="pass"></div></div>' +
      (init ? '<div class="field"><label>确认密码</label><div class="f-wrap"><input id="lg-pass2" type="password" placeholder="再次输入密码"></div><div class="f-err" data-err="pass2"></div></div>' : '') +
      '<button class="btn primary wide" data-act="login">' + (init ? '创建并进入' : '登录') + '</button>' +
      '<div class="login-foot">自部署实例 · 仅限受邀账号</div>' +
    '</div></div>';
  }

  function tweaksHTML() {
    if (!state.chrome) return '';
    var btn = '<button class="tweaks-btn" data-act="tweaks">Tweaks</button>';
    if (!state.tweaks) return btn;
    var screens = [['editor', '编辑主页'], ['search', '搜索/命令面板'], ['history', '历史'], ['trash', '回收站'], ['login', '登录'], ['empty', '空工作区'], ['conflict', '冲突']];
    var saves = [['editing', '编辑中'], ['saving', '保存中'], ['saved', '已保存'], ['offline', '离线'], ['failed', '保存失败'], ['conflict', '冲突']];
    function seg(name, opts) {
      return '<div><div class="tw-label">' + name + '</div><div class="seg">' + opts.map(function (o) {
        return '<button data-tw="' + o[2] + '" data-val="' + o[0] + '" class="' + (o[3] ? 'on' : '') + '">' + o[1] + '</button>';
      }).join('') + '</div></div>';
    }
    return btn + '<div class="tweaks" role="dialog" aria-label="Tweaks">' +
      seg('方向', [['a', 'A 经典', 'dir', state.dir === 'a'], ['b', 'B 结构', 'dir', state.dir === 'b'], ['c', 'C 专注', 'dir', state.dir === 'c']]) +
      seg('主题', [['light', '浅色', 'theme', state.theme === 'light'], ['dark', '深色', 'theme', state.theme === 'dark']]) +
      '<div><div class="tw-label">屏幕</div><select data-tw="screen">' + screens.map(function (s) {
        return '<option value="' + s[0] + '"' + (state.screen === s[0] ? ' selected' : '') + '>' + s[1] + '</option>';
      }).join('') + '</select></div>' +
      '<div><div class="tw-label">保存状态</div><select data-tw="save">' + saves.map(function (s) {
        return '<option value="' + s[0] + '"' + (state.save === s[0] ? ' selected' : '') + '>' + s[1] + '</option>';
      }).join('') + '</select></div>' +
      seg('视口', [['desktop', '桌面', 'vp', state.vpMode === 'desktop'], ['mobile', '手机', 'vp', state.vpMode === 'mobile']]) +
      (state.dir === 'c' ? seg('C 正文字体', [['serif', '衬线', 'bodyfont', state.bodyfont === 'serif'], ['sans', '无衬线', 'bodyfont', state.bodyfont === 'sans']]) : '') +
      seg('登录变体', [['login', '登录', 'loginvar', state.loginvar === 'login'], ['init', '初始化', 'loginvar', state.loginvar === 'init']]) +
    '</div>';
  }

  /* ================= render ================= */
  function render() {
    root.dataset.dir = state.dir;
    root.dataset.theme = state.theme;
    root.dataset.bodyfont = state.bodyfont;
    vp.className = state.vpMode === 'mobile' ? 'mobile' : '';
    fitVp();
    var html = state.screen === 'login' ? loginHTML() : shellHTML(state.screen === 'empty');
    app.innerHTML = html;
    app.insertAdjacentHTML('beforeend', '<div id="overlay-root"></div>' + tweaksHTML());
    overlayEl = app.querySelector('#overlay-root');
    bindShell();
    renderBanners();
    if (state.dir === 'b') buildTOC();
    if (state.screen === 'search') openPalette();
    else if (state.screen === 'history') openHistory();
    else if (state.screen === 'trash') openTrash();
    else if (state.screen === 'conflict') openConflict();
  }

  function fitVp() {
    if (state.vpMode !== 'mobile') { app.style.transform = ''; return; }
    var s = Math.min(1, (window.innerHeight - 48) / 844);
    app.style.transform = 'scale(' + s + ')';
  }
  window.addEventListener('resize', fitVp);

  function applySidebarVisibility() {
    var sb = app.querySelector('#sidebar');
    if (!sb) return;
    var mobileCtx = state.vpMode === 'mobile' || app.clientWidth <= 720;
    sb.style.display = '';
    if (state.dir === 'c' || mobileCtx) {
      var show = state.dir === 'c' && !mobileCtx ? (sidebarPinned || sidebarPeek) : !sidebarHidden;
      sb.classList.toggle('show', show);
    } else {
      sb.classList.remove('show');
      sb.style.display = sidebarHidden ? 'none' : '';
    }
  }

  function bindShell() {
    app.addEventListener('click', onAppClick);
    app.addEventListener('mouseover', onAppHover);
    app.addEventListener('mouseout', onAppHoverOut);
    document.removeEventListener('keydown', onKey);
    document.addEventListener('keydown', onKey);
    var body = app.querySelector('#docbody');
    if (body) {
      body.addEventListener('input', function () { bumpSave(); dimTopbar(); reindexCurrent(); renumber(body); body.dataset.empty = '0'; });
      body.addEventListener('keydown', onDocKey);
      body.addEventListener('keyup', onDocKeyup);
      body.addEventListener('click', onDocClick);
      body.addEventListener('change', onDocChange);
    }
    var title = app.querySelector('.doc-title');
    if (title) title.addEventListener('input', function () {
      var p = pages[currentId];
      p.title = title.textContent.trim() || '无标题';
      bumpSave(); dimTopbar();
      var crumb = app.querySelector('.crumbs .c-item:last-child');
      var rows = app.querySelectorAll('.trow[data-id="' + currentId + '"] .ttitle');
      rows.forEach(function (r) { r.textContent = p.title; });
      if (crumb) crumb.innerHTML = esc(p.icon) + ' ' + esc(p.title);
    });
    document.removeEventListener('selectionchange', onSelChange);
    document.addEventListener('selectionchange', onSelChange);
    document.removeEventListener('mousemove', onMouseMove);
    document.addEventListener('mousemove', onMouseMove);
    applySidebarVisibility();
    // login bindings
    var lg = app.querySelector('[data-act="login"]');
    if (lg) bindLogin();
  }

  /* ---------- shell click dispatch ---------- */
  function onAppClick(e) {
    var t = e.target.closest('[data-act],[data-open],[data-chev],[data-add],[data-more],[data-tw]');
    // tree row open
    var row = e.target.closest('.trow');
    if (row && !e.target.closest('[data-chev],[data-add],[data-more]')) { openPage(row.dataset.id); return; }
    if (!t) {
      // click outside menus closes them
      if (openOverlay === 'menu' || openOverlay === 'emoji') closeOverlay();
      return;
    }
    var act = t.dataset.act, id;
    if (t.dataset.open) { openPage(t.dataset.open); return; }
    if (t.dataset.chev) { expanded[t.dataset.chev] = !expanded[t.dataset.chev]; rerenderTree(); return; }
    if (t.dataset.add) { id = createPage(t.dataset.add); toast('已创建子页面'); return; }
    if (t.dataset.more) { openTreeMenu(t, t.dataset.more); return; }
    if (t.dataset.tw) { onTweak(t); return; }
    switch (act) {
      case 'ws': toast('演示中仅一个工作区'); break;
      case 'search': openPalette(); break;
      case 'trash': openTrash(); break;
      case 'history': openHistory(); break;
      case 'newpage': createPage(null); break;
      case 'import': toast('演示模式：请在真实应用中拖入 .md 文件'); break;
      case 'sidebar': toggleSidebar(); break;
      case 'pin': sidebarPinned = !sidebarPinned; render(); break;
      case 'pagemenu': openPageMenu(t); break;
      case 'emoji': openEmojiPicker(t); break;
      case 'cover': cycleCover(); break;
      case 'tweaks': state.tweaks = !state.tweaks; persist(); render(); break;
      case 'login': doLogin(); break;
      case 'eye': toggleEye(t); break;
    }
  }
  function onAppHover(e) {
    var strip = e.target.closest && e.target.closest('#peekstrip');
    if (strip && state.dir === 'c' && !sidebarPinned) { sidebarPeek = true; applySidebarVisibility(); }
    var sb = e.target.closest && e.target.closest('#sidebar');
    if (sb && state.dir === 'c') { sidebarPeek = true; }
  }
  function onAppHoverOut(e) {
    if (state.dir !== 'c' || sidebarPinned) return;
    var sb = app.querySelector('#sidebar');
    if (sb && !sb.matches(':hover')) { sidebarPeek = false; applySidebarVisibility(); }
  }
  function onMouseMove(e) {
    var tb = app.querySelector('#topbar');
    if (tb && tb.classList.contains('dim')) {
      var r = tb.getBoundingClientRect();
      if (e.clientY < r.bottom + 30) tb.classList.remove('dim');
    }
  }
  var dimTimer = null;
  function dimTopbar() {
    if (state.dir !== 'c') return;
    var tb = app.querySelector('#topbar');
    if (!tb) return;
    tb.classList.add('dim');
    clearTimeout(dimTimer);
    dimTimer = setTimeout(function () { tb.classList.remove('dim'); }, 4000);
  }
  function toggleSidebar() {
    if (state.dir === 'c') { sidebarPinned = !sidebarPinned; sidebarPeek = sidebarPinned; }
    else sidebarHidden = !sidebarHidden;
    // mobile drawer scrim
    var old = app.querySelector('.drawer-scrim');
    if (old) old.remove();
    applySidebarVisibility();
    var sb = app.querySelector('#sidebar');
    if ((state.vpMode === 'mobile' || app.clientWidth <= 720) && sb && sb.classList.contains('show')) {
      var sc = el('<div class="drawer-scrim"></div>');
      sc.onclick = function () { sidebarHidden = true; sc.remove(); applySidebarVisibility(); };
      app.querySelector('.shell').appendChild(sc);
    }
  }
  function rerenderTree() {
    var tree = app.querySelector('.tree');
    if (tree) tree.outerHTML = '<div class="tree">' + treeRows(rootOrder, 0) + '</div>';
    else render();
  }
  function reindexCurrent() {
    var body = app.querySelector('#docbody');
    if (body) D.searchIndex[currentId] = body.textContent;
  }
  function cycleCover() {
    var order = [null, 'sage', 'ochre', 'slate', 'rose'];
    var p = pages[currentId];
    p.cover = order[(order.indexOf(p.cover) + 1) % order.length];
    render();
    toast(p.cover ? '已更换封面' : '已移除封面');
  }

  /* ---------- tweaks ---------- */
  function onTweak(elm) {
    var k = elm.dataset.tw, v = elm.dataset.val;
    if (k === 'dir') state.dir = v;
    else if (k === 'theme') state.theme = v;
    else if (k === 'vp') state.vpMode = v;
    else if (k === 'bodyfont') state.bodyfont = v;
    else if (k === 'loginvar') { state.loginvar = v; persist(); render(); return; }
    persist(); render();
  }
  function onTweakSelect(k, v) {
    if (k === 'screen') {
      state.screen = v;
      if (v === 'search') { state.screen = 'editor'; render(); openPalette(); return; }
      if (v === 'history') { state.screen = 'editor'; render(); openHistory(); return; }
      if (v === 'trash') { state.screen = 'editor'; render(); openTrash(); return; }
      if (v === 'conflict') { state.screen = 'editor'; render(); openConflict(); return; }
      render(); return;
    }
    if (k === 'save') { setSave(v); state.save = v; persist(); return; }
  }

  /* ================= overlays ================= */
  function showOverlay(html, name, onScrim) {
    closeOverlay();
    lastFocus = document.activeElement;
    overlayEl.innerHTML = html;
    openOverlay = name;
    var scrim = overlayEl.firstElementChild;
    if (scrim && onScrim !== false) {
      scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) closeOverlay(); });
    }
    var f = overlayEl.querySelector('input,button:not([data-nofocus])');
    if (f) f.focus();
    return scrim;
  }
  function closeOverlay() {
    if (overlayEl) overlayEl.innerHTML = '';
    if (openOverlay && lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {}
    openOverlay = null;
    if (['search', 'history', 'trash', 'conflict'].indexOf(state.screen) >= 0) { state.screen = 'editor'; persist(); }
  }

  /* ---------- command palette ---------- */
  var COMMANDS = [
    { icon: '＋', name: '新建页面', hint: '在根目录创建一页', run: function () { createPage(null); } },
    { icon: '⇪', name: '导入 Markdown', hint: '从 .md 文件创建页面', run: function () { toast('演示模式：请在真实应用中拖入 .md 文件'); } },
    { icon: '🗑', name: '打开回收站', hint: '查看已删除的页面', run: function () { openTrash(); } },
    { icon: '🌙', name: '切换深色模式', hint: '浅色 / 深色', run: function () { state.theme = state.theme === 'light' ? 'dark' : 'light'; persist(); render(); } }
  ];
  var palSel = 0, palItems = [];
  function openPalette() {
    var scrim = showOverlay(
      '<div class="scrim top" data-screen-label="搜索"><div class="modal palette" role="dialog" aria-label="搜索">' +
        '<div class="pal-input">' + icon('search') + '<input id="pal-q" placeholder="搜索页面或输入命令…" autocomplete="off"></div>' +
        '<div class="pal-list" id="pal-list"></div>' +
        '<div class="pal-foot"><span>↑↓ 选择</span><span>↵ 打开</span><span>Esc 关闭</span></div>' +
      '</div></div>', 'palette');
    palSel = 0;
    renderPalList('');
    var q = scrim.querySelector('#pal-q');
    q.addEventListener('input', function () { palSel = 0; renderPalList(q.value); });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); movePal(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); movePal(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); runPalSel(q.value); }
      else if (e.key === 'Escape') { closeOverlay(); }
    });
  }
  function renderPalList(query) {
    var list = overlayEl.querySelector('#pal-list');
    palItems = [];
    var q = query.trim().toLowerCase();
    if (!q) {
      var rec = recent.filter(function (id) { return pages[id] && !pages[id]._deleted; }).slice(0, 5).map(function (id) {
        var p = pages[id];
        return { type: 'page', id: id, html: '<span class="p-icon">' + esc(p.icon) + '</span><span class="p-main"><div class="p-title">' + esc(p.title) + '</div><div class="p-path">' + esc(pagePathText(id)) + '</div></span>' };
      });
      var cmds = COMMANDS.map(function (c, i) {
        return { type: 'cmd', cmd: i, html: '<span class="p-icon">' + esc(c.icon) + '</span><span class="p-main"><div class="p-title">' + esc(c.name) + '</div><div class="p-path">' + esc(c.hint) + '</div></span>' };
      });
      palItems = rec.concat(cmds);
      list.innerHTML = '<div class="pal-sec">最近访问</div>' + rec.map(itemHTML).join('') +
        '<div class="pal-sec">命令</div>' + cmds.map(itemHTML).join('');
    } else {
      var titles = [], bodies = [];
      Object.keys(pages).forEach(function (id) {
        var p = pages[id];
        if (!p || p._deleted) return;
        var iconP = '<span class="p-icon">' + esc(p.icon) + '</span>';
        var path = '<div class="p-path">' + esc(pagePathText(id)) + '</div>';
        var tMatch = p.title.toLowerCase().indexOf(q) >= 0;
        var text = (D.searchIndex[id] || '');
        var idx = text.toLowerCase().indexOf(q);
        var snipHtml = '';
        if (idx >= 0) {
          var s = Math.max(0, idx - 20), en = Math.min(text.length, idx + q.length + 20);
          var snip = (s > 0 ? '…' : '') + text.slice(s, en) + (en < text.length ? '…' : '');
          snipHtml = '<div class="p-snippet">' + hl(snip, q) + '</div>';
        }
        if (tMatch) {
          titles.push({ type: 'page', id: id, flash: idx >= 0 ? q : null,
            html: iconP + '<span class="p-main"><div class="p-title">' + hl(p.title, q) + '</div>' + path + snipHtml + '</span>' });
        } else if (idx >= 0) {
          bodies.push({ type: 'page', id: id, flash: q,
            html: iconP + '<span class="p-main"><div class="p-title">' + esc(p.title) + '</div>' + path + snipHtml + '</span>' });
        }
      });
      palItems = titles.concat(bodies);
      var h = '';
      if (titles.length) h += '<div class="pal-sec">标题</div>' + titles.map(itemHTML).join('');
      if (bodies.length) h += '<div class="pal-sec">正文</div>' + bodies.map(itemHTML).join('');
      list.innerHTML = h || '<div class="pal-empty">没有找到“' + esc(query) + '”<div class="hint">只搜索已保存的页面</div></div>';
    }
    markPalSel();
  }
  function itemHTML(it, i) { return '<div class="pal-item" data-i="' + palItems.indexOf(it) + '">' + it.html + '</div>'; }
  function hl(text, q) {
    var idx = text.toLowerCase().indexOf(q);
    if (idx < 0) return esc(text);
    return esc(text.slice(0, idx)) + '<mark>' + esc(text.slice(idx, idx + q.length)) + '</mark>' + esc(text.slice(idx + q.length));
  }
  function movePal(d) {
    if (!palItems.length) return;
    palSel = (palSel + d + palItems.length) % palItems.length;
    markPalSel();
  }
  function markPalSel() {
    overlayEl.querySelectorAll('.pal-item').forEach(function (n) {
      n.classList.toggle('sel', Number(n.dataset.i) === palSel);
    });
    var sel = overlayEl.querySelector('.pal-item.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  function runPalSel() {
    var it = palItems[palSel];
    if (!it) return;
    if (it.type === 'cmd') { var run = COMMANDS[it.cmd].run; closeOverlay(); run(); return; }
    closeOverlay();
    openPage(it.id);
    if (it.flash) flashText(it.flash);
  }
  function flashText(q) {
    var body = app.querySelector('#docbody');
    if (!body) return;
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var idx = node.textContent.toLowerCase().indexOf(q);
      if (idx >= 0) {
        var range = document.createRange();
        range.setStart(node, idx); range.setEnd(node, idx + q.length);
        var mark = document.createElement('mark');
        mark.className = 'flash-hit';
        try { range.surroundContents(mark); mark.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
        return;
      }
    }
  }
  // palette item clicks (delegate on overlay)
  document.addEventListener('click', function (e) {
    var it = e.target.closest('.pal-item');
    if (it && openOverlay === 'palette') { palSel = Number(it.dataset.i); runPalSel(); }
  });

  /* ---------- history ---------- */
  var histSel = 0, histDiff = false;
  function openHistory() {
    var versions = (D.history[currentId] || []);
    var items = '', lastGroup = '';
    versions.forEach(function (v, i) {
      if (v.group !== lastGroup) { items += '<div class="hist-group">' + esc(v.group) + '</div>'; lastGroup = v.group; }
      items += '<button class="hist-item' + (i === histSel ? ' sel' : '') + '" data-hi="' + i + '"><div class="hi-time">' + esc(v.time) + '</div><div class="hi-meta">林 · ' + esc(v.summary) + '</div></button>';
    });
    var scrim = showOverlay(
      '<div class="scrim center" data-screen-label="历史"><div class="modal history" role="dialog" aria-label="页面历史">' +
        '<div class="hist-head"><span class="h-title">页面历史</span><span style="flex:1"></span><button class="tb-btn" data-hclose aria-label="关闭">' + icon('x') + '</button></div>' +
        '<div class="hist-body"><div class="hist-preview" id="hist-preview"></div><div class="hist-list">' + (items || '<div class="trash-empty">暂无历史</div>') + '</div></div>' +
        '<div class="hist-foot"><span class="note">恢复会生成新版本，当前内容仍保留在历史中，页面位置不变。</span><button class="btn primary" data-hrestore>恢复此版本</button></div>' +
      '</div></div>', 'history');
    renderHistPreview();
    scrim.querySelectorAll('.hist-item').forEach(function (n) {
      n.onclick = function () { histSel = Number(n.dataset.hi); scrim.querySelectorAll('.hist-item').forEach(function (x) { x.classList.toggle('sel', x === n); }); renderHistPreview(); };
    });
    scrim.querySelector('[data-hclose]').onclick = closeOverlay;
    scrim.querySelector('[data-hrestore]').onclick = function () {
      var v = versions[histSel];
      if (!v) return;
      pages[currentId].blocks = JSON.parse(JSON.stringify(v.blocks));
      D.history[currentId].unshift({ id: 'h' + Date.now(), group: '今天', time: '刚刚', summary: '恢复了 ' + v.time.replace(/^.*?(\d|今天|昨天)/, '') + ' 的版本', blocks: JSON.parse(JSON.stringify(v.blocks)) });
      closeOverlay(); render();
      toast('已恢复到 ' + v.time + ' 的版本');
    };
    scrim.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeOverlay(); });
  }
  function renderHistPreview() {
    var host = overlayEl.querySelector('#hist-preview');
    var versions = D.history[currentId] || [];
    var v = versions[histSel];
    if (!v) { host.innerHTML = '<div class="trash-empty">该页面暂无历史版本</div>'; return; }
    var prev = versions[histSel + 1];
    var toggle = '<label class="diff-toggle"><span class="switch' + (histDiff ? ' on' : '') + '" id="diffsw"></span>显示变更（对比 ' + (prev ? prev.time : '更早版本') + '）</label>';
    if (!histDiff || !prev) {
      host.innerHTML = toggle + '<div class="doc-body" style="pointer-events:none">' + blocksToHTML(v.blocks, { noGutter: true }) + '</div>';
    } else {
      host.innerHTML = toggle + '<div class="doc-body diff-view" style="pointer-events:none">' + diffHTML(prev.blocks, v.blocks) + '</div>';
    }
    host.querySelector('#diffsw').onclick = function () { histDiff = !histDiff; renderHistPreview(); };
  }
  function linesOf(blocks) {
    return blocks.map(function (b) { return { t: b.t, text: D.helpers.blockText(b) }; }).filter(function (x) { return x.text || x.t === 'divider'; });
  }
  /* character-level LCS → inline diff spans */
  function charDiff(a, b) {
    var n = a.length, m = b.length, dp = [];
    for (var i = 0; i <= n; i++) { dp[i] = []; for (var j = 0; j <= m; j++) dp[i][j] = 0; }
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    var ops = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push('k' + a[i]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push('d' + a[i]); i++; }
      else { ops.push('a' + b[j]); j++; }
    }
    while (i < n) { ops.push('d' + a[i]); i++; }
    while (j < m) { ops.push('a' + b[j]); j++; }
    var html = '', cur = '', buf = '';
    function flush() {
      if (!buf) return;
      html += cur === 'd' ? '<span class="diff-del">' + esc(buf) + '</span>'
        : cur === 'a' ? '<span class="diff-add">' + esc(buf) + '</span>' : esc(buf);
      buf = '';
    }
    ops.forEach(function (o) {
      var k = o[0], ch = o.slice(1);
      if (k !== cur) { flush(); cur = k; }
      buf += ch;
    });
    flush();
    return { html: html, common: dp[0][0] };
  }
  var TEXTISH = { p: 1, h1: 1, h2: 1, h3: 1, bullet: 1, num: 1, todo: 1, callout: 1, quote: 1 };
  function diffHTML(oldBlocks, newBlocks) {
    // block-level LCS; a del immediately followed by an add of the same text-ish
    // type and with meaningful overlap becomes ONE inline char-diff paragraph
    var A = linesOf(oldBlocks), Bs = newBlocks;
    var a = A.map(function (x) { return x.text; }), b = Bs.map(function (x) { return D.helpers.blockText(x); });
    var n = a.length, m = b.length, dp = [];
    for (var i = 0; i <= n; i++) { dp[i] = []; for (var j = 0; j <= m; j++) dp[i][j] = 0; }
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    var ops = [];
    i = 0; j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { ops.push({ k: 'keep', j: j }); i++; j++; }
      else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) { ops.push({ k: 'del', i: i }); i++; }
      else { ops.push({ k: 'add', j: j }); j++; }
    }
    var out = '';
    for (var k = 0; k < ops.length; k++) {
      var o = ops[k], next = ops[k + 1];
      if (o.k === 'keep') { out += blockHTML(Bs[o.j], { noGutter: true, static: true }); continue; }
      var pairDel = o.k === 'del' && next && next.k === 'add' ? { di: o.i, aj: next.j } :
        o.k === 'add' && next && next.k === 'del' ? { di: next.i, aj: o.j } : null;
      if (pairDel && TEXTISH[A[pairDel.di].t] && A[pairDel.di].t === Bs[pairDel.aj].t) {
        var cd = charDiff(a[pairDel.di], b[pairDel.aj]);
        if (cd.common >= Math.max(4, Math.max(a[pairDel.di].length, b[pairDel.aj].length) * 0.15)) {
          var tag = /^h[123]$/.test(Bs[pairDel.aj].t) ? Bs[pairDel.aj].t : 'p';
          out += '<div class="blk"><' + tag + '>' + cd.html + '</' + tag + '></div>';
          k++;
          continue;
        }
      }
      if (o.k === 'del') {
        out += '<div class="blk"><p class="diff-del">' + esc(a[o.i]) + '</p></div>';
      } else { // add
        out += blockHTML(Bs[o.j], { noGutter: true, static: true }).replace('class="blk"', 'class="blk diff-add"');
      }
    }
    return out;
  }

  /* ---------- trash ---------- */
  function openTrash() {
    var scrim = showOverlay(
      '<div class="scrim top" data-screen-label="回收站"><div class="modal trash-pop" role="dialog" aria-label="回收站">' +
        '<div class="trash-titlebar"><span class="tt">回收站</span><span class="tn">页面不会自动清理</span></div>' +
        '<div class="trash-head">' + icon('search') + '<input id="trash-q" placeholder="在回收站中搜索" autocomplete="off"></div>' +
        '<div class="trash-list" id="trash-list"></div>' +
      '</div></div>', 'trash');
    renderTrashList('');
    scrim.querySelector('#trash-q').addEventListener('input', function (e) { renderTrashList(e.target.value); });
    scrim.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeOverlay(); });
  }
  function renderTrashList(q) {
    var list = overlayEl.querySelector('#trash-list');
    var items = trashList.filter(function (t) { return !q || t.title.toLowerCase().indexOf(q.toLowerCase()) >= 0; });
    list.innerHTML = items.length ? items.map(function (t) {
      var i = trashList.indexOf(t);
      var loc = t.origParent && pages[t.origParent] && !pages[t.origParent]._deleted ? '原位置：' + pagePathText(t.origParent) : '原位置：已不存在';
      return '<div class="trash-item"><span class="t-icon">' + esc(t.icon) + '</span><span class="t-main"><div class="t-title">' + esc(t.title) + '</div><div class="t-meta">' + esc(loc) + ' · ' + esc(t.deletedAt) + '删除</div></span>' +
        (t.childCount ? '<span class="t-badge">含 ' + t.childCount + ' 个子页面</span>' : '') +
        '<button class="trash-restore" data-tr="' + i + '">' + icon('restore') + '恢复</button></div>';
    }).join('') : '<div class="trash-empty">回收站是空的</div>';
    list.querySelectorAll('[data-tr]').forEach(function (n) {
      n.onclick = function () { restoreTrash(trashList[Number(n.dataset.tr)]); if (openOverlay === 'trash') openTrash(); };
    });
  }

  /* ---------- page ⋯ menu ---------- */
  function openPageMenu(btn) {
    var r = btn.getBoundingClientRect(), ar = app.getBoundingClientRect();
    showOverlay('<div class="menu" style="top:' + (r.bottom - ar.top + 4) + 'px; right:' + (ar.right - r.right) + 'px" role="menu">' +
      '<button class="menu-item" data-m="export"><span class="m-icon">⇩</span>导出 Markdown</button>' +
      '<button class="menu-item" data-m="src"><span class="m-icon">&lt;/&gt;</span>查看 Markdown 源码</button>' +
      '<button class="menu-item" data-m="move"><span class="m-icon">⤴</span>移动到…</button>' +
      '<div class="menu-sep"></div>' +
      '<button class="menu-item danger" data-m="del"><span class="m-icon">' + icon('trash') + '</span>移到回收站</button>' +
    '</div>', 'menu', false);
    overlayEl.querySelectorAll('[data-m]').forEach(function (n) {
      n.onclick = function () {
        var m = n.dataset.m; closeOverlay();
        if (m === 'export') { download(pages[currentId].title + '.md', domToMarkdown(app.querySelector('#docbody'), pages[currentId].title)); toast('已导出 Markdown'); }
        else if (m === 'src') openSourcePanel();
        else if (m === 'move') toast('演示模式：移动到… 未实现');
        else if (m === 'del') doDelete();
      };
    });
    setTimeout(function () { document.addEventListener('mousedown', menuOutside); }, 0);
  }
  function menuOutside(e) {
    if (openOverlay === 'menu' && !e.target.closest('.menu')) { closeOverlay(); document.removeEventListener('mousedown', menuOutside); }
    else if (openOverlay !== 'menu') document.removeEventListener('mousedown', menuOutside);
  }
  function openTreeMenu(btn, id) {
    var r = btn.getBoundingClientRect(), ar = app.getBoundingClientRect();
    showOverlay('<div class="menu" style="top:' + (r.bottom - ar.top + 4) + 'px; left:' + Math.max(8, r.left - ar.left - 140) + 'px" role="menu">' +
      '<button class="menu-item" data-m="open"><span class="m-icon">↗</span>打开</button>' +
      '<button class="menu-item danger" data-m="del"><span class="m-icon">' + icon('trash') + '</span>移到回收站</button>' +
    '</div>', 'menu', false);
    overlayEl.querySelectorAll('[data-m]').forEach(function (n) {
      n.onclick = function () {
        var m = n.dataset.m; closeOverlay();
        if (m === 'open') openPage(id);
        else if (m === 'del') { var res = deletePage(id); if (id === currentId) currentId = res.next || rootOrder[0]; render(); toast('已移到回收站', { label: '撤销', fn: function () { undoDelete(res.entry); render(); } }); }
      };
    });
    setTimeout(function () { document.addEventListener('mousedown', menuOutside); }, 0);
  }
  function doDelete() {
    var res = deletePage(currentId);
    currentId = res.next || rootOrder[0];
    render();
    toast('已移到回收站', { label: '撤销', fn: function () { undoDelete(res.entry); render(); } });
  }

  /* ---------- markdown source panel ---------- */
  function openSourcePanel() {
    var md = domToMarkdown(app.querySelector('#docbody'), pages[currentId].title);
    var scrim = showOverlay(
      '<div class="scrim top"><div class="modal srcpanel" role="dialog" aria-label="Markdown 源码">' +
        '<div class="src-head"><span class="s-title">Markdown 源码 · 只读</span><button class="tb-btn" data-sclose aria-label="关闭">' + icon('x') + '</button></div>' +
        '<div class="src-body">' + esc(md) + '</div>' +
      '</div></div>', 'src');
    scrim.querySelector('[data-sclose]').onclick = closeOverlay;
    scrim.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeOverlay(); });
  }

  /* ---------- emoji picker ---------- */
  function openEmojiPicker(btn) {
    var r = btn.getBoundingClientRect(), ar = app.getBoundingClientRect();
    showOverlay('<div class="menu emoji-pop" style="top:' + (r.bottom - ar.top + 6) + 'px; left:' + Math.min(r.left - ar.left, ar.width - 300) + 'px">' +
      '<div class="emoji-grid">' + D.emojiChoices.map(function (em) { return '<button data-em="' + em + '">' + em + '</button>'; }).join('') + '</div></div>', 'emoji', false);
    overlayEl.querySelectorAll('[data-em]').forEach(function (n) {
      n.onclick = function () { pages[currentId].icon = n.dataset.em; closeOverlay(); render(); };
    });
    setTimeout(function () { document.addEventListener('mousedown', menuOutside); }, 0);
  }

  /* ---------- conflict ---------- */
  function openConflict() {
    setSave('conflict');
    var scrim = showOverlay(
      '<div class="scrim center" data-screen-label="冲突"><div class="modal dialog" role="dialog" aria-label="保存冲突">' +
        '<div class="d-title">此页面已在其他地方更新</div>' +
        '<div class="d-text">另一个标签页或设备在 10:58 保存了新版本。你的修改尚未覆盖它。</div>' +
        '<div class="d-actions">' +
          '<button class="btn primary" data-c="copy">另存为副本</button>' +
          '<button class="btn" data-c="reload">放弃我的修改并重新加载</button>' +
          '<button class="btn" data-c="dl">下载我的内容</button>' +
        '</div>' +
      '</div></div>', 'conflict');
    scrim.querySelectorAll('[data-c]').forEach(function (n) {
      n.onclick = function () {
        var c = n.dataset.c;
        if (c === 'copy') {
          var src = pages[currentId];
          var id = uid();
          pages[id] = { id: id, icon: src.icon, cover: src.cover, title: src.title + '（副本）', parent: src.parent, children: [], blocks: JSON.parse(JSON.stringify(src.blocks)) };
          if (src.parent) pages[src.parent].children.push(id); else rootOrder.push(id);
          closeOverlay(); setSave('saved'); openPage(id);
          toast('已另存为副本，原页面未改动');
        } else if (c === 'reload') { closeOverlay(); setSave('saved'); toast('已重新加载服务端版本'); }
        else { download(pages[currentId].title + '.md', domToMarkdown(app.querySelector('#docbody'), pages[currentId].title)); }
      };
    });
  }

  /* ---------- login ---------- */
  function bindLogin() {
    var user = app.querySelector('#lg-user'), pass = app.querySelector('#lg-pass');
    function err(k, msg) { var n = app.querySelector('[data-err="' + k + '"]'); if (n) n.textContent = msg || ''; }
    pass.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    user.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    window._doLogin = function () {
      var ok = true;
      err('user'); err('pass'); err('pass2');
      if (!user.value.trim()) { err('user', '请输入账号名'); ok = false; }
      if (!pass.value) { err('pass', '请输入密码'); ok = false; }
      var p2 = app.querySelector('#lg-pass2');
      if (p2 && p2.value !== pass.value) { err('pass2', '两次输入的密码不一致'); ok = false; }
      if (!ok) return;
      if (pass.value === 'wrong') { err('pass', '账号名或密码不正确'); return; }
      var btn = app.querySelector('[data-act="login"]');
      btn.innerHTML = '<span class="spinner"></span>';
      btn.disabled = true;
      setTimeout(function () { state.screen = 'editor'; setSave('saved'); render(); }, 600);
    };
  }
  function doLogin() { if (window._doLogin) window._doLogin(); }
  function toggleEye(btn) {
    var input = btn.parentElement.querySelector('input');
    input.type = input.type === 'password' ? 'text' : 'password';
  }

  /* ================= doc interactions ================= */
  function currentBlockEl() {
    var sel = window.getSelection();
    if (!sel.rangeCount) return null;
    var n = sel.anchorNode;
    var elm = n.nodeType === 3 ? n.parentElement : n;
    return elm && elm.closest ? elm.closest('.blk') : null;
  }
  var slash = { open: false, sel: 0, query: '', blk: null };
  var SLASH_ITEMS = [
    { id: 'p', icon: '¶', name: '正文', hint: '普通文本段落' },
    { id: 'h1', icon: 'H1', name: '标题 1', hint: '# 大标题' },
    { id: 'h2', icon: 'H2', name: '标题 2', hint: '## 小节标题' },
    { id: 'h3', icon: 'H3', name: '标题 3', hint: '### 子标题' },
    { id: 'bullet', icon: '•', name: '无序列表', hint: '- 项目符号' },
    { id: 'num', icon: '1.', name: '有序列表', hint: '1. 编号列表' },
    { id: 'todo', icon: '☐', name: '待办', hint: '[] 可勾选任务' },
    { id: 'quote', icon: '❝', name: '引用', hint: '> 引文' },
    { id: 'callout', icon: '💡', name: '提示框', hint: '带图标的强调块' },
    { id: 'code', icon: '</>', name: '代码块', hint: '``` 等宽字体' },
    { id: 'eq', icon: '∑', name: '公式', hint: '独立公式块' },
    { id: 'divider', icon: '—', name: '分割线', hint: '---' },
    { id: 'table', icon: '▦', name: '表格', hint: '简单表格' },
    { id: 'attachment', icon: '📎', name: '上传附件', hint: '插入附件占位' }
  ];
  function slashFiltered() {
    var q = slash.query.toLowerCase();
    return SLASH_ITEMS.filter(function (it) { return !q || it.name.toLowerCase().indexOf(q) >= 0 || it.hint.toLowerCase().indexOf(q) >= 0; });
  }
  function openSlash(blk, mode) {
    slash.open = true; slash.sel = 0; slash.query = ''; slash.blk = blk; slash.mode = mode || 'convert';
    renderSlash();
  }
  function renderSlash() {
    var host = app.querySelector('#slash-host');
    if (!host) { host = el('<div id="slash-host"></div>'); app.appendChild(host); }
    if (!slash.open) { host.innerHTML = ''; return; }
    var items = slashFiltered();
    var ar = app.getBoundingClientRect();
    var rect = slash.blk ? slash.blk.getBoundingClientRect() : { left: ar.left + 100, bottom: ar.top + 200 };
    host.innerHTML = '<div class="menu slash" style="top:' + Math.min(rect.bottom - ar.top + 4, ar.height - 330) + 'px; left:' + Math.max(12, rect.left - ar.left - 52) + 'px">' +
      (items.length ? items.map(function (it, i) {
        return '<div class="slash-item' + (i === slash.sel ? ' sel' : '') + '" data-si="' + it.id + '"><span class="s-ic">' + esc(it.icon) + '</span><span><div class="s-name">' + esc(it.name) + '</div><div class="s-hint">' + esc(it.hint) + '</div></span></div>';
      }).join('') : '<div class="slash-empty">没有匹配的块类型</div>') + '</div>';
    host.querySelectorAll('.slash-item').forEach(function (n) {
      n.onmousedown = function (e) { e.preventDefault(); applySlash(n.dataset.si); };
    });
  }
  function closeSlash() { slash.open = false; renderSlash(); }
  function applySlash(id) {
    var blk = slash.blk;
    var mode = slash.mode;
    closeSlash();
    if (!blk) return;
    var editableTypes = { p: '<p><br></p>', h1: '<h1><br></h1>', h2: '<h2><br></h2>', h3: '<h3><br></h3>' };
    var html;
    if (editableTypes[id]) html = '<div class="blk" data-blk="' + id + '">' + GUTTER + editableTypes[id] + '</div>';
    else if (id === 'bullet') html = '<div class="blk" data-blk="bullet">' + GUTTER + '<div class="li"><span class="li-marker">•</span><span class="li-content"><br></span></div></div>';
    else if (id === 'num') html = '<div class="blk" data-blk="num">' + GUTTER + '<div class="li"><span class="li-marker">1.</span><span class="li-content"><br></span></div></div>';
    else if (id === 'todo') html = '<div class="blk" data-blk="todo">' + GUTTER + '<div class="todo"><input type="checkbox" aria-label="待办"><span class="li-content"><br></span></div></div>';
    else if (id === 'quote') html = '<div class="blk" data-blk="quote">' + GUTTER + '<div class="quote"><span class="li-content"><br></span></div></div>';
    else if (id === 'callout') html = '<div class="blk" data-blk="callout">' + GUTTER + '<div class="callout"><span class="c-icon">💡</span><span class="li-content"><br></span></div></div>';
    else if (id === 'code') html = '<div class="blk" data-blk="code" contenteditable="false">' + GUTTER + '<div class="codeblock"><div class="code-head"><span class="lang">text</span><button class="code-copy">复制</button></div><pre> </pre></div></div><div class="blk" data-blk="p">' + GUTTER + '<p><br></p></div>';
    else if (id === 'eq') html = '<div class="blk" data-blk="eq" contenteditable="false">' + GUTTER + '<div class="equation">E = mc²</div></div><div class="blk" data-blk="p">' + GUTTER + '<p><br></p></div>';
    else if (id === 'divider') html = '<div class="blk" data-blk="divider" contenteditable="false">' + GUTTER + '<hr class="hr"></div><div class="blk" data-blk="p">' + GUTTER + '<p><br></p></div>';
    else if (id === 'table') html = '<div class="blk" data-blk="table" contenteditable="false">' + GUTTER + '<table><tbody><tr><th>列 1</th><th>列 2</th></tr><tr><td></td><td></td></tr><tr><td></td><td></td></tr></tbody></table></div><div class="blk" data-blk="p">' + GUTTER + '<p><br></p></div>';
    else if (id === 'attachment') html = '<div class="blk" data-blk="attachment" contenteditable="false">' + GUTTER + '<div class="attach"><span class="a-thumb">' + icon('img') + '</span><span class="a-meta"><span class="a-name">未命名附件</span><br><span class="a-size">等待上传…</span></span><button class="a-dl" aria-label="下载附件">' + icon('dl') + '</button></div></div><div class="blk" data-blk="p">' + GUTTER + '<p><br></p></div>';
    if (!html) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    var nodes = [].slice.call(wrap.children);
    var parent = blk.parentNode;
    if (mode === 'insert') {
      var ref = blk.nextSibling;
      nodes.forEach(function (n) { parent.insertBefore(n, ref); });
    } else {
      nodes.forEach(function (n) { parent.insertBefore(n, blk); });
      blk.remove();
    }
    var body = app.querySelector('#docbody');
    renumber(body);
    bumpSave();
    // place caret in the first empty editable leaf of the inserted nodes
    var placed = false;
    nodes.forEach(function (n) {
      if (placed || !n.querySelector) return;
      var leaf = n.querySelector('p,h1,h2,h3,.li-content');
      if (leaf && !leaf.textContent.trim()) { placeCaret(leaf); placed = true; }
    });
    if (!placed) body.focus();
    reindexCurrent();
  }
  function placeCaret(leaf) {
    var range = document.createRange();
    range.selectNodeContents(leaf);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
  }
  function renumber(body) {
    var n = 0;
    body.querySelectorAll(':scope > .blk').forEach(function (blk) {
      if (blk.dataset.blk === 'num') { n++; var m = blk.querySelector('.li-marker'); if (m) m.textContent = n + '.'; }
      else n = 0;
    });
  }
  function onDocKey(e) {
    if (slash.open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slash.sel = Math.min(slash.sel + 1, slashFiltered().length - 1); renderSlash(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slash.sel = Math.max(slash.sel - 1, 0); renderSlash(); return; }
      if (e.key === 'Enter') { e.preventDefault(); var it = slashFiltered()[slash.sel]; if (it) applySlash(it.id); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    }
    if (e.key === '/') {
      var blk = currentBlockEl();
      if (blk) {
        var leaf = blk.querySelector('p,h1,h2,h3,.li-content');
        if (leaf && !leaf.textContent.replace(/​/g, '').trim()) {
          // let the '/' land first, then open menu
          setTimeout(function () { openSlash(blk); }, 0);
          return;
        }
      }
    }
    if (e.key === 'Backspace' && slash.open) { /* handled in keyup */ }
    if (e.key === 'Enter' && !e.shiftKey && currentBlockEl() && currentBlockEl().dataset.blk === 'code') { /* keep default inside code? code is ce=false anyway */ }
  }
  function onDocKeyup(e) {
    if (!slash.open) return;
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].indexOf(e.key) >= 0) return;
    // update query = text after '/' in current block
    var blk = slash.blk;
    if (!blk || !blk.isConnected) { closeSlash(); return; }
    var leaf = blk.querySelector('p,h1,h2,h3,.li-content');
    var text = leaf ? leaf.textContent : '';
    var i = text.indexOf('/');
    if (i < 0) { closeSlash(); return; }
    slash.query = text.slice(i + 1).trim();
    slash.sel = 0;
    renderSlash();
  }
  function onDocClick(e) {
    var plus = e.target.closest('.gbtn.plus');
    if (plus) { var blk = plus.closest('.blk'); openSlash(blk, 'insert'); return; }
    var copy = e.target.closest('.code-copy');
    if (copy) {
      var pre = copy.closest('.codeblock').querySelector('pre');
      try { navigator.clipboard.writeText(pre.textContent); } catch (err) {}
      copy.textContent = '已复制';
      setTimeout(function () { copy.textContent = '复制'; }, 1400);
      return;
    }
    var pl = e.target.closest('.pagelink');
    if (pl) { var pid = pl.closest('[data-page]').dataset.page; openPage(pid); return; }
    var dl = e.target.closest('.a-dl');
    if (dl) { toast('演示模式：附件下载未实现'); return; }
    if (slash.open && !e.target.closest('.slash')) closeSlash();
    hideFmtSoon();
  }
  function onDocChange(e) {
    var cb = e.target.closest('.todo input[type="checkbox"]');
    if (cb) {
      cb.closest('.todo').classList.toggle('done', cb.checked);
      bumpSave(); reindexCurrent();
    }
  }

  /* ---------- floating format toolbar ---------- */
  var fmtEl = null;
  function onSelChange() {
    if (!slash.open) setTimeout(maybeShowFmt, 10);
  }
  function maybeShowFmt() {
    var sel = window.getSelection();
    var body = app.querySelector('#docbody');
    var bad = !body || !sel.rangeCount || sel.isCollapsed ||
      !body.contains(sel.getRangeAt(0).commonAncestorContainer) || !String(sel).trim();
    if (bad) { if (fmtEl) { fmtEl.remove(); fmtEl = null; } return; }
    var range = sel.getRangeAt(0);
    if (fmtEl) fmtEl.remove();
    var r = range.getBoundingClientRect(), ar = app.getBoundingClientRect();
    fmtEl = el('<div class="fmt" style="top:' + Math.max(8, r.top - ar.top - 42) + 'px; left:' + Math.max(8, Math.min(r.left - ar.left, ar.width - 330)) + 'px">' +
      '<button data-f="convert">转换为 ▾</button><span class="fmt-sep"></span>' +
      '<button class="b-b" data-f="bold" aria-label="加粗">B</button>' +
      '<button class="b-i" data-f="italic" aria-label="斜体">I</button>' +
      '<button class="b-s" data-f="strike" aria-label="删除线">S</button>' +
      '<button class="b-code" data-f="code" aria-label="行内代码">&lt;&gt;</button>' +
      '<button data-f="link" aria-label="链接">链接</button>' +
      '<button data-f="eq" aria-label="公式">∑</button>' +
    '</div>');
    app.appendChild(fmtEl);
    fmtEl.addEventListener('mousedown', function (e) { e.preventDefault(); });
    fmtEl.querySelectorAll('[data-f]').forEach(function (n) {
      n.addEventListener('click', function () { applyFmt(n.dataset.f); });
    });
  }
  function hideFmtSoon() { setTimeout(function () { if (fmtEl) { fmtEl.remove(); fmtEl = null; } }, 120); }
  function applyFmt(kind) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return;
    if (kind === 'bold') document.execCommand('bold');
    else if (kind === 'italic') document.execCommand('italic');
    else if (kind === 'strike') document.execCommand('strikeThrough');
    else if (kind === 'code') document.execCommand('insertHTML', false, '<code class="inl">' + esc(String(sel)) + '</code>');
    else if (kind === 'link') document.execCommand('createLink', false, '#');
    else if (kind === 'eq') {
      var range = sel.getRangeAt(0);
      var span = document.createElement('span');
      span.className = 'eq-inline';
      try { range.surroundContents(span); } catch (e) {}
    }
    else if (kind === 'convert') { openConvertMenu(); return; }
    bumpSave(); reindexCurrent();
  }
  function openConvertMenu() {
    var blk = currentBlockEl();
    if (!blk || !fmtEl) return;
    var r = fmtEl.getBoundingClientRect(), ar = app.getBoundingClientRect();
    var menu = el('<div class="menu" style="top:' + (r.bottom - ar.top + 4) + 'px; left:' + (r.left - ar.left) + 'px">' +
      [['p', '正文'], ['h1', '标题 1'], ['h2', '标题 2'], ['h3', '标题 3'], ['bullet', '无序列表'], ['todo', '待办'], ['quote', '引用']].map(function (o) {
        return '<button class="menu-item" data-cv="' + o[0] + '">' + o[1] + '</button>';
      }).join('') + '</div>');
    app.appendChild(menu);
    var closeM = function (e) { if (!e.target.closest('.menu')) { menu.remove(); document.removeEventListener('mousedown', closeM); } };
    setTimeout(function () { document.addEventListener('mousedown', closeM); }, 0);
    menu.querySelectorAll('[data-cv]').forEach(function (n) {
      n.onmousedown = function (e) {
        e.preventDefault();
        var t = n.dataset.cv;
        var leaf = blk.querySelector('p,h1,h2,h3,.li-content');
        var content = leaf ? leaf.innerHTML : '<br>';
        var html;
        if (t === 'bullet') html = '<div class="li"><span class="li-marker">•</span><span class="li-content">' + content + '</span></div>';
        else if (t === 'todo') html = '<div class="todo"><input type="checkbox" aria-label="待办"><span class="li-content">' + content + '</span></div>';
        else if (t === 'quote') html = '<div class="quote"><span class="li-content">' + content + '</span></div>';
        else html = '<' + (t === 'p' ? 'p' : t) + '>' + content + '</' + (t === 'p' ? 'p' : t) + '>';
        var nb = el('<div class="blk" data-blk="' + t + '">' + GUTTER + html + '</div>');
        blk.replaceWith(nb);
        menu.remove();
        if (fmtEl) { fmtEl.remove(); fmtEl = null; }
        bumpSave(); reindexCurrent();
      };
    });
  }

  /* ---------- TOC (dir B) ---------- */
  function buildTOC() {
    var toc = app.querySelector('#toc');
    var body = app.querySelector('#docbody');
    if (!toc || !body) return;
    var heads = body.querySelectorAll('h1,h2,h3');
    if (!heads.length) { toc.style.display = 'none'; return; }
    var dashes = '', items = '';
    heads.forEach(function (h, i) {
      h.id = 'h-' + i;
      dashes += '<span class="toc-dash" data-th="' + i + '"></span>';
      var lvl = h.tagName === 'H1' ? 1 : h.tagName === 'H2' ? 2 : 3;
      items += '<button class="toc-item l' + lvl + '" data-th="' + i + '">' + esc(h.textContent) + '</button>';
    });
    toc.innerHTML = '<div class="toc-dashes">' + dashes + '</div><div class="toc-card">' + items + '</div>';
    toc.querySelectorAll('[data-th]').forEach(function (n) {
      n.addEventListener('click', function () {
        var h = body.querySelector('#h-' + n.dataset.th);
        if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    var scroll = app.querySelector('#docscroll');
    if (scroll) {
      scroll.addEventListener('scroll', function () {
        var active = 0;
        heads.forEach(function (h, i) { if (h.getBoundingClientRect().top < 200) active = i; });
        toc.querySelectorAll('.toc-dash,.toc-item').forEach(function (n) {
          n.classList.toggle('on', Number(n.dataset.th) === active);
        });
      });
    }
  }

  /* ---------- global keys ---------- */
  function onKey(e) {
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (state.screen !== 'login') { openOverlay === 'palette' ? closeOverlay() : openPalette(); }
      return;
    }
    if (mod && e.key === '\\') { e.preventDefault(); toggleSidebar(); return; }
    if (e.key === 'Escape') {
      if (slash.open) { closeSlash(); return; }
      if (openOverlay) closeOverlay();
    }
  }

  /* tweaks select delegation */
  document.addEventListener('change', function (e) {
    var s = e.target.closest && e.target.closest('.tweaks select');
    if (s) onTweakSelect(s.dataset.tw, s.value);
  });
  // tweaks seg buttons are handled in onAppClick via [data-tw]

  render();
})();
