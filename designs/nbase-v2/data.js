/* NBase v2 design prototype — in-memory demo data.
   Attached to window.NBASE_DATA. Plain script, no modules.
   Pages are a flat map; `children` arrays hold ordered child ids.
   Blocks: { t: 'h1'|'h2'|'h3'|'p'|'bullet'|'num'|'todo'|'callout'|'quote'|'code'|
              'eq'|'table'|'attachment'|'divider'|'page' }
   Rich text runs: "plain" strings and {b,i,s,code,link,eq} marked segments. */
(function () {
  'use strict';

  var B = function (t, extra) { return Object.assign({ t: t }, extra || {}); };
  var tx = function (t) { return t; };
  var b = function (t) { return { t: t, b: 1 }; };
  var i = function (t) { return { t: t, i: 1 }; };
  var s = function (t) { return { t: t, s: 1 }; };
  var c = function (t) { return { t: t, code: 1 }; };
  var lk = function (t) { return { t: t, link: 1 }; };
  var eq = function (t) { return { t: t, eq: 1 }; };

  var pages = {
    notes: {
      id: 'notes', icon: '📒', cover: null, title: '读书笔记', parent: null,
      children: ['zsyn', 'yl'],
      blocks: [
        B('p', { rich: ['书摘、想法与重读标记。读完一本书后把最有启发的段落搬到这里，', i('慢慢发酵成自己的东西'), '。'] }),
        B('page', { page: 'zsyn' }),
        B('page', { page: 'yl' })
      ]
    },
    zsyn: {
      id: 'zsyn', icon: '📗', cover: 'sage', title: '《置身事内》笔记', parent: 'notes', children: [],
      blocks: [
        B('h2', { rich: ['核心观点'] }),
        B('p', { rich: ['兰小欢把中国政府在经济发展中的角色讲得很直白：地方政府的', b('土地财政'), '、', b('城投平台'), '与招商引资，是理解过去三十年增长模式的三把钥匙。'] }),
        B('bullet', { rich: ['分税制改革后，地方政府财力与事权不匹配，土地出让金成为重要补充。'] }),
        B('bullet', { rich: ['“宽度”与“密度”：城市化既是空间扩张，也是公共服务的密度竞赛。'] }),
        B('quote', { rich: ['对复杂问题，与其争论“该不该”，不如先弄清楚“是怎么运转的”。'] }),
        B('p', { rich: ['重读时重点关注第四章工业化中的政府角色，以及第八章关于债务的推演。'] })
      ]
    },
    yl: {
      id: 'yl', icon: '📘', cover: null, title: '《原则》摘录', parent: 'notes', children: [],
      blocks: [
        B('quote', { rich: ['痛苦 + 反思 = 进步。'] }),
        B('p', { rich: ['达利欧的原则体系可以归纳为三件事：', b('极度求真'), '、', b('极度透明'), '、用算法化决策对抗情绪。'] }),
        B('bullet', { rich: ['五步流程：目标 → 问题 → 诊断 → 方案 → 执行。'] }),
        B('bullet', { rich: ['可信度加权：意见的价值取决于提出者的过往记录，而非职位。'] }),
        B('p', { rich: ['对个人而言，最实用的是把错误当作数据——建一个「错误日志」，定期回顾。'] })
      ]
    },
    dev: {
      id: 'dev', icon: '🛠', cover: 'slate', title: 'NBase 开发', parent: null,
      children: ['v1', 'pg', 'checklist'],
      blocks: [
        B('p', { rich: ['NBase 是自部署的文档应用：', b('Web-first'), '、单人所有者、PostgreSQL + 附件目录。V1 只打磨文档体验。'] }),
        B('bullet', { rich: ['编辑器：Lexical，版本化 JSON 快照，Markdown 仅作交换格式。'] }),
        B('bullet', { rich: ['服务端：Fastify + PostgreSQL，工作区级授权与操作收据。'] }),
        B('page', { page: 'v1' }),
        B('page', { page: 'pg' }),
        B('page', { page: 'checklist' })
      ]
    },
    v1: {
      id: 'v1', icon: '🧭', cover: null, title: 'V1 路线', parent: 'dev', children: [],
      blocks: [
        B('h2', { rich: ['范围'] }),
        B('p', { rich: ['V1 = 一个可以每天用的个人文档库。不做双链、不做表格数据库、不做协作光标。'] }),
        B('todo', { checked: true, rich: ['账号 + 会话（自部署单实例，受邀账号）'] }),
        B('todo', { checked: true, rich: ['页面树 + Lexical 编辑器 + 版本历史'] }),
        B('todo', { checked: true, rich: ['附件上传与引用校验'] }),
        B('todo', { checked: false, rich: ['备份 / 恢复演练（每月一次）'] }),
        B('todo', { checked: false, rich: ['移动端只读打磨'] }),
        B('h2', { rich: ['原则'] }),
        B('bullet', { rich: ['状态真实：连接正常 ≠ 数据库就绪，草稿 ≠ 已保存。'] }),
        B('bullet', { rich: ['所有正式写入走工作区行锁 + 修订检查 + 单事务收据。'] })
      ]
    },
    pg: {
      id: 'pg', icon: '🐘', cover: 'ochre', title: 'PostgreSQL 备份恢复手册', parent: 'dev', children: [],
      blocks: [
        B('p', { rich: ['本页记录 NBase 自部署实例的 PostgreSQL 备份与恢复流程，适用于维护窗口操作。备份包包含 ', b('数据库快照'), '、附件目录与校验清单；恢复前必须', b('离线核验'), '，细节见', lk('运维决定记录'), '。'] }),
        B('callout', { icon: '💡', rich: ['备份与恢复需要在同一维护窗口内完成：先停应用、等待在途请求排空，再取数据库快照与附件副本。'] }),
        B('h2', { rich: ['备份流程'] }),
        B('num', { rich: ['停止应用容器，确认不再接收请求。'] }),
        B('num', { rich: ['等待在途请求排空（就绪探针返回维护模式）。'] }),
        B('num', { rich: ['执行 ', c('pg_dump'), ' 导出数据库快照，表锁覆盖复制窗口。'] }),
        B('num', { rich: ['复制附件目录，为每个文件生成 ', c('SHA-256'), ' 摘要清单。'] }),
        B('num', { rich: ['全部文件复读校验通过后，写入 ', c('COMPLETE'), ' 标记。'] }),
        B('h2', { rich: ['恢复前置检查'] }),
        B('todo', { checked: true, rich: ['目标数据库为', b('空库'), '，且不与原库同名发布端口。'] }),
        B('todo', { checked: true, rich: ['附件目录为空目录。'] }),
        B('todo', { checked: false, rich: ['恢复所用应用镜像与清单中的镜像摘要一致。'] }),
        B('todo', { checked: false, rich: ['迁移 checksum 与清单一致；不一致则换一组新卷重试。'] }),
        B('h2', { rich: ['关键命令'] }),
        B('code', { lang: 'bash', code: '# 导出数据库快照（custom 格式）\npg_dump -U nbase -d nbase --format=custom --file=backup.dump\n\n# 校验附件摘要\nsha256sum attachments/* > manifest.sha256\n\n# 恢复（仅空库；失败不启动、不清空目标）\npg_restore -U nbase -d nbase backup.dump' }),
        B('h3', { rich: ['容量与时间估算'] }),
        B('p', { rich: ['附件目录的校验耗时近似线性 ', eq('T(n) ≈ n · t_hash'), '，其中 ', eq('t_hash'), ' 为单文件平均散列时间；恢复总时长 ', eq('T_restore ≈ T_dump + T_copy + T_verify'), '。'] }),
        B('eq', { tex: 'RPO ≤ 备份间隔 = 24 h，RTO ≈ 45 min' }),
        B('h3', { rich: ['常见问题'] }),
        B('bullet', { rich: ['', c('pg_restore'), ' 报版本不匹配：确认客户端与服务器大版本一致，或使用 custom 格式跨小版本。'] }),
        B('bullet', { rich: ['备份窗口建议放在凌晨低峰；附件目录', b('不可') ,'位于 Web 静态目录内。'] }),
        B('bullet', { rich: ['恢复完成后清除全部会话并递增 ', c('auth_epoch'), '，旧凭据快照立即失效。'] }),
        B('table', { rows: [
          ['项目', '频率', '保留', '负责人'],
          ['数据库快照', '每日 02:00', '14 天', '林'],
          ['附件目录', '每日 02:30', '14 天', '林'],
          ['完整恢复演练', '每月一次', '记录归档', '林']
        ] }),
        B('attachment', { name: 'backup-flow.png', size: '248 KB' }),
        B('quote', { rich: ['备份未验证，等于没有备份。—— 运维谚语'] }),
        B('p', { rich: ['旧版备份脚本 ', s('scripts/backup.sh'), ' 已被 ', i('scripts/backup.mjs'), ' 取代；恢复演练记录见子页面。'] }),
        B('divider'),
        B('page', { page: 'v1' }),
        B('page', { page: 'checklist' })
      ]
    },
    checklist: {
      id: 'checklist', icon: '🧪', cover: null, title: '浏览器验收清单', parent: 'dev', children: [],
      blocks: [
        B('p', { rich: ['每个阶段结束前在真实浏览器里过一遍；内存演示不能替代实测。'] }),
        B('todo', { checked: true, rich: ['新建 / 重命名 / 删除页面，目录树即时更新'] }),
        B('todo', { checked: true, rich: ['切页后异步上传完成不写入新页面'] }),
        B('todo', { checked: false, rich: ['断网编辑 → 恢复网络 → 收据对账无重复修订'] }),
        B('todo', { checked: false, rich: ['冲突另存副本，原文与目录位置不变'] }),
        B('todo', { checked: false, rich: ['回收站恢复子树，原父缺失时落根'] })
      ]
    },
    recipes: {
      id: 'recipes', icon: '🍳', cover: 'rose', title: '菜谱', parent: null,
      children: ['beef'],
      blocks: [
        B('p', { rich: ['反复做过、值得留下来的菜。计量按家中常见勺具记。'] }),
        B('page', { page: 'beef' })
      ]
    },
    beef: {
      id: 'beef', icon: '🍅', cover: null, title: '番茄牛腩', parent: 'recipes', children: [],
      blocks: [
        B('h2', { rich: ['用料'] }),
        B('bullet', { rich: ['牛腩 500 g，切 3 cm 块，冷水下锅焯去浮沫。'] }),
        B('bullet', { rich: ['番茄 4 个（2 个炒酱、2 个后放），洋葱半个，姜 3 片。'] }),
        B('bullet', { rich: ['生抽 2 勺、老抽半勺、冰糖 6 粒、八角 1 颗。'] }),
        B('h2', { rich: ['步骤'] }),
        B('num', { rich: ['少油炒洋葱至透明，下番茄炒出红油。'] }),
        B('num', { rich: ['下牛腩翻炒均匀，加生抽、老抽、冰糖、八角。'] }),
        B('num', { rich: ['加开水没过肉面，小火 90 分钟。'] }),
        B('num', { rich: ['下剩余番茄块再炖 15 分钟，大火收汁。'] }),
        B('callout', { icon: '💡', rich: ['番茄分两次放：第一次出味，第二次留形。'] })
      ]
    },
    plan: {
      id: 'plan', icon: '📅', cover: 'sage', title: '2026 年度计划', parent: null, children: [],
      blocks: [
        B('h2', { rich: ['主线'] }),
        B('p', { rich: ['今年只押注两件事：把 NBase 做到「每天在用」，以及恢复规律的力量训练。'] }),
        B('todo', { checked: true, rich: ['Q1：NBase V1 可用，迁移旧笔记进来'] }),
        B('todo', { checked: false, rich: ['Q2：备份恢复演练跑通三次'] }),
        B('todo', { checked: false, rich: ['全年：阅读 12 本，写 12 篇笔记'] }),
        B('h2', { rich: ['衡量方式'] }),
        B('bullet', { rich: ['每月最后一天复盘：写了多少页、练了几次、睡得怎样。'] })
      ]
    },
    kyoto: {
      id: 'kyoto', icon: '✈️', cover: null, title: '京都旅行', parent: null, children: [],
      blocks: [
        B('h2', { rich: ['行程草案（4 天）'] }),
        B('num', { rich: ['Day 1：抵达 → 鸭川散步 → 先斗町晚饭。'] }),
        B('num', { rich: ['Day 2：清水寺 → 二年坂三年坂 → 祇园。'] }),
        B('num', { rich: ['Day 3：岚山竹林 → 天龙寺 → 渡月桥。'] }),
        B('num', { rich: ['Day 4：伏见稻荷大社 → 返程。'] }),
        B('todo', { checked: true, rich: ['订机票（周二出发更便宜）'] }),
        B('todo', { checked: false, rich: ['订町屋民宿，确认有洗衣机'] }),
        B('todo', { checked: false, rich: ['列红叶季替代景点清单'] }),
        B('callout', { icon: '📷', rich: ['清晨 7 点前的清水坂几乎没有人，适合拍照。'] })
      ]
    }
  };

  var rootOrder = ['notes', 'dev', 'recipes', 'plan', 'kyoto'];

  /* Deleted pages. `origParent` may reference a page that no longer exists
     (t2 → orphan) to exercise the restore-to-root fallback. */
  var trash = [
    { id: 't1', icon: '🗒', title: '旧会议记录（10 月）', origParent: 'notes', deletedAt: '昨天 21:14', childCount: 0 },
    { id: 't2', icon: '📎', title: '装修报价单汇总', origParent: 'gone-parent', deletedAt: '3 天前', childCount: 0 },
    { id: 't3', icon: '🗂', title: '草稿集', origParent: 'dev', deletedAt: '10 月 18 日', childCount: 2 }
  ];

  /* History of the main doc: three snapshots with small differences.
     Each version carries its own blocks; 「显示变更」 diffs plain-text lines
     against the previous version at render time. */
  var history = {
    pg: [
      {
        id: 'h3', group: '今天', time: '今天 10:42', summary: '编辑了 3 处',
        blocks: [
          B('p', { rich: ['本页记录 NBase 自部署实例的 PostgreSQL 备份与恢复流程，适用于维护窗口操作。备份包包含数据库快照、附件目录与校验清单；恢复前必须离线核验。'] }),
          B('callout', { icon: '💡', rich: ['备份与恢复需要在同一维护窗口内完成：先停应用、等待在途请求排空，再取数据库快照与附件副本。'] }),
          B('h2', { rich: ['恢复前置检查'] }),
          B('todo', { checked: true, rich: ['目标数据库为空库，且不与原库同名发布端口。'] }),
          B('todo', { checked: true, rich: ['附件目录为空目录。'] }),
          B('todo', { checked: false, rich: ['迁移 checksum 与清单一致；不一致则换一组新卷重试。'] })
        ]
      },
      {
        id: 'h2', group: '昨天', time: '昨天 22:31', summary: '编辑了 2 处',
        blocks: [
          B('p', { rich: ['本页记录 NBase 自部署实例的 PostgreSQL 备份与恢复流程。备份包包含数据库快照、附件目录与校验清单。'] }),
          B('callout', { icon: '💡', rich: ['备份与恢复需要在同一维护窗口内完成：先停应用，再取快照。'] }),
          B('h2', { rich: ['恢复前置检查'] }),
          B('todo', { checked: true, rich: ['目标数据库为空库。'] }),
          B('todo', { checked: false, rich: ['附件目录为空目录。'] }),
          B('todo', { checked: false, rich: ['迁移 checksum 与清单一致。'] })
        ]
      },
      {
        id: 'h1', group: '更早', time: '10 月 21 日 18:02', summary: '创建了页面',
        blocks: [
          B('p', { rich: ['本页记录 NBase 自部署实例的备份与恢复流程。'] }),
          B('h2', { rich: ['恢复前置检查'] }),
          B('todo', { checked: false, rich: ['目标数据库为空库。'] }),
          B('todo', { checked: false, rich: ['附件目录为空目录。'] })
        ]
      }
    ]
  };

  var recent = ['pg', 'notes', 'kyoto'];

  var emojiChoices = ['📄','📝','📒','📗','📘','📙','📚','🗂','📁','📌','🧭','🛠','🧪','🐘','🍳','🍅','☕','🌿','🌙','⭐','💡','📷','✈️','🗓','📅','🎧','🏃','🧩','🪴','🔖'];

  /* ---- search index: plain text per page, built once ---- */
  function richText(rich) {
    return (rich || []).map(function (r) { return typeof r === 'string' ? r : r.t; }).join('');
  }
  function blockText(bl) {
    if (bl.t === 'code') return bl.code || '';
    if (bl.t === 'eq') return bl.tex || '';
    if (bl.t === 'table') return (bl.rows || []).map(function (r) { return r.join(' '); }).join(' ');
    if (bl.t === 'attachment') return bl.name || '';
    if (bl.t === 'divider') return '';
    return richText(bl.rich);
  }

  var searchIndex = {};
  Object.keys(pages).forEach(function (id) {
    var p = pages[id];
    searchIndex[id] = p.blocks.map(blockText).filter(Boolean).join(' · ');
  });

  window.NBASE_DATA = {
    user: { name: '林', workspace: '林的空间' },
    pages: pages,
    rootOrder: rootOrder,
    trash: trash,
    history: history,
    recent: recent,
    emojiChoices: emojiChoices,
    searchIndex: searchIndex,
    helpers: { richText: richText, blockText: blockText }
  };
})();
