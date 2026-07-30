/**
 * Worker 侧定价入口 —— 转发到 @aiusage/shared 的统一定价目录。
 * 历史 ModelPricing / PricingCatalog 类型保留 re-export 以兼容现有调用。
 */
import { calculateCost as calculateSharedCost } from '@aiusage/shared';
import type { CostCalcResult, IngestBreakdown } from '@aiusage/shared';

const CLAUDE_CODE_PRODUCT = 'claude-code';

/**
 * 兼容旧客户端与 ninerouter 路由的 Anthropic 模型写法：
 * 小写、`_`→`-`、claude-* 的点号→短横线、去掉 `-v1-0` 与 8 位日期后缀。
 * 上游目录改为「显式 alias + 拒绝跨档回退」，未登记的写法会返回 unavailable；
 * 这里只在 Anthropic 定价失败时兜底，避免这类成本被静默记为 0。
 */
function normalizeAnthropicModel(model: string): string {
  let normalized = model.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized.startsWith('claude-')) return normalized;
  normalized = normalized.replace(/\./g, '-');
  normalized = normalized.replace(/-v\d+(?:-\d+)*$/, '');
  normalized = normalized.replace(/-\d{8}$/, '');
  return normalized;
}

export function calculateIngestBreakdownCost(breakdown: IngestBreakdown): CostCalcResult {
  const tokens = {
    inputTokens: breakdown.inputTokens,
    cachedInputTokens: breakdown.cachedInputTokens,
    cacheWriteTokens: breakdown.cacheWriteTokens,
    cacheWrite5mTokens: breakdown.cacheWrite5mTokens ?? breakdown.cacheWriteTokens,
    cacheWrite1hTokens: breakdown.cacheWrite1hTokens ?? 0,
    outputTokens: breakdown.outputTokens,
  };
  const options = { requestCount: breakdown.eventCount };

  let calculated = calculateSharedCost(
    breakdown.provider,
    breakdown.product,
    breakdown.model,
    tokens,
    options,
  );

  // ninerouter 会把 Anthropic 模型路由到 codex 等产品下；旧客户端也可能上报
  // `claude-opus-4.8` / `CLAUDE_SONNET_4_20250514_V1_0` 这类写法。
  // 直接查表失败时，按 claude-code 价目表用归一化后的模型名再试一次。
  if (calculated.costStatus === 'unavailable' && breakdown.provider === 'anthropic') {
    const retry = calculateSharedCost(
      'anthropic',
      CLAUDE_CODE_PRODUCT,
      normalizeAnthropicModel(breakdown.model),
      tokens,
      options,
    );
    if (retry.costStatus !== 'unavailable') {
      calculated = retry;
    }
  }

  const hasVendorReportedCost = breakdown.product === 'trae-intl' || breakdown.product === 'opencode';
  // 服务端无法定价的来源（如 Kiro 按积分计费：本地没有 token 数据，目录里也没有对应
  // provider/model），按 token 计费必然得到 0。这类情况必须采用 CLI 预算的 costUSD，
  // 否则成本会被静默记为 0。可定价的模型仍受 pricingVersion 一致性校验保护。
  const serverCannotPrice =
    calculated.costStatus === 'unavailable' || calculated.estimatedCostUsd === 0;
  const clientCostTrusted =
    hasVendorReportedCost || breakdown.pricingVersion === calculated.pricingVersion;

  if (
    breakdown.costUSD == null ||
    !Number.isFinite(breakdown.costUSD) ||
    breakdown.costUSD <= 0 ||
    (!clientCostTrusted && !serverCannotPrice)
  ) {
    return calculated;
  }

  return {
    ...calculated,
    estimatedCostUsd: Math.round(breakdown.costUSD * 10000) / 10000,
    costStatus: clientCostTrusted ? 'exact' : 'estimated',
  };
}

export {
  calculateCost,
  getWorstCostStatus,
  getPricingCatalog,
  catalog,
  PRICING_VERSION,
} from '@aiusage/shared';

export type {
  ModelPricing,
  PricingCatalog,
  ProductPricing,
  Currency,
  PricingTier,
  CostCalcInput,
  CostCalcResult,
} from '@aiusage/shared';
