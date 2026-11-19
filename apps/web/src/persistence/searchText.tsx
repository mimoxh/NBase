import type { ReactNode } from 'react';
import { historySearchPendingCap } from '@nbase/contracts';

/** Marks the first case-insensitive occurrence of `phrase`. */
export function marked(text: string, phrase: string): ReactNode {
  const at = text.toLocaleLowerCase().indexOf(phrase.toLocaleLowerCase());
  if (at < 0 || !phrase) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + phrase.length)}</mark>{text.slice(at + phrase.length)}</>;
}

/** The server's query limits: 100 UTF-16 units, 256 UTF-8 bytes, no control characters. */
export function searchPhraseInvalid(phrase: string): boolean {
  return phrase.length > 100 || new TextEncoder().encode(phrase).length > 256 || /[\u0000-\u001f\u007f]/.test(phrase);
}

export const invalidPhraseMessage = '关键词过长或含控制字符，请缩短后重试。';

export function pendingHistoryNotice(count: number): string {
  const amount = count >= historySearchPendingCap ? `${historySearchPendingCap} 多` : String(count);
  return `还有 ${amount} 个较早的版本正在建立搜索索引，暂时只能按标题找到它们。`;
}
