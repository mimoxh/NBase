/** Embedded stylesheet of exported HTML: no external fonts or files, light/dark by system setting, print-safe. */
export const HTML_EXPORT_CSS = `
:root{color-scheme:light dark;--ink:#2f3437;--muted:#6f7470;--line:#e3e4df;--soft:#f6f6f3;--code:#f4f4f1;--accent:#2f6f9f;--mark:#fbf0b4;
--nb-c-gray:#787774;--nb-c-brown:#9f6b53;--nb-c-orange:#d9730d;--nb-c-yellow:#cb912f;--nb-c-green:#448361;--nb-c-blue:#337ea9;--nb-c-purple:#9065b0;--nb-c-pink:#c14c8a;--nb-c-red:#d44c47;
--nb-bg-gray:#f1f1ef;--nb-bg-brown:#f4eeee;--nb-bg-orange:#fbecdd;--nb-bg-yellow:#fbf3db;--nb-bg-green:#edf3ec;--nb-bg-blue:#e7f3f8;--nb-bg-purple:#f6f3f9;--nb-bg-pink:#faf1f5;--nb-bg-red:#fdebec;}
@media screen and (prefers-color-scheme:dark){:root{--ink:#e6e6e3;--muted:#a3a6a0;--line:#3a3c3a;--soft:#232524;--code:#262826;--accent:#7cb4e0;--mark:#5a4b17;
--nb-c-gray:#9b9b9b;--nb-c-brown:#ba856f;--nb-c-orange:#c77d48;--nb-c-yellow:#ca9849;--nb-c-green:#529e72;--nb-c-blue:#5e9fd0;--nb-c-purple:#9d68d3;--nb-c-pink:#d15796;--nb-c-red:#df5452;
--nb-bg-gray:#2f2f2f;--nb-bg-brown:#4a3228;--nb-bg-orange:#5c3b23;--nb-bg-yellow:#564328;--nb-bg-green:#243d30;--nb-bg-blue:#143a4e;--nb-bg-purple:#3c2d49;--nb-bg-pink:#4e2c3c;--nb-bg-red:#522e2a;}
body{background:#191a19}}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--ink);font:16px/1.75 "Noto Sans SC","PingFang SC","Microsoft YaHei","Source Han Sans SC",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%}
.nb-page{max-width:780px;margin:0 auto;padding:56px 24px 96px;overflow-wrap:anywhere}
.nb-title{font-size:2.2em;line-height:1.25;margin:0 0 .8em}
h1,h2,h3,h4,h5,h6{line-height:1.35;margin:1.6em 0 .5em;font-weight:650}
h1{font-size:1.75em}h2{font-size:1.45em}h3{font-size:1.25em}h4{font-size:1.1em}h5,h6{font-size:1em}h6{color:var(--muted)}
p{margin:.4em 0}a{color:var(--accent);text-underline-offset:2px}
mark{background:var(--mark);color:inherit;border-radius:2px;padding:0 1px}
code{font-family:"JetBrains Mono",Consolas,"SFMono-Regular",Menlo,monospace;font-size:.88em;background:var(--code);border-radius:4px;padding:.1em .35em}
pre.nb-code{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow:auto;line-height:1.55;font-size:14px;white-space:pre}
pre.nb-code code{background:none;padding:0;font-size:inherit;white-space:inherit}
pre.nb-code[data-language]::before{content:attr(data-language);display:block;color:var(--muted);font:12px/1.4 system-ui,sans-serif;margin-bottom:6px}
blockquote{margin:.8em 0;padding:.1em 0 .1em 1em;border-left:3px solid var(--line);color:var(--muted)}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}
ul,ol{padding-left:1.6em;margin:.4em 0}li{margin:.15em 0}li.nb-nested{list-style:none}
ul{list-style-type:disc}ol{list-style-type:decimal}
:is(ul,ol) ul{list-style-type:circle}:is(ul,ol) ol{list-style-type:lower-alpha}
:is(ul,ol) :is(ul,ol) ul{list-style-type:square}:is(ul,ol) :is(ul,ol) ol{list-style-type:lower-roman}
:is(ul,ol) :is(ul,ol) :is(ul,ol) ul{list-style-type:disc}:is(ul,ol) :is(ul,ol) :is(ul,ol) ol{list-style-type:decimal}
:is(ul,ol) :is(ul,ol) :is(ul,ol) :is(ul,ol) ul{list-style-type:circle}:is(ul,ol) :is(ul,ol) :is(ul,ol) :is(ul,ol) ol{list-style-type:lower-alpha}
:is(ul,ol) :is(ul,ol) :is(ul,ol) :is(ul,ol) :is(ul,ol) ul{list-style-type:square}:is(ul,ol) :is(ul,ol) :is(ul,ol) :is(ul,ol) :is(ul,ol) ol{list-style-type:lower-roman}
ul.nb-tasks{list-style:none;padding-left:.3em}li.nb-task input{margin:0 .4em 0 0;vertical-align:-1px}
.nb-tab{white-space:pre}
.nb-callout{margin:1em 0;padding:12px 16px;border:1px solid var(--line);border-left:4px solid #6f8fb0;border-radius:8px;background:var(--soft)}
.nb-callout-warning{border-left-color:#d08a2c}.nb-callout-important{border-left-color:#8b62c0}
.nb-callout-label{margin:0 0 .3em;font-weight:650;font-size:.92em;color:var(--muted)}
details{margin:.6em 0}summary{cursor:pointer;font-weight:550}.nb-toggle-body{padding-left:1.3em}
.nb-table{overflow-x:auto;margin:1.2em 0}table{border-collapse:collapse;min-width:100%;font-size:.94em}
th,td{border:1px solid var(--line);padding:7px 11px;vertical-align:top;text-align:left}th{background:var(--soft);font-weight:600}
td p,th p{margin:0}
.nb-figure{display:block;margin:1em 0;max-width:100%}.nb-figure img{display:block;max-width:100%;height:auto;border-radius:4px}
.nb-figure[style] img{width:100%}
.nb-align-center{margin-left:auto;margin-right:auto;text-align:center}.nb-align-center img{margin:0 auto}
.nb-align-right{margin-left:auto;text-align:right}.nb-align-right img{margin-left:auto}
.nb-caption{display:block;margin-top:6px;color:var(--muted);font-size:.88em;text-align:center}
.nb-placeholder,.nb-file{display:inline-block;padding:6px 12px;border:1px dashed var(--line);border-radius:6px;background:var(--soft);color:var(--muted);font-size:.9em}
.nb-block-placeholder{display:block;margin:1em 0;padding:14px 16px}
.nb-media{display:block;margin:1em 0}.nb-media audio,.nb-media video{display:block;max-width:100%;margin-bottom:4px}
.nb-page-ref{color:var(--accent);border-bottom:1px solid currentColor}
.nb-block-ref{border-bottom:1px dashed var(--muted)}
.nb-bookmark{display:flex;flex-direction:column;gap:2px;margin:1em 0;padding:12px 16px;border:1px solid var(--line);border-radius:8px;color:inherit;text-decoration:none}
.nb-bookmark span{color:var(--muted);font-size:.92em}.nb-bookmark small{color:var(--muted);font-size:.8em}
.nb-math-block{display:block;margin:1em 0;text-align:center;overflow-x:auto}.nb-math-source{white-space:pre-wrap}
.nb-mermaid{margin:1em 0;text-align:center;overflow-x:auto}.nb-mermaid svg{max-width:100%;height:auto;background:#fff;border-radius:6px}
.nb-fnref{line-height:0}.nb-fnref a{text-decoration:none;padding:0 1px}
.nb-footnotes{margin-top:3em;font-size:.9em;color:var(--muted)}.nb-footnotes ol{list-style:none;padding:0}
.nb-footnotes li{display:flex;gap:.6em}.nb-fnlabel{min-width:1.6em;font-weight:600}.nb-footnotes li>div{flex:1}
.nb-fnback{text-decoration:none}.nb-footnotes li>div>p:last-of-type{display:inline}
.token.comment,.token.prolog,.token.doctype,.token.cdata{color:#6a737d}.token.punctuation{color:#5c6370}
.token.property,.token.tag,.token.boolean,.token.number,.token.constant,.token.symbol,.token.deleted{color:#b3452f}
.token.selector,.token.attr-name,.token.string,.token.char,.token.builtin,.token.inserted{color:#2f7d32}
.token.operator,.token.entity,.token.url{color:#8a5a00}.token.atrule,.token.attr-value,.token.keyword{color:#7b3fb2}
.token.function,.token.class-name{color:#1f61a8}.token.regex,.token.important,.token.variable{color:#b35c00}
@media screen and (prefers-color-scheme:dark){.token.comment,.token.prolog,.token.doctype,.token.cdata{color:#8b949e}.token.punctuation{color:#a0a7b4}
.token.property,.token.tag,.token.boolean,.token.number,.token.constant,.token.symbol,.token.deleted{color:#f08d72}
.token.selector,.token.attr-name,.token.string,.token.char,.token.builtin,.token.inserted{color:#8fd18f}
.token.operator,.token.entity,.token.url{color:#e3b55f}.token.atrule,.token.attr-value,.token.keyword{color:#c89cf2}
.token.function,.token.class-name{color:#79b8ff}.token.regex,.token.important,.token.variable{color:#f0a35c}}
@media (max-width:600px){.nb-page{padding:32px 16px 64px}body{font-size:15px}}
@media print{:root{color-scheme:light}body{background:#fff;color:#000;font-size:11pt}.nb-page{max-width:none;padding:0}
pre.nb-code{white-space:pre-wrap;overflow:visible}.nb-table{overflow:visible}a{color:inherit}
a[href^="http"]::after{content:" (" attr(href) ")";font-size:.85em;color:#555}
h1,h2,h3,h4,h5,h6{break-after:avoid}pre,table,figure,.nb-figure,.nb-callout,.nb-mermaid{break-inside:avoid}}
`.trim();
