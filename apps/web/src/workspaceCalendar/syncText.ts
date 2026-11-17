import type { CalendarImportWarningCode, CalendarSyncCounts, CalendarSyncError, CalendarSyncKind, CalendarSyncSource } from '@nbase/contracts';
import { ApiError } from '../persistence/client';

export const syncKindLabels: Record<CalendarSyncKind, string> = { 'ics-file': '导入文件', 'ics-url': '订阅', caldav: 'CalDAV' };

export const credentialsUnavailableText = '服务端未配置凭据密钥，暂时不能连接 CalDAV。请联系管理员配置后再试。';

const syncErrorText: Record<CalendarSyncError, string> = {
  URL_INVALID: '网址无效',
  URL_BLOCKED: '这个地址不允许访问，只支持公网地址',
  FETCH_FAILED: '抓取失败，请稍后再试',
  NOT_CALENDAR: '内容不是日历文件',
  TOO_LARGE: '日历文件超过大小限制',
  PARSE_FAILED: '日历文件解析失败',
  ROW_LIMIT: '事件数量超过上限（10000）',
  DISABLED: '服务端已关闭日历抓取',
  AUTH_FAILED: '账号或密码不正确，请更新密码',
  CREDENTIALS_UNAVAILABLE: '服务端未配置凭据密钥，无法同步',
  CALENDAR_NOT_FOUND: '外部日历已不存在',
  NOT_CALDAV: '这个地址不是 CalDAV 服务器',
};

/** The last sync error of a source, worded for its kind. */
export function sourceErrorText(source: Pick<CalendarSyncSource, 'kind' | 'lastError'>): string {
  if (!source.lastError) return '';
  if (source.kind === 'caldav' && source.lastError === 'URL_BLOCKED') return '服务器地址不允许访问；本机或内网的服务器需要管理员在服务端开启';
  if (source.kind === 'caldav' && source.lastError === 'FETCH_FAILED') return '无法连接服务器，请稍后再试';
  return syncErrorText[source.lastError];
}

export const warningText: Record<CalendarImportWarningCode, string> = {
  RULE_UNSUPPORTED: '部分重复规则不支持，只保留了第一次',
  TIMEZONE_UNKNOWN: '部分时区无法识别，已按 UTC 处理',
  EVENT_INVALID: '部分事件无效，已跳过',
  TRUNCATED: '事件数量超过上限，多余部分未导入',
  VALUE_SHORTENED: '部分过长的内容被缩短',
  WRITE_REJECTED: '外部日历拒绝了部分修改，下次同步再试',
};

export const countsText = (counts: CalendarSyncCounts) =>
  [`新建 ${counts.created}`, `更新 ${counts.updated}`, `未变 ${counts.unchanged}`]
    .concat(counts.pushed ? [`写回 ${counts.pushed}`] : [], counts.conflicts ? [`冲突 ${counts.conflicts}`] : [],
      counts.skipped ? [`跳过 ${counts.skipped}`] : [], counts.removed ? [`移入回收站 ${counts.removed}`] : [])
    .join(' · ');

export const intervalText = (minutes: number) =>
  (minutes >= 1440 ? `每 ${minutes / 1440} 天` : minutes >= 60 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`);

export const timeText = (iso: string | null, timeZone?: string) => {
  if (!iso) return '尚未同步';
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '尚未同步'
    : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(ms);
};

export const statusText = (source: CalendarSyncSource) =>
  source.status === 'running' ? '同步中…' : source.status === 'error' ? '上次同步失败' : source.lastSyncedAt ? '正常' : '待首次同步';

/** Whether the source needs its account name and password entered again. */
export const needsCredentials = (source: CalendarSyncSource) =>
  source.kind === 'caldav' && (source.lastError === 'AUTH_FAILED' || source.caldav?.credentialsOk === false);

/** Text for a failed request; `lost` replaces the default for a response that may not have arrived. */
export function requestErrorText(error: unknown, lost = '网络不可用或服务器响应超时，请重试。'): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return lost;
    if (error.code === 'CREDENTIALS_UNAVAILABLE') return credentialsUnavailableText;
    switch (error.code) {
      case 'AUTH_FAILED': return '账号或密码不正确。请使用专用密码，而不是平时的登录密码。';
      case 'NOT_CALDAV': return '这个地址不是 CalDAV 服务器，请检查服务器地址。';
      case 'CALENDAR_NOT_FOUND': return '找不到所选的日历，它可能已被删除。请重新连接后再选。';
      case 'URL_INVALID': return '服务器地址无效。';
      case 'URL_BLOCKED': return '这个地址不允许访问。本机或内网的服务器需要管理员在服务端开启后才能连接。';
      case 'FETCH_FAILED': return '无法连接服务器，请检查地址或稍后再试。';
      case 'SYNC_RUNNING': return '正在同步，请稍后再试。';
      case 'SYNC_KIND_INVALID': return '这个来源不支持这项操作。';
      case 'CONFLICT_CHOICE_INVALID': return '这个冲突不能两份都保留。';
      default: break;
    }
    if (error.status === 401) return '登录已失效，请重新登录。';
    if (error.status === 403) return '没有执行此操作的权限。';
  }
  return '操作失败，请重试。';
}
