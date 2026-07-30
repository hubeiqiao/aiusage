import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQuery, padMonth, currentMonthDates } from './data';

test('buildQuery encodes multi-select filters as repeated params', () => {
  const query = buildQuery({
    range: '30d',
    products: ['codex', 'claude-code'],
    models: ['gpt-5.5', 'gpt-5.4-mini'],
    projects: ['aiusage'],
    deviceIds: ['mbp-16', 'us1'],
  });

  const params = new URLSearchParams(query);
  assert.equal(params.get('range'), '30d');
  assert.deepEqual(params.getAll('product'), ['codex', 'claude-code']);
  assert.deepEqual(params.getAll('model'), ['gpt-5.5', 'gpt-5.4-mini']);
  assert.deepEqual(params.getAll('project'), ['aiusage']);
  assert.deepEqual(params.getAll('deviceId'), ['mbp-16', 'us1']);
});

test('buildQuery keeps month range for the API', () => {
  const query = buildQuery({ range: 'month', products: [] });
  assert.equal(new URLSearchParams(query).get('range'), 'month');
});

test('padMonth keeps zero-cost days that still have events', () => {
  // 未配置单价的模型（例如目录补齐前的 Opus 5）会产生 cost=0 但 eventCount>0 的
  // 真实用量。按费用过滤会让这些用量从 totalEvents / activeDays 里消失。
  const today = new Date();
  const day = (d: number) => `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const ov = {
    totalDays: 2, activeDays: 2, totalEvents: 150, totalSessions: 0,
    costBearingEvents: 100, totalCostUsd: 10, averageDailyCostUsd: 5,
    dailyTrend: [
      { usageDate: day(1), eventCount: 100, estimatedCostUsd: 10 },
      { usageDate: day(2), eventCount: 50, estimatedCostUsd: 0 },
    ],
    tokenComposition: [],
    providerCostShare: [], productCostShare: [], modelCostShare: [], channelCostShare: [],
    sankey: { nodes: [], links: [] }, heatmap: [],
    filters: { options: { providers: [] }, selected: {} },
  } as unknown as Parameters<typeof padMonth>[0];

  const padded = padMonth(ov);

  assert.equal(padded.totalEvents, 150, 'zero-cost day events must be retained');
  assert.equal(padded.activeDays, 2, 'zero-cost day must still count as active');
  assert.equal(padded.totalCostUsd, 10);
});

test('currentMonthDates uses UTC so it matches the Worker month window', () => {
  // Worker 用 startOfUtcDay 选月；本地年月在月末跨时区时会和它错开一个月，
  // 导致「本月」视图 key 对不上而整片归零。
  const dates = currentMonthDates();
  const now = new Date();
  const expectedPrefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  assert.ok(dates.length >= 28 && dates.length <= 31);
  assert.ok(dates.every((d) => d.startsWith(expectedPrefix)), `expected all dates in ${expectedPrefix}`);
  assert.equal(dates[0], `${expectedPrefix}-01`);
});
