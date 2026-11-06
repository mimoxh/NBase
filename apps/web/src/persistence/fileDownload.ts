export function download(name: string, text: string, type = 'text/markdown', extension = '.md') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || '未命名页面'}${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadBlob(name: string, blob: Blob, extension: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || '未命名页面'}${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
