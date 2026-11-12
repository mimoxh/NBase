import { describe, expect, it } from 'vitest';
import { exportPage } from './index';
import { escapeHtml, registerHtmlRenderer, renderHtmlDocument } from './html';
import { emptyResources, type ExportResources } from './resources';
import { audioId, cell, content, imageId, pageId, paragraph, pdfId, pngBytes, row, sampleDocument, table, text } from './fixtures';

const resources = (): ExportResources => {
  const value = emptyResources();
  value.files.set(imageId, { id: imageId, fileName: 'a.png', mediaType: 'image/png', bytes: pngBytes(200, 100), size: { width: 200, height: 100 }, base64: 'AAAA' });
  value.mermaid.set('flowchart LR\nA-->B', { svg: '<svg id="nbase-diagram" viewBox="0 0 10 10"><style>#nbase-diagram{fill:red}</style></svg>' });
  value.highlight = code => `<span class="token keyword">${escapeHtml(code)}</span>`;
  value.pageTitle = id => id === pageId ? '客户库' : undefined;
  return value;
};
const render = (doc = sampleDocument(), mode: 'single' | 'package' = 'single', res = resources()) =>
  renderHtmlDocument({ title: '页面 <标题>', content: doc }, res, mode);

describe('HTML export', () => {
  it('escapes text and drops unsafe links, scripts and event attributes', () => {
    const html = render(content([
      paragraph([text('<script>alert(1)</script>'), text('" onmouseover="x')]),
      paragraph([{ type: 'link', version: 1, url: 'javascript:alert(1)', children: [text('点我')] }]),
      paragraph([{ type: 'link', version: 1, url: ' JaVaScRiPt:alert(1)', children: [text('混淆')] }]),
      paragraph([{ type: 'link', version: 1, url: 'data:text/html,<script>', children: [text('数据')] }]),
      paragraph([{ type: 'link', version: 1, url: 'mailto:a@b.c', children: [text('邮件')] }]),
      paragraph([text('x', 0, 'color: red; background: url(javascript:1)')]),
    ]));
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+="/i);
    expect(html).not.toMatch(/href="\s*(?:javascript|data):/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<title>页面 &lt;标题&gt;</title>');
    expect(html).toContain('<h1 class="nb-title">页面 &lt;标题&gt;</h1>');
    expect(html).toContain('点我');
    expect(html).toContain('href="mailto:a@b.c"');
    expect(html).not.toContain('url(javascript');
    expect(html).toContain("script-src 'none'");
  });

  it('renders every supported node type', () => {
    const html = render();
    expect(html).toContain('<h2 style="text-align:center">第二级标题</h2>');
    expect(html).toContain('<p style="text-align:justify"><strong>粗体</strong><em>斜体</em><s>删除</s><code>代码</code><mark>高亮</mark>');
    expect(html).toContain('<span style="color:var(--nb-c-red,#d44c47);background-color:var(--nb-bg-yellow,#fbf3db)">彩色</span>');
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">安全链接</a>');
    expect(html).toContain(`<span class="nb-page-ref" data-nbase-page="${pageId}">另一页</span>`);
    expect(html).toContain('<math');
    expect(html).toContain('<p style="text-align:right">右对齐</p>');
    expect(html).toMatch(/<ul><li>一<ul><li>一\.一<\/li><\/ul><\/li><li>二<\/li><\/ul>/);
    expect(html).toContain('<ol start="3"><li>第一步</li><li>第二步</li></ol>');
    expect(html).toContain('<input type="checkbox" disabled checked> <span>完成</span>');
    expect(html).toContain('<input type="checkbox" disabled> <span>待办</span>');
    expect(html).toContain('<blockquote>引用文字</blockquote>');
    expect(html).toContain('<p class="nb-callout-label">注意 · 小心</p><p>提示正文</p>');
    expect(html).toContain('<details open><summary>折叠标题</summary><div class="nb-toggle-body"><p>折叠正文</p></div></details>');
    expect(html).toContain('<pre class="nb-code" data-language="javascript"><code class="language-javascript"><span class="token keyword">const a = 1;\n\ta &lt; 2</span></code></pre>');
    expect(html).toContain('<thead><tr><th scope="col"><p>表头</p></th><th scope="col"><p>列二</p></th></tr></thead>');
    expect(html).toContain('<td><p style="text-align:center">乙</p></td>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<span class="nb-figure nb-align-center" role="figure" style="width:50%"><img src="data:image/png;base64,AAAA" alt="示意图" width="200" height="100"><span class="nb-caption">图一</span></span>');
    expect(html).toContain('nb-math nb-math-block');
    expect(html).toContain('<div class="nb-mermaid" role="img" aria-label="Mermaid 图表"><svg id="nbase-diagram-1"');
    expect(html).toContain('#nbase-diagram-1{fill:red}');
    expect(html).toContain('数据库视图：客户库');
    expect(html).toContain('href="https://example.com/x.png"');
    expect(html).toContain('<sup class="nb-fnref"><a href="#fn-1" id="fnref-1">1</a></sup>');
    expect(html).toMatch(/<li id="fn-1"><span class="nb-fnlabel">1<\/span><div><p>脚注内容<\/p> <a class="nb-fnback" href="#fnref-1"/);
    expect(html.indexOf('脚注内容')).toBeGreaterThan(html.indexOf('数据库视图'));
  });

  it('falls back to code for an unrendered diagram and to a placeholder for a missing image', () => {
    const html = render(sampleDocument(), 'single', emptyResources());
    expect(html).toContain('<pre class="nb-code" data-language="mermaid"><code class="language-mermaid">flowchart LR\nA--&gt;B</code></pre>');
    expect(html).toContain('图片：示意图（未包含在导出中）');
    expect(html).toContain('<code class="language-javascript">const a = 1;');
  });

  it('keeps the text of unknown nodes and of renderers that throw', () => {
    registerHtmlRenderer('exploding', () => { throw new Error('boom'); });
    const html = render(content([
      { type: 'future-block', version: 1, children: [paragraph([text('未来正文')])] },
      paragraph([{ type: 'future-inline', version: 1, text: '行内未来' }]),
      { type: 'exploding', version: 1, children: [paragraph([text('仍然可见')])] },
      { type: 'bookmark', version: 1, url: 'https://example.com', title: '书签', description: '描述', siteName: '站点' },
      paragraph([{ type: 'block-reference', version: 1, targetPageId: '44444444-4444-4444-8444-444444444444', blockId: 'b1', label: '被引用的块' }]),
    ]));
    expect(html).toContain('<div class="nb-unknown" data-nbase-type="future-block"><p>未来正文</p></div>');
    expect(html).toContain('<span class="nb-unknown" data-nbase-type="future-inline">行内未来</span>');
    expect(html).toContain('仍然可见');
    expect(html).toContain('<a class="nb-bookmark" href="https://example.com" rel="noopener noreferrer"><strong>书签</strong><span>描述</span><small>站点 · https://example.com</small></a>');
    expect(html).toContain('<span class="nb-block-ref">被引用的块</span>');
  });

  it('renders merged cells and column widths', () => {
    const html = render(content([table([
      row([cell([paragraph([text('合并')])], 1, { colSpan: 2 }), cell([paragraph([text('竖')])], 1, { rowSpan: 2 })]),
      row([cell([paragraph([text('a')])]), cell([paragraph([text('b')])])]),
    ], { colWidths: [120, 80, 200] })]));
    expect(html).toContain('<colgroup><col style="width:120px"><col style="width:80px"><col style="width:200px"></colgroup>');
    expect(html).toContain('<th colspan="2" scope="col"><p>合并</p></th>');
    expect(html).toContain('<th rowspan="2" scope="col"><p>竖</p></th>');
    expect(html).not.toContain('<thead>');
  });

  it('names media and PDF attachments in single-file HTML and plays them in the package', () => {
    const res = resources();
    res.files.set(pdfId, { id: pdfId, fileName: '报告.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([1]) });
    res.files.set(audioId, { id: audioId, fileName: '片.mp4', mediaType: 'video/mp4', bytes: new Uint8Array([1]) });
    const doc = content([paragraph([
      { type: 'attachment', version: 1, attachmentId: pdfId, alt: '', fileName: '报告.pdf', mediaType: 'application/pdf' },
      { type: 'attachment', version: 1, attachmentId: audioId, alt: '', fileName: '片.mp4', mediaType: 'video/mp4' },
    ])]);
    const single = render(doc, 'single', res);
    expect(single).toContain('附件：报告.pdf（单文件 HTML 不含附件）');
    expect(single).toContain('附件：片.mp4（单文件 HTML 不含附件）');
    expect(single).not.toContain('<video');
    expect(render(doc, 'package', res)).toContain(`<video controls preload="none" src="assets/${audioId}.mp4"></video>`);
  });

  it('ships non-image attachments beside index.html and embeds images otherwise', async () => {
    const fetchAttachment = async (id: string) => new Blob([id === imageId ? pngBytes(10, 10) : new Uint8Array([1, 2, 3])]);
    const media = content([paragraph([
      { type: 'attachment', version: 1, attachmentId: imageId, alt: '', fileName: 'a.png', mediaType: 'image/png' },
      { type: 'attachment', version: 1, attachmentId: pdfId, alt: '', fileName: '报告.pdf', mediaType: 'application/pdf' },
      { type: 'attachment', version: 1, attachmentId: audioId, alt: '', fileName: '录音.mp3', mediaType: 'audio/mpeg' },
    ])]);
    const zipped = await exportPage({ title: 'p', content: media }, 'html', { fetchAttachment });
    expect(zipped.extension).toBe('.zip');
    const archive = new TextDecoder().decode(new Uint8Array(await zipped.blob.arrayBuffer()));
    expect(archive).toContain(`<a class="nb-file" href="assets/${pdfId}.pdf">附件：报告.pdf</a>`);
    expect(archive).toContain(`<audio controls preload="none" src="assets/${audioId}.mp3"></audio>`);
    expect(archive).toContain(`<img src="assets/${imageId}.png"`);
    expect(archive).toContain(`assets/${pdfId}.pdf`);

    const single = await exportPage({ title: 'p', content: content([paragraph([
      { type: 'attachment', version: 1, attachmentId: imageId, alt: '', fileName: 'a.png', mediaType: 'image/png' }])]) }, 'html', { fetchAttachment });
    expect(single.extension).toBe('.html');
    expect(await single.blob.text()).toContain('src="data:image/png;base64,');
  });
});
