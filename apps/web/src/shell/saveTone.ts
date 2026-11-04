export type SaveTone = 'idle' | 'loading' | 'editing' | 'saving' | 'saved' | 'offline' | 'failed' | 'conflict';

export interface SaveStatus {
  tone: SaveTone;
  text: string;
}

const savingTexts = new Set([
  '本机草稿已保留 · 等待服务端确认', '正在保存到服务端…',
  '已恢复本机草稿 · 等待服务端确认', '已选用本机草稿 · 等待服务端确认',
]);
const savedTexts = new Set(['已保存到服务端', '已从服务端读取']);
const offlineTexts = new Set(['网络中断；本机草稿仍可找回。', '请求超时，正在保留本机草稿。']);

/** Maps the exact status sentence to a pill tone; only `saved` texts may show 已保存. */
export function saveToneFor(text: string): SaveTone {
  if (!text) return 'idle';
  if (text === '正在读取页面…') return 'loading';
  if (text === '正在写入本机草稿…') return 'editing';
  if (savingTexts.has(text)) return 'saving';
  if (savedTexts.has(text)) return 'saved';
  if (text.includes('冲突')) return 'conflict';
  if (offlineTexts.has(text)) return 'offline';
  return 'failed';
}

export const pillLabels: Record<Exclude<SaveTone, 'idle'>, string> = {
  loading: '读取中', editing: '编辑中', saving: '保存中', saved: '已保存',
  offline: '离线', failed: '保存失败', conflict: '冲突',
};
