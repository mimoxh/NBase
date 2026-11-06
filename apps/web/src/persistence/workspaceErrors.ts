import { ApiError } from './client';

export function message(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : '操作失败，请重试。';
  const messages: Record<string, string> = {
    AUTH_REQUIRED: '请重新登录，当前草稿仍保留在本机。', AUTH_EXPIRED: '登录已过期，当前草稿仍保留在本机。',
    AUTH_INVALID: '账号或密码不正确。', RATE_LIMITED: '尝试次数过多，请稍后再试。',
    NETWORK_UNAVAILABLE: '网络中断；本机草稿仍可找回。', TIMEOUT: '请求超时，正在保留本机草稿。',
    REVISION_CONFLICT: '另一标签或设备已更新这篇页面，请先处理冲突。',
    MUTATION_CONFLICT: '本次重试内容不一致，请保留本地内容并重新打开。',
    PAGE_TREE_INVALID: '目标页面无效或会形成循环。', CONTENT_VERSION_UNSUPPORTED: '此文档的格式版本暂不支持。',
    PAGE_TREE_CHANGED: '子页面范围已变化，请重新确认删除。',
    CONTENT_INVALID: '当前正文包含无法保存的内容，请下载 Markdown 保留。',
    PAGE_LIMIT_EXCEEDED: '页面数量超过当前工作台加载上限。',
    ATTACHMENT_TOO_LARGE: '附件超过 10 MB 限制。', ATTACHMENT_EMPTY: '不能上传空文件。',
    ATTACHMENT_TYPE_UNSUPPORTED: '仅支持 PNG、JPEG、GIF、WebP、PDF、ZIP、TXT 和 Markdown。',
    ATTACHMENT_TYPE_MISMATCH: '文件后缀与实际类型不一致。',
    ATTACHMENT_NAME_INVALID: '附件名称包含不允许的字符。',
    ATTACHMENT_ID_CONFLICT: '附件重试 ID 与已有内容冲突，请重新添加。',
    ATTACHMENT_INVALID: '文档中有无效附件引用，请保留本机草稿并检查附件。',
    ATTACHMENT_MISSING: '附件文件缺失，导出已停止。',
    ATTACHMENT_CORRUPT: '附件文件与数据库记录不一致，导出已停止。',
    FAVORITE_LIMIT: '收藏已达 200 个上限。',
    DAILY_NOTE_TRASHED: '这一天的笔记在回收站，请先恢复。',
    DAILY_PARENT_UNAVAILABLE: '每日笔记的默认父页不可用，请更新设置。',
    PAGE_REFERENCE_INVALID: '正文引用的页面不在当前工作区，请检查引用或下载本机草稿。',
  };
  return messages[error.code] ?? '服务暂时无法完成操作，请重试。';
}

export function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
