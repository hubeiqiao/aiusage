import { describe, expect, it } from 'vitest';
import { applyPrivacy, applyActivityPrivacy } from '../privacy.js';
import type { IngestBreakdown } from '@aiusage/shared';

function breakdown(project: string, eventCount: number, inputTokens: number): IngestBreakdown {
  return {
    provider: 'anthropic', product: 'claude-code', channel: 'cli',
    model: 'claude-opus-5', project,
    eventCount, inputTokens, cachedInputTokens: 0, cacheWriteTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0,
  } as IngestBreakdown;
}

/**
 * hidden 模式会把所有 project 折叠成 `_redacted_`。服务端 breakdown 主键含 project，
 * 活动表主键也含 project 且插入不带 ON CONFLICT，因此脱敏后必须先聚合，
 * 否则会被覆盖（少计）或触发唯一约束冲突（当天活动数据只写入一部分）。
 */
describe('applyPrivacy: hidden 模式聚合 breakdown', () => {
  it('把折叠后 key 相同的行合并而不是保留重复项', () => {
    const merged = applyPrivacy([breakdown('/Users/joe/a', 3, 100), breakdown('/Users/joe/b', 4, 200)], 'hidden');

    expect(merged).toHaveLength(1);
    expect(merged[0].project).toBe('_redacted_');
    expect(merged[0].eventCount).toBe(7);
    expect(merged[0].inputTokens).toBe(300);
  });

  it('masked 模式按项目哈希保持区分，不会被合并', () => {
    const merged = applyPrivacy([breakdown('/Users/joe/a', 3, 100), breakdown('/Users/joe/b', 4, 200)], 'masked');
    expect(merged).toHaveLength(2);
  });
});

describe('applyActivityPrivacy: hidden 模式聚合活动指标', () => {
  const item = (project: string, count: number) => ({
    provider: 'anthropic', product: 'claude-code', source: 'anthropic/claude-code',
    project, kind: 'tool', name: 'Read', count, confidence: 'exact' as const,
  });

  it('合并折叠后主键相同的活动行', () => {
    const merged = applyActivityPrivacy([item('/Users/joe/a', 5), item('/Users/joe/b', 6)], 'hidden');

    expect(merged).toHaveLength(1);
    expect(merged[0].project).toBe('_redacted_');
    expect(merged[0].count).toBe(11);
  });

  it('不同 kind/name 仍然保持独立', () => {
    const merged = applyActivityPrivacy(
      [item('/Users/joe/a', 5), { ...item('/Users/joe/b', 6), name: 'Write' }],
      'hidden',
    );
    expect(merged).toHaveLength(2);
  });
});
