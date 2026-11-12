/** Intrinsic pixel size from the file header, so sizing works without decoding (and in tests). */
export function imageSize(bytes: Uint8Array, mediaType: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ok = (width: number, height: number) => width > 0 && height > 0 && width < 100_000 && height < 100_000 ? { width, height } : null;
  try {
    if (mediaType === 'image/png' && bytes.length >= 24 && view.getUint32(12) === 0x49484452) return ok(view.getUint32(16), view.getUint32(20));
    if (mediaType === 'image/gif' && bytes.length >= 10) return ok(view.getUint16(6, true), view.getUint16(8, true));
    if (mediaType === 'image/jpeg') {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const marker = bytes[offset + 1]!;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { offset += marker === 0xff ? 1 : 2; continue; }
        const length = view.getUint16(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
          return ok(view.getUint16(offset + 7), view.getUint16(offset + 5));
        offset += 2 + length;
      }
      return null;
    }
    if (mediaType === 'image/webp' && bytes.length >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === 'VP8X') return ok(1 + (bytes[24]! | bytes[25]! << 8 | bytes[26]! << 16), 1 + (bytes[27]! | bytes[28]! << 8 | bytes[29]! << 16));
      if (chunk === 'VP8 ') return ok(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
      if (chunk === 'VP8L') {
        const bits = view.getUint32(21, true);
        return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
      }
    }
  } catch { return null; }
  return null;
}
