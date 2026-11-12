import type { ImageSource } from './render/canvas';

/** Loads board images once per attachment and notifies the renderer when one becomes drawable. */
export class ImageCache implements ImageSource {
  private entries = new Map<string, { image: HTMLImageElement; state: 'loading' | 'ready' | 'error'; done: Promise<void> }>();

  constructor(private urlFor: (attachmentId: string) => string | null, private onChange: () => void) {}

  setResolver(urlFor: (attachmentId: string) => string | null) { this.urlFor = urlFor; }

  private entry(id: string) {
    const known = this.entries.get(id);
    if (known) return known;
    const image = new Image();
    const url = this.urlFor(id);
    let finish: () => void = () => undefined;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const entry = { image, state: 'loading' as 'loading' | 'ready' | 'error', done };
    this.entries.set(id, entry);
    image.decoding = 'async';
    image.onload = () => { entry.state = 'ready'; finish(); this.onChange(); };
    image.onerror = () => { entry.state = 'error'; finish(); this.onChange(); };
    if (url) image.src = url; else { entry.state = 'error'; finish(); }
    return entry;
  }

  get(id: string): HTMLImageElement | 'loading' | 'error' {
    const entry = this.entry(id);
    return entry.state === 'ready' ? entry.image : entry.state;
  }

  async ready(ids: Iterable<string>): Promise<void> { await Promise.all([...new Set(ids)].map(id => this.entry(id).done)); }

  async size(id: string): Promise<{ w: number; h: number }> {
    const entry = this.entry(id);
    await entry.done;
    return entry.state === 'ready' ? { w: entry.image.naturalWidth || 320, h: entry.image.naturalHeight || 240 } : { w: 320, h: 240 };
  }

  /** Self-contained copies for SVG export; images that cannot be read are left out. */
  async dataUrls(ids: Iterable<string>): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    await Promise.all([...new Set(ids)].map(async id => {
      const url = this.urlFor(id);
      if (!url) return;
      try {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) return;
        const blob = await response.blob();
        result.set(id, await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        }));
      } catch { /* Exported without this image. */ }
    }));
    return result;
  }
}
