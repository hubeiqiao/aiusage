import { DEFAULT_BREAKDOWN_LIMIT, MAX_BREAKDOWN_LIMIT } from '@aiusage/shared';
import { jsonOk, jsonError } from '../utils/response.js';
import { toPublicProjectName } from '../utils/privacy.js';
import type { Env } from '../types.js';

export async function handleBreakdowns(url: URL, env: Env): Promise<Response> {
  const range = url.searchParams.get('range') ?? '7d';
  const date = url.searchParams.get('date');
  const deviceId = url.searchParams.get('deviceId');
  const provider = url.searchParams.get('provider');
  const product = url.searchParams.get('product');
  const model = url.searchParams.get('model');
  const project = url.searchParams.get('project');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? String(DEFAULT_BREAKDOWN_LIMIT), 10), MAX_BREAKDOWN_LIMIT);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // 日期筛选
  if (date) {
    conditions.push('b.usage_date = ?');
    params.push(date);
  } else {
    const minDate = buildMinDate(range);
    if (minDate === undefined) return jsonError(400, 'INVALID_PAYLOAD', 'Invalid range parameter', true);
    if (minDate) {
      conditions.push('b.usage_date >= ?');
      params.push(minDate);
    }
  }

  if (deviceId) { conditions.push('b.device_id = ?'); params.push(deviceId); }
  if (provider) { conditions.push('b.provider = ?'); params.push(provider); }
  if (product) { conditions.push('b.product = ?'); params.push(product); }
  if (model) { conditions.push('b.model = ?'); params.push(model); }
  if (project) { conditions.push('b.project = ?'); params.push(project); }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // 总数
  const countResult = await env.DB.prepare(`SELECT COUNT(*) as total FROM daily_usage_breakdown b ${whereClause}`)
    .bind(...params)
    .first<{ total: number }>();
  const total = countResult?.total ?? 0;

  // 数据
  const rows = await env.DB.prepare(`
    SELECT b.device_id, b.usage_date, b.provider, b.product, b.channel, b.model, b.project,
           b.event_count, b.input_tokens, b.cached_input_tokens, b.cache_write_tokens,
           b.output_tokens, b.reasoning_output_tokens, b.estimated_cost_usd, b.cost_status
    FROM daily_usage_breakdown b ${whereClause}
    ORDER BY b.usage_date DESC, b.estimated_cost_usd DESC
    LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all();

  const data = await Promise.all((rows.results ?? []).map(async row => ({
    ...row,
    project: await toPublicProjectName(String(row.project ?? 'unknown'), env),
  })));

  return jsonOk({
    data,
    pagination: { total, limit, offset, hasMore: offset + limit < total },
  }, true);
}

function buildMinDate(range: string): string | null | undefined {
  if (range === 'all') return null;
  const now = new Date();
  let days: number;
  if (range === '7d') days = 7;
  else if (range === '3m') days = 90;
  else return undefined; // invalid
  const min = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return min.toISOString().split('T')[0];
}
