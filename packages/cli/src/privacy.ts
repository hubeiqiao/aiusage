import { createHash } from 'node:crypto';
import type { IngestBreakdown } from '@aiusage/shared';

export type ProjectVisibility = 'hidden' | 'masked' | 'plain';
export interface ProjectPrivacyFields {
  project: string;
  projectDisplay?: string;
  projectAlias?: string;
}

const DEFAULT_VISIBILITY: ProjectVisibility = 'masked';

/**
 * 把 IngestBreakdown[] 里的 project / projectDisplay / projectAlias 按隐私策略脱敏。
 * 原始绝对路径（含 /Users/<name>/... 或 C:\Users\<name>\...）永远不应离开本机。
 *
 * - hidden：project 与 projectDisplay 都替换为 `_redacted_`；alias 也清空
 * - masked：保留项目"basename + 8 字符短哈希"作为稳定不可逆标识；alias 清空
 * - plain：仅去掉绝对路径前缀，保留 basename（适合用户明确不在意暴露项目名时）
 */
export function applyPrivacy(
  breakdowns: IngestBreakdown[],
  visibility: ProjectVisibility | undefined,
): IngestBreakdown[] {
  return mergeBreakdowns(applyProjectPrivacy(breakdowns, visibility));
}

/**
 * 脱敏后必须重新聚合。
 * `hidden` 模式把所有 project 折叠成 `_redacted_`，原本属于不同项目、
 * 但 provider/product/channel/model 相同的行会得到同一个服务端主键
 * (device_id, usage_date, provider, product, channel, model, project)：
 * 后写入的行会覆盖前一行，导致 breakdown 维度的总量被少计。
 */
function mergeBreakdowns(items: IngestBreakdown[]): IngestBreakdown[] {
  const merged = new Map<string, IngestBreakdown>();

  for (const item of items) {
    const key = [item.provider, item.product, item.channel, item.model, item.project].join('\u0000');
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...item });
      continue;
    }

    existing.eventCount += item.eventCount;
    existing.inputTokens += item.inputTokens;
    existing.cachedInputTokens += item.cachedInputTokens;
    existing.cacheWriteTokens += item.cacheWriteTokens;
    existing.outputTokens += item.outputTokens;
    existing.reasoningOutputTokens += item.reasoningOutputTokens;
    if (item.sessionCount != null) existing.sessionCount = (existing.sessionCount ?? 0) + item.sessionCount;
    if (item.cacheWrite5mTokens != null) existing.cacheWrite5mTokens = (existing.cacheWrite5mTokens ?? 0) + item.cacheWrite5mTokens;
    if (item.cacheWrite1hTokens != null) existing.cacheWrite1hTokens = (existing.cacheWrite1hTokens ?? 0) + item.cacheWrite1hTokens;
    if (item.costUSD != null) {
      existing.costUSD = (existing.costUSD ?? 0) + item.costUSD;
      existing.pricingVersion = item.pricingVersion ?? existing.pricingVersion;
    }
  }

  return [...merged.values()];
}

/**
 * 活动指标同理：服务端主键为
 * (device_id, usage_date, provider, product, source, project, kind, name, confidence)，
 * 且写入是不带 ON CONFLICT 的 INSERT。脱敏折叠后若不聚合，第二条会触发唯一约束
 * 冲突，被 ingest 的宽 catch 静默吞掉，只留下当天的部分活动数据。
 */
export function applyActivityPrivacy<T extends ProjectPrivacyFields & {
  provider: string; product: string; source: string;
  kind: string; name: string; count: number; confidence: 'exact' | 'proxy';
  usageDate?: string;
}>(items: T[], visibility: ProjectVisibility | undefined): T[] {
  const merged = new Map<string, T>();

  for (const item of applyProjectPrivacy(items, visibility)) {
    // usageDate 必须进 key：调用方是在按天分组之前把多天的数据一起传进来的，
    // 少了日期会把不同日期的同名活动并到第一条的日期上，
    // 其余日期变成空活动上传，服务端对应行会被整日清理删掉。
    const key = [
      item.usageDate ?? '', item.provider, item.product, item.source,
      item.project, item.kind, item.name, item.confidence,
    ].join('\u0000');
    const existing = merged.get(key);
    if (existing) {
      existing.count += item.count;
      continue;
    }
    merged.set(key, { ...item });
  }

  return [...merged.values()];
}

export function applyProjectPrivacy<T extends ProjectPrivacyFields>(
  items: T[],
  visibility: ProjectVisibility | undefined,
): T[] {
  const mode = visibility ?? DEFAULT_VISIBILITY;
  return items.map(item => transformOne(item, mode));
}

function transformOne<T extends ProjectPrivacyFields>(b: T, mode: ProjectVisibility): T {
  const original = b.project ?? '';
  const display = b.projectDisplay ?? deriveBasename(original);

  if (mode === 'hidden') {
    return { ...b, project: '_redacted_', projectDisplay: '_redacted_', projectAlias: undefined };
  }

  if (mode === 'masked') {
    const base = deriveBasename(original);
    const hash = shortHash(original);
    return {
      ...b,
      project: `${base}-${hash}`,
      projectDisplay: base,
      projectAlias: undefined,
    };
  }

  // plain：去掉绝对路径，仅保留 basename
  const base = deriveBasename(original);
  return {
    ...b,
    project: base,
    projectDisplay: display,
    projectAlias: b.projectAlias,
  };
}

function deriveBasename(p: string): string {
  if (!p) return 'unknown';
  // 跨平台 basename：手动按 / 与 \\ 都切一遍，避免依赖 path.basename 的 OS-specific 行为
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || 'unknown';
}

function shortHash(p: string): string {
  if (!p) return '00000000';
  return createHash('sha1').update(p).digest('hex').slice(0, 8);
}
