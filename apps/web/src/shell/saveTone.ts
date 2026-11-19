export type SaveTone = 'idle' | 'loading' | 'editing' | 'saving' | 'synced' | 'saved' | 'offline' | 'failed' | 'conflict';

export interface SaveStatus {
  tone: SaveTone;
  text: string;
}

const savingTexts = new Set([
  '本机草稿已保留 · 等待服务端确认', '正在保存到服务端…',
  '已恢复本机草稿 · 等待服务端确认', '已选用本机草稿 · 等待服务端确认',
  '保存中',
]);
const savedTexts = new Set(['已保存到服务端', '已从服务端读取', '已保存']);
const offlineTexts = new Set(['网络中断；本机草稿仍可找回。', '请求超时，正在保留本机草稿。',
  '离线，修改保存在本机', '离线，正在重新连接']);
const loadingTexts = new Set(['正在读取页面…', '正在连接协同…', '正在等待协同内容…']);

/** Maps the exact status sentence to a pill tone; only `saved` texts may show 已保存. */
export function saveToneFor(text: string): SaveTone {
  if (!text) return 'idle';
  if (loadingTexts.has(text)) return 'loading';
  if (text === '正在写入本机草稿…') return 'editing';
  if (savingTexts.has(text)) return 'saving';
  // A co-edited page: the server holds the change, but no revision contains it yet.
  if (text === '已同步，等待保存') return 'synced';
  if (savedTexts.has(text)) return 'saved';
  if (text.includes('冲突')) return 'conflict';
  if (offlineTexts.has(text)) return 'offline';
  return 'failed';
}

export const pillLabels: Record<Exclude<SaveTone, 'idle'>, string> = {
  loading: '读取中', editing: '编辑中', saving: '保存中', synced: '已同步，等待保存', saved: '已保存',
  offline: '离线', failed: '保存失败', conflict: '冲突',
};
