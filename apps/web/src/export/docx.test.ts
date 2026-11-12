// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildDocx, registerDocxRenderer } from './docx';
import { exportPage } from './index';
import { emptyResources, type ExportResources } from './resources';
import { cell, content, imageId, paragraph, pngBytes, row, sampleDocument, table, text } from './fixtures';

/** Reads a stored (uncompressed) ZIP as the exporter writes it. */
async function unzip(blob: Blob): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extra;
    files.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  // Word is strict about the end record: the central directory must end exactly where it begins.
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  expect(view.getUint32(end + 16, true)).toBe(offset);
  expect(view.getUint32(end + 12, true) + offset).toBe(end);
  return files;
}
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const parse = (xml: string) => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror').length, xml.slice(0, 300)).toBe(0);
  return doc;
};

async function build(doc = sampleDocument(), resources: ExportResources = withImage()) {
  const files = await unzip(buildDocx({ title: '导出 & 测试', content: doc }, resources));
  const xml = (name: string) => { const file = files.get(name); expect(file, name).toBeDefined(); return new TextDecoder().decode(file); };
  return { files, xml };
}
function withImage(): ExportResources {
  const resources = emptyResources();
  resources.files.set(imageId, { id: imageId, fileName: 'a.png', mediaType: 'image/png', bytes: pngBytes(200, 100), size: { width: 200, height: 100 } });
  resources.mermaid.set('flowchart LR\nA-->B', { svg: '<svg/>', png: { bytes: pngBytes(40, 20), width: 40, height: 20 } });
  return resources;
}

describe('Word export', () => {
  it('produces a well-formed package whose relationships, numbering and footnotes resolve', async () => {
    const { files, xml } = await build();
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml',
      'word/footnotes.xml', 'word/settings.xml', 'word/_rels/document.xml.rels']) parse(xml(name));
    const types = parse(xml('[Content_Types].xml'));
    const overrides = [...types.getElementsByTagName('Override')].map(node => node.getAttribute('PartName')!.slice(1));
    for (const part of overrides) expect(files.has(part), part).toBe(true);
    const defaults = new Set([...types.getElementsByTagName('Default')].map(node => node.getAttribute('Extension')));
    for (const name of files.keys()) expect(defaults.has(name.split('.').pop()!) || overrides.includes(name), name).toBe(true);

    for (const target of [...parse(xml('_rels/.rels')).getElementsByTagName('Relationship')].map(node => node.getAttribute('Target')!))
      expect(files.has(target), target).toBe(true);
    const relations = [...parse(xml('word/_rels/document.xml.rels')).getElementsByTagName('Relationship')];
    const relationIds = new Set(relations.map(node => node.getAttribute('Id')));
    expect(relationIds.size).toBe(relations.length);
    for (const node of relations) if (node.getAttribute('TargetMode') !== 'External') expect(files.has(`word/${node.getAttribute('Target')}`), node.getAttribute('Target')!).toBe(true);
    const external = relations.filter(node => node.getAttribute('TargetMode') === 'External').map(node => node.getAttribute('Target'));
    expect(external).toEqual(['https://example.com/a?b=1&c=2']);

    const document = xml('word/document.xml');
    for (const [, id] of document.matchAll(/r:(?:id|embed)="([^"]+)"/g)) expect(relationIds.has(id!), id).toBe(true);
    const numbering = parse(xml('word/numbering.xml'));
    const numIds = new Set([...numbering.getElementsByTagNameNS(W, 'num')].map(node => node.getAttributeNS(W, 'numId')));
    const abstractIds = new Set([...numbering.getElementsByTagNameNS(W, 'abstractNum')].map(node => node.getAttributeNS(W, 'abstractNumId')));
    for (const node of numbering.getElementsByTagNameNS(W, 'abstractNumId')) expect(abstractIds.has(node.getAttributeNS(W, 'val'))).toBe(true);
    const used = [...document.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map(match => match[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const id of used) expect(numIds.has(id!), id).toBe(true);
    // Two separate ordered lists get separate instances: the second restarts at 1, the first starts at 3.
    expect(xml('word/numbering.xml')).toContain('<w:startOverride w:val="3"/>');
    expect(xml('word/numbering.xml')).toMatch(/<w:num w:numId="3">.*?<w:startOverride w:val="1"\/>/);
    const footnoteIds = new Set([...parse(xml('word/footnotes.xml')).getElementsByTagNameNS(W, 'footnote')].map(node => node.getAttributeNS(W, 'id')));
    for (const [, id] of document.matchAll(/<w:footnoteReference w:id="(\d+)"\/>/g)) expect(footnoteIds.has(id!)).toBe(true);
    const docPrIds = [...document.matchAll(/<wp:docPr id="(\d+)"/g)].map(match => match[1]);
    expect(new Set(docPrIds).size).toBe(docPrIds.length);
    expect(files.has('word/media/image1.png') && files.has('word/media/image2.png')).toBe(true);
    expect(xml('docProps/core.xml')).toContain('<dc:title>导出 &amp; 测试</dc:title>');
  });

  it('maps headings, runs, colours, alignment, lists, quotes, callouts, toggles, code and images', async () => {
    const document = (await build()).xml('word/document.xml');
    expect(document).toContain('<w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">导出 &amp; 测试</w:t></w:r>');
    expect(document).toContain('<w:pPr><w:pStyle w:val="Heading2"/><w:jc w:val="center"/></w:pPr>');
    expect(document).toContain('<w:jc w:val="both"/>');
    expect(document).toContain('<w:jc w:val="right"/></w:pPr><w:r><w:t xml:space="preserve">右对齐');
    expect(document).toContain('<w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">粗体');
    expect(document).toContain('<w:rPr><w:i/><w:iCs/></w:rPr><w:t xml:space="preserve">斜体');
    expect(document).toContain('<w:rPr><w:strike/></w:rPr>');
    expect(document).toContain('<w:rPr><w:rStyle w:val="CodeChar"/></w:rPr><w:t xml:space="preserve">代码');
    expect(document).toContain('<w:rPr><w:highlight w:val="yellow"/></w:rPr>');
    expect(document).toContain('<w:rPr><w:color w:val="D44C47"/><w:shd w:val="clear" w:color="auto" w:fill="FBF3DB"/></w:rPr><w:t xml:space="preserve">彩色');
    expect(document).toMatch(/<w:hyperlink r:id="rId\d+" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr><w:t xml:space="preserve">安全链接/);
    expect(document).toContain('<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>');
    expect(document).toContain('☑</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t xml:space="preserve">完成');
    expect(document).toContain('☐</w:t>');
    expect(document).toContain('<w:pStyle w:val="Quote"/></w:pPr><w:r><w:t xml:space="preserve">引用文字');
    expect(document).toMatch(/<w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="D08A2C"\/>.*?<\/w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F6F6F3"\/>.*?注意 · 小心/);
    expect(document).toContain('<w:keepNext/></w:pPr><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">折叠标题');
    expect(document).toContain('<w:ind w:left="420"/></w:pPr><w:r><w:t xml:space="preserve">折叠正文');
    expect(document).toContain('<w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">const a = 1;</w:t><w:br/><w:tab/><w:t xml:space="preserve">a &lt; 2</w:t></w:r>');
    expect(document).toContain('<w:pBdr><w:bottom w:val="single"');
    // 50% of the 9026-twip column; height keeps the 2:1 aspect.
    expect(document).toContain('<wp:extent cx="2865755" cy="1432878"/>');
    expect(document).toContain('<w:jc w:val="center"/></w:pPr><w:r><w:drawing>');
    expect(document).toContain('<w:pStyle w:val="Caption"/></w:pPr><w:r><w:t xml:space="preserve">图一');
    expect(document).toContain('<w:t xml:space="preserve">\\frac{1}{2}</w:t>');
    expect(document).toContain('数据库视图');
    expect(document).toContain('[外部图片：外图]');
    expect(document).toContain('<w:t xml:space="preserve">另一页</w:t>');
    expect(document).toContain('<w:tblHeader/>');
    expect(document).toContain('<w:fill="F1F1EE"/></w:tcPr><w:p><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">表头'.replace('<w:fill', '<w:shd w:val="clear" w:color="auto" w:fill'));
  });

  it('writes real footnotes and repeats a note referenced twice', async () => {
    const { xml } = await build(content([
      paragraph([text('正文'), { type: 'footnote-reference', version: 1, footnoteId: 'a' }, { type: 'footnote-reference', version: 1, footnoteId: 'a' },
        { type: 'footnote-reference', version: 1, footnoteId: 'missing' }]),
      { type: 'footnote-definition', version: 1, footnoteId: 'a', children: [paragraph([text('注释 '), text('粗', 1)])] },
      { type: 'footnote-definition', version: 1, footnoteId: 'orphan', children: [paragraph([text('无人引用')])] },
    ]));
    const notes = xml('word/footnotes.xml');
    expect(notes).toContain('<w:footnote w:type="separator" w:id="-1">');
    expect(notes).toContain('<w:footnote w:id="1"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>');
    expect(notes).toContain('<w:footnote w:id="2">');
    expect(notes).toContain('注释 ');
    const document = xml('word/document.xml');
    expect(document).toContain('<w:footnoteReference w:id="1"/>');
    expect(document).toContain('<w:footnoteReference w:id="2"/>');
    expect(document).toContain('[missing]');
    expect(document).not.toContain('注释 ');
    expect(document).toContain('脚注 orphan');
    expect(document).toContain('无人引用');
  });

  it('merges cells with gridSpan and vMerge and uses column widths', async () => {
    const document = (await build(content([table([
      row([cell([paragraph([text('横')])], 0, { colSpan: 2 }), cell([paragraph([text('竖')])], 0, { rowSpan: 2 })]),
      row([cell([paragraph([text('a')])]), cell([paragraph([text('b')])])]),
    ], { colWidths: [100, 100, 200] })]))).xml('word/document.xml');
    expect(document).toContain('<w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/><w:gridCol w:w="3000"/></w:tblGrid>');
    expect(document).toContain('<w:tcW w:w="3000" w:type="dxa"/><w:gridSpan w:val="2"/>');
    expect(document).toContain('<w:tcW w:w="3000" w:type="dxa"/><w:vMerge w:val="restart"/>');
    expect(document).toContain('<w:tcW w:w="3000" w:type="dxa"/><w:vMerge/></w:tcPr><w:p/></w:tc>');
    expect(document.match(/<w:tc>/g)).toHaveLength(5);
    parse(document);
  });

  it('keeps unknown nodes as text, strips XML-invalid characters and survives throwing renderers', async () => {
    registerDocxRenderer('exploding-docx', { block: () => { throw new Error('boom'); } });
    const document = (await build(content([
      { type: 'future-block', version: 1, children: [paragraph([text('未来正文')])] },
      paragraph([{ type: 'future-inline', version: 1, text: '行内未来' }, text('控制\u0001字符\u0000')]),
      { type: 'exploding-docx', version: 1, children: [paragraph([text('仍然可见')])] },
      { type: 'bookmark', version: 1, url: 'https://example.com', title: '书签', description: '描述', siteName: '站点' },
      paragraph([{ type: 'block-reference', version: 1, targetPageId: '44444444-4444-4444-8444-444444444444', blockId: 'b1', label: '被引用的块' }, { type: 'attachment', version: 1, attachmentId: imageId, fileName: '片.mp4', alt: '', mediaType: 'video/mp4' }]),
      paragraph([{ type: 'link', version: 1, url: 'javascript:alert(1)', children: [text('危险')] }]),
    ]), emptyResources())).xml('word/document.xml');
    parse(document);
    for (const value of ['未来正文', '行内未来', '控制字符', '仍然可见', '书签', '描述', '被引用的块', '[视频：片.mp4]', '危险']) expect(document).toContain(value);
    expect(document).not.toContain('javascript');
  });

  it('handles a 720 KB page with 30 images quickly', async () => {
    const ids = Array.from({ length: 30 }, (_, index) => `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`);
    const blocks = Array.from({ length: 3000 }, (_, index) => index % 100 === 0
      ? paragraph([{ type: 'attachment', version: 1, attachmentId: ids[index / 100]!, alt: '', fileName: 'a.png', mediaType: 'image/png' }])
      : paragraph([text('中文段落内容'.repeat(14) + index, index % 3), text(' 链接', 0, '')]));
    const doc = content(blocks);
    expect(JSON.stringify(doc).length).toBeGreaterThan(700_000);
    const fetchAttachment = async () => new Blob([pngBytes(800, 600)]);
    const started = performance.now();
    const [word, html] = [await exportPage({ title: '大页面', content: doc }, 'docx', { fetchAttachment }),
      await exportPage({ title: '大页面', content: doc }, 'html', { fetchAttachment })];
    expect(performance.now() - started).toBeLessThan(5000);
    expect((await unzip(word.blob)).has('word/media/image30.png')).toBe(true);
    expect(html.extension).toBe('.html');
  });

  it('exports through the shared entry with fetched images sized from their header', async () => {
    const result = await exportPage({ title: 't', content: content([paragraph([{ type: 'attachment', version: 1, attachmentId: imageId, alt: 'x', fileName: 'a.png', mediaType: 'image/png' }])]) },
      'docx', { fetchAttachment: async () => new Blob([pngBytes(100, 50)]) });
    expect(result.extension).toBe('.docx');
    const files = await unzip(result.blob);
    expect(new TextDecoder().decode(files.get('word/document.xml'))).toContain(`<wp:extent cx="${100 * 9525}" cy="${50 * 9525}"/>`);
  });
});
