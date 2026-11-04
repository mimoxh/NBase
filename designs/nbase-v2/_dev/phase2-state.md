# PHASE 2 rework + PHASE 3 — resume state

Lead handoff: A=rework (11 items), B=demo workspace onto shell, C=docs, then ONE verify pass.

## Byte scan: CLEAN (all touched files, no C0/0x7F).

## DONE so far (this pass)
- Byte scan CLEAN.
- PageHeader.tsx rewritten: cover is sibling (edge-to-edge, `width:100%`), `.nb-doc-head` centered, ghost-actions row above `.nb-doc-title-row` (flex baseline, icon 40px inline).
- shell.css: `color-scheme` light/dark; `--on-accent` (#fff light, #17181a dark); `.nb-btn-primary` uses it; `.nb-doc-head` 720px; `.nb-doc-title-row/.nb-doc-icon` baseline row; `.nb-ghost-actions` fixed 28px; `.nb-hist` flex; `.nb-hist-preview` column with `.nb-hist-preview-scroll`; `.nb-hist-cur` pill; `.nb-hist-toggle` switch style; `.nb-trash-restore` row button (hover/focus + always on touch/narrow); `.nb-trash-body-head`; `.nb-pal-item mark` = accent-soft bg + text color (dark override removed).

## REMAINING A (rework)
- shell.css DONE: `.modal-large` is now `display:flex;flex-direction:column;overflow:hidden` (L245-248,254); `.nb-hist`/`.nb-trash-grid` flex:1 min-height:0; `.dialog-actions` gets top border+anchor.
- PageRecoveryDialogs.tsx DONE: history toggle moved to top of `.nb-hist-preview` + `.nb-hist-preview-scroll` wraps content; trash rows have `.nb-trash-restore` span-role-button (stopPropagation, fetch trashed → onRestore); `.nb-trash-body-head` (h3 + 恢复 primary); Preview h3 gets `.nb-preview-title` class.
- editor.css: toolbar compact 13px/28px, 16px margin. `.nb-doc-body` padding-top 4px.
- PW.tsx DONE: updatePageMeta busy guard; favoriteBusyRef Set; toggleFavorite finally-delete.
- Shots: mobile-editor + mobile-drawer (390px) — pending in driver update.

## B. Phase 3 (DONE pending verify)
- model.ts: Page.icon/cover + icon/cover actions; fixtures seeded (welcome 🌱/sage, notes 📒, work 💼/slate); model.test.ts new icon/cover test.
- SavePill `demo` prop → 「演示 · 未保存」 never 已保存； Topbar `hideHistory`.
- Workspace.tsx fully rewritten onto shell (Sidebar/Topbar/PageHeader/Toc/Toast/NoticeBar/DemoSearch palette w/ 标题·正文 groups + mark + commands/DemoTrash with row restore+root fallback). loginName '演示会话'. focusMode + settings/health dialog dropped (theme via account menu) — DEVIATION to report.
- persistent.css trimmed dead rules; workspace.css DELETED; styles.css now comment-only; shell.css gained `.confirmation-check`, `.nb-demo-preview`.
- NOTE: watch byte scan again on Workspace.tsx — a raw 0x1F got into filename regex, fixed via byte patch to `-\u001f]`.
- Read apps/web/src/workspace/{Workspace.tsx,model.ts,workspace.css} + model.test.ts.
- Demo → same shell: Sidebar/PageTree/Topbar/PageHeader/Toc/Toast/Menu + palette search + theme.
- Persistent NoticeBar 「演示模式 · 内容仅保留在当前会话，刷新后重置」+ 下载此页.
- SavePill 'demo' variant → 「演示 · 未保存」 (never 已保存).
- Model: Page gains icon/cover + reducer actions icon/cover; fixtures get icons/covers; `starred` → 收藏 section.
- Demo trash = same trash UI local (per-row restore, root fallback per model.ts); NO history button.
- Demo search local palette （标题/正文 groups + mark).
- Keep: import warnings+confirm, source view, read mode, move, delete/restore, Ctrl+K.
- Grep-then-delete dead CSS in workspace.css + persistent.css. Update model.test.ts.

## C. Docs DONE: principles.md updated (ref = designs/nbase-v2 dir B, tokens in shell.css).

## NEW handoff (6 measured fixes) — CSS/TSX DONE, driver+verify pending
Applied: `.nb-app button.nb-doc-icon{font-size:40px}`; `.nb-hist-item span.nb-hist-cur{display:inline-block;width:auto}` + width:auto on base; `.nb-savepill{white-space:nowrap}`; base `.nb-menu-trigger{border:0;padding:4px 6px}` (was unstyled → UA border box); editor.css `@media(max-width:720px){.nbase-editor-toolbar{flex-wrap:nowrap;overflow-x:auto}}`; Sidebar `accountLabel` prop + demo passes 「演示模式 · 未登录」.
PENDING: (a) driver asserts ADDED: icon height≥36px, ⋯ border=0, cur pill width<60px, mobile pill height≤32, mobile toolbar nowrap+≤44px. DARK-SHOT fix IN PROGRESS: driver dark section is at impl-drive.mjs ~L210-219 (clickSel('.nb-ws .nb-menu-trigger') → clickText('深色') → report dark → shot editor-dark → clickText('浅色')). Need to guard the dark shot with `!document.querySelector('dialog[open]')` and reload+re-login if a dialog is open. THEN: rebuild dist (`npm run build`), driver rerun (mock serves dist live), npm run check, report measured values.
Diagnosed causes:
1. `.nb-doc-icon` loses to `.nb-app button { font:inherit }` (spec 0,1,1 > 0,1,0) → icon 14px not 40px. Fix: `.nb-app .nb-doc-icon { font-size:40px }`.
2. `.nb-hist-item span { display:block }` (L292) beats `.nb-hist-cur` (L293) → pill full-width. Fix: `.nb-hist-item .nb-hist-cur { display:inline-block; width:auto }`.
3. editor-dark shot has dialog open → close dialog/reload before dark shot in driver.
4. `⋯` border: `.nb-menu-trigger` base rule (Menu.tsx renders class nb-menu-trigger; base `.nb-menu-trigger` style NOT in shell.css greps — check for a generic `.nb-menu`/`.icon-button` fallback; the topbar ⋯ shows bordered box → likely `.icon-button` border or trigger inherits `.nb-btn`; find + set border:0 normal, ring only :focus-visible).
5. Mobile: `.nb-savepill { white-space:nowrap }`; `.nbase-editor-toolbar` at ≤720px → `flex-wrap:nowrap; overflow-x:auto`; breadcrumb may collapse to title only.
6. Sidebar account label: hardcoded `已登录 · ${loginName}` → make label prop (Sidebar gains `accountLabel`), demo passes 「演示模式 · 未登录」.
Driver asserts: icon height ≥36px; cur pill width <60px; ⋯ computed border '0px' default; pill height; toolbar single row. Then npm run check + reshoot editor-light, editor-dark, history-diff, mobile-editor, demo-editor.

## Verify status
- typecheck ✅ (all 4 errors fixed: resolvesDraftPageId, PalItem optional, demo prop, regex `\u0000-\u001f` byte-patched)
- npm run check ✅ full green; web tests 105/105
- Mock 4380 (persistent) + 4381 (`NBASE_MOCK_DEMO=1` → health `not-configured` → demo) both running.
- Driver run: probe proved demo renders + drawer opens at 390. Last full run raced tree-load (home checks while pages loading → cascade FAIL + crash at impl-drive:164 unchecked `.click()`). FIX IN PROGRESS: wait for `.nb-tree-page`/`.nb-home-row` after login; null-safe hist checkbox click; also `waitFor('.nb-sidebar-open')` had passed standalone.
- IDB stall (known env issue): conflict + toast-after-restore fail in long runs; impl-conflict.mjs proves conflict standalone.

## Env notes
- Mock: designs/nbase-v2/_dev/mock-server.mjs port 4380 (owner/dev), has __reset + ?empty=1.
- Drivers: impl-drive.mjs (full), impl-debug.mjs, impl-conflict.mjs in designs/nbase-v2/_dev/.
- Designs server designs/serve.mjs on 4311 maybe still up.
- PersistentWorkspace.tsx ~1130 lines; key refs: updatePageMeta ~L740, toggleFavorite ~L790, pageActionBusyRef ~L169.
