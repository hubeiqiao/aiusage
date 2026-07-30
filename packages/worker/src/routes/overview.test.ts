import { describe, expect, it } from 'vitest';
import {
  buildActivityWhere,
  buildDateWindow,
  buildWhere,
  emptyInteractionMetrics,
  parseFilters,
  type DashboardFilters,
} from './overview';

// ─── 上游：日期窗口与多选 facet ───

describe('overview filters', () => {
  it('builds inclusive date windows that include today without adding an extra day', () => {
    const now = new Date('2026-07-20T10:00:00.000Z');

    expect(buildDateWindow('7d', now)).toEqual({
      minDate: '2026-07-14',
      maxDate: '2026-07-20',
      days: 7,
    });
    expect(buildDateWindow('30d', now)).toEqual({
      minDate: '2026-06-21',
      maxDate: '2026-07-20',
      days: 30,
    });
    expect(buildDateWindow('month', now)).toEqual({
      minDate: '2026-07-01',
      maxDate: '2026-07-20',
      days: 20,
    });
  });

  it('parses repeated and comma-separated facet params as multi-select values', () => {
    const filters = parseFilters(new URL('https://example.com/api/v1/public/overview?range=30d&product=codex&product=claude-code&model=gpt-5,claude-opus'));

    expect(filters?.product).toEqual(['codex', 'claude-code']);
    expect(filters?.model).toEqual(['gpt-5', 'claude-opus']);
  });

  it('builds IN clauses for multi-selected facets', () => {
    const filters = parseFilters(new URL('https://example.com/api/v1/public/overview?range=7d&deviceId=mac-a&deviceId=mac-b&project=AIUsage'))!;
    const where = buildWhere(filters);

    expect(where.whereClause).toContain('b.device_id IN (?, ?)');
    expect(where.whereClause).toContain('COALESCE(b.project_alias, b.project_display) = ?');
    expect(where.params).toEqual([expect.any(String), expect.any(String), 'mac-a', 'mac-b', 'AIUsage']);
  });
});

// ─── fork：activity / interaction 指标助手（Kiro 依赖这条路径）───

function activityFilters(overrides: Partial<DashboardFilters> = {}): DashboardFilters {
  return {
    minDate: '2026-07-01',
    maxDate: null,
    rangeDays: 30,
    range: '30d',
    deviceId: [],
    provider: [],
    product: [],
    channel: [],
    model: [],
    project: [],
    ...overrides,
  };
}

describe('overview activity metrics helpers', () => {
  it('builds activity filters using daily_activity_breakdown columns', () => {
    const where = buildActivityWhere(activityFilters({
      deviceId: ['joes-macbook-pro-local'],
      provider: ['kiro'],
      product: ['kiro'],
      project: ['Project F8A64F'],
    }));

    expect(where.whereClause).toBe(
      'WHERE a.usage_date >= ? AND a.device_id = ? AND a.provider = ? AND a.product = ? AND COALESCE(a.project_alias, a.project_display) = ?',
    );
    expect(where.params).toEqual([
      '2026-07-01',
      'joes-macbook-pro-local',
      'kiro',
      'kiro',
      'Project F8A64F',
    ]);
  });

  it('returns no activity rows when model filters cannot apply to activity metrics', () => {
    const where = buildActivityWhere(activityFilters({
      channel: ['ide'],
      model: ['claude-fable-5'],
    }));

    expect(where.whereClause).toContain('1 = 0');
    expect(where.params).toEqual(['2026-07-01']);
  });

  it('keeps cli-channel activity rows, since activity metrics are cli-only', () => {
    const where = buildActivityWhere(activityFilters({ channel: ['cli'] }));

    expect(where.whereClause).not.toContain('1 = 0');
  });

  it('provides a stable empty payload when the activity table is absent', () => {
    expect(emptyInteractionMetrics()).toEqual({
      exactCount: 0,
      proxyCount: 0,
      userMessageCount: 0,
      functionCallCount: 0,
      toolCallCount: 0,
      skillCallCount: 0,
      skillProxyCount: 0,
      subagentCount: 0,
      topTools: [],
      topSkills: [],
      topAgents: [],
      kindShare: [],
    });
  });
});
