import { describe, expect, it } from 'vitest';
import { pillLabels, saveToneFor } from './saveTone';

describe('saveToneFor', () => {
  it('marks only server-confirmed texts as saved', () => {
    expect(saveToneFor('已保存到服务端')).toBe('saved');
    expect(saveToneFor('已从服务端读取')).toBe('saved');
    for (const tone of ['editing', 'saving', 'loading', 'failed'] as const) {
      expect(saveToneFor(Object.entries(pillLabels).find(([, label]) => label !== '已保存' && true)?.[0] ?? '')).not.toBe(tone === 'loading' ? 'saved' : 'idle');
    }
  });
  it('maps each existing status sentence to its tone', () => {
    expect(saveToneFor('')).toBe('idle');
    expect(saveToneFor('正在读取页面…')).toBe('loading');
    expect(saveToneFor('正在写入本机草稿…')).toBe('editing');
    expect(saveToneFor('本机草稿已保留 · 等待服务端确认')).toBe('saving');
    expect(saveToneFor('正在保存到服务端…')).toBe('saving');
    expect(saveToneFor('已恢复本机草稿 · 等待服务端确认')).toBe('saving');
    expect(saveToneFor('已选用本机草稿 · 等待服务端确认')).toBe('saving');
    expect(saveToneFor('发现待处理的本机草稿与服务端版本冲突')).toBe('conflict');
    expect(saveToneFor('另一标签或设备已更新这篇页面，请先处理冲突。')).toBe('conflict');
    expect(saveToneFor('网络中断；本机草稿仍可找回。')).toBe('offline');
    expect(saveToneFor('请求超时，正在保留本机草稿。')).toBe('offline');
    expect(saveToneFor('本机草稿写入失败，请立即下载 Markdown')).toBe('failed');
    expect(saveToneFor('服务暂时无法完成操作，请重试。')).toBe('failed');
  });
});
