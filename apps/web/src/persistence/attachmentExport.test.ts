import { describe, expect, it } from 'vitest';
import { packagePage, portableMarkdown } from './attachmentExport';

const id = '11111111-1111-4111-8111-111111111111';
const content = { schemaVersion: 1, editorState: { root: {
  type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children: [{
    type: 'attachment', version: 1, attachmentId: id, alt: '截图', fileName: '截图.png', mediaType: 'image/png',
  }] }],
} } };

describe('portable attachment export', () => {
  it('rewrites stable references and bundles exactly the fetched image', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const markdown = `![截图](nbase-attachment:${id})`;
    expect(portableMarkdown(markdown, [{ id, fileName: '截图.png', mediaType: 'image/png' }]))
      .toBe(`![截图](attachments/${id}.png)`);
    const blob = await packagePage(markdown, content, async requested => {
      expect(requested).toBe(id);
      return new Blob([png]);
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const entries = new Map<string, Uint8Array>();
    let offset = 0;
    while (view.getUint32(offset, true) === 0x04034b50) {
      const size = view.getUint32(offset + 18, true);
      const nameLength = view.getUint16(offset + 26, true);
      const extraLength = view.getUint16(offset + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
      const start = offset + 30 + nameLength + extraLength;
      entries.set(name, bytes.slice(start, start + size));
      offset = start + size;
    }
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    expect([...entries.keys()]).toEqual(['document.md', `attachments/${id}.png`, 'manifest.json']);
    expect(new TextDecoder().decode(entries.get('document.md'))).toContain(`attachments/${id}.png`);
    expect(entries.get(`attachments/${id}.png`)).toEqual(png);
  });

  it('does not build a partial package after an attachment read fails', async () => {
    await expect(packagePage(`![截图](nbase-attachment:${id})`, content, async () => {
      throw new Error('ATTACHMENT_MISSING');
    })).rejects.toThrow('ATTACHMENT_MISSING');
  });
});
