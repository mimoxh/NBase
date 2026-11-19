// Injected by the NBase Android shell at document start, only into the configured server origin.
(() => {
  'use strict';
  const bridge = window.NBaseAndroid;
  if (!bridge || window.__nbaseAndroidReady) return;
  window.__nbaseAndroidReady = true;

  // A multiple of 3, so each chunk encodes to base64 on its own without padding.
  const CHUNK_BYTES = 3 * 128 * 1024;
  let sequence = 0;
  const post = (message) => bridge.postMessage(JSON.stringify(message));

  const toBase64 = (bytes) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };

  async function send(blobPromise, name) {
    const id = `d${++sequence}-${Date.now().toString(36)}`;
    try {
      const blob = await blobPromise;
      post({ type: 'download-begin', id, name, size: blob.size });
      for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
        post({ type: 'download-chunk', id, data: toBase64(bytes) });
      }
      post({ type: 'download-end', id });
    } catch (error) {
      post({ type: 'download-error', id, message: String((error && error.message) || error) });
    }
  }

  // fetch() captures a blob: URL when it is called, so pages may revoke the URL right after click().
  const fetchBlob = (href) => fetch(href, { credentials: 'same-origin' }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  });

  const fileName = (anchor, url) => {
    const named = anchor.getAttribute('download');
    if (named) return named;
    const last = url.pathname.split('/').pop() || '';
    try { return decodeURIComponent(last) || 'download'; } catch { return last || 'download'; }
  };

  function intercept(anchor) {
    if (!anchor.hasAttribute('download')) return false;
    let url;
    try { url = new URL(anchor.href, location.href); } catch { return false; }
    if (url.protocol !== 'blob:' && url.protocol !== 'data:' && url.origin !== location.origin) return false;
    send(fetchBlob(url.href), fileName(anchor, url));
    return true;
  }

  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!intercept(this)) click.call(this);
  };
  // Bubble phase on window runs after the page's own handlers, so a page that cancels the click keeps control.
  window.addEventListener('click', (event) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return;
    const anchor = event.target.closest('a[download]');
    if (anchor instanceof HTMLAnchorElement && intercept(anchor)) event.preventDefault();
  });
  window.__nbaseSaveUrl = (href, name) => send(fetchBlob(href), name);
  window.print = () => post({ type: 'print', title: document.title });

  // WebView drops `webkitdirectory` and shows a plain file picker, whose files have no relative paths.
  const isFolderInput = (el) => el instanceof HTMLInputElement && el.type === 'file' && el.hasAttribute('webkitdirectory');
  const refuseFolder = () => post({ type: 'folder-unsupported' });
  const inputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (isFolderInput(this)) refuseFolder();
    else inputClick.call(this);
  };
  const showPicker = HTMLInputElement.prototype.showPicker;
  if (showPicker) {
    HTMLInputElement.prototype.showPicker = function () {
      if (isFolderInput(this)) refuseFolder();
      else showPicker.call(this);
    };
  }
  window.addEventListener('click', (event) => {
    if (!isFolderInput(event.target)) return;
    event.preventDefault();
    refuseFolder();
  }, true);
  let lastBackground = '';
  const reportTheme = () => {
    const rootValue = getComputedStyle(document.documentElement).getPropertyValue('--nb-bg').trim();
    const value = rootValue || (document.body ? getComputedStyle(document.body).backgroundColor : '');
    if (!value || value === lastBackground) return;
    lastBackground = value;
    post({ type: 'theme', background: value });
  };
  const watchTheme = () => {
    reportTheme();
    new MutationObserver(reportTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(reportTheme, 0));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchTheme, { once: true });
  else watchTheme();
  window.addEventListener('load', reportTheme);
})();
