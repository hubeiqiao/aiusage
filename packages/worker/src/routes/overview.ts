import { jsonOk, jsonError } from '../utils/response.js';
import type { Env } from '../types.js';

export async function handleOverview(url: URL, env: Env): Promise<Response> {
  const range = url.searchParams.get('range') ?? '7d';
  const deviceId = url.searchParams.get('deviceId');
  const provider = url.searchParams.get('provider');
  const product = url.searchParams.get('product');

  const dateFilter = buildDateFilter(range);
  if (!dateFilter) return jsonError(400, 'INVALID_PAYLOAD', 'Invalid range parameter', true);

  // 构建查询条件
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (dateFilter.minDate) {
    conditions.push('d.usage_date >= ?');
    params.push(dateFilter.minDate);
  }
  if (deviceId) {
    conditions.push('d.device_id = ?');
    params.push(deviceId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // 总览
  const summary = await env.DB.prepare(`
    SELECT
      COUNT(DISTINCT d.usage_date) as total_days,
      COALESCE(SUM(d.event_count), 0) as total_events,
      COALESCE(SUM(d.estimated_cost_usd), 0) as total_cost_usd
    FROM daily_usage d ${whereClause}
  `).bind(...params).first<{ total_days: number; total_events: number; total_cost_usd: number }>();

  // 每日趋势（如果有 provider/product 筛选，走 breakdown 表聚合）
  let trendQuery: string;
  let trendParams: (string | number)[];

  if (provider || product) {
    const bConditions = [...conditions.map(c => c.replace('d.', 'b.'))];
    const bParams = [...params];
    if (provider) { bConditions.push('b.provider = ?'); bParams.push(provider); }
    if (product) { bConditions.push('b.product = ?'); bParams.push(product); }
    const bWhere = bConditions.length > 0 ? `WHERE ${bConditions.join(' AND ')}` : '';

    trendQuery = `
      SELECT b.usage_date, SUM(b.event_count) as event_count, SUM(b.estimated_cost_usd) as estimated_cost_usd
      FROM daily_usage_breakdown b ${bWhere}
      GROUP BY b.usage_date ORDER BY b.usage_date
    `;
    trendParams = bParams;
  } else {
    trendQuery = `
      SELECT d.usage_date, SUM(d.event_count) as event_count, SUM(d.estimated_cost_usd) as estimated_cost_usd
      FROM daily_usage d ${whereClause}
      GROUP BY d.usage_date
      ORDER BY d.usage_date
    `;
    trendParams = params;
  }

  const trend = await env.DB.prepare(trendQuery).bind(...trendParams).all<{
    usage_date: string;
    event_count: number;
    estimated_cost_usd: number;
  }>();

  return jsonOk({
    totalDays: summary?.total_days ?? 0,
    totalEvents: summary?.total_events ?? 0,
    totalCostUsd: Math.round((summary?.total_cost_usd ?? 0) * 10000) / 10000,
    dailyTrend: (trend.results ?? []).map(r => ({
      usageDate: r.usage_date,
      eventCount: r.event_count,
      estimatedCostUsd: Math.round(r.estimated_cost_usd * 10000) / 10000,
    })),
  }, true);
}

function buildDateFilter(range: string): { minDate: string | null } | null {
  if (range === 'all') return { minDate: null };

  const now = new Date();
  let days: number;
  if (range === '7d') days = 7;
  else if (range === '3m') days = 90;
  else return null;

  const min = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { minDate: min.toISOString().split('T')[0] };
}
