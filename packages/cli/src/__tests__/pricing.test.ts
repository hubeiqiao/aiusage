import { describe, expect, it } from 'vitest';
import { assertPricingCatalog } from '../pricing.js';

/**
 * 同步上游后，定价目录换成了 `*_per_million` + `fx` 的新结构。
 * 若 Worker 还没升级，`/api/v1/public/pricing` 会返回旧结构
 * （`*_per_million_usd`、没有 fx），新计价器会算出 0/NaN 甚至直接抛错。
 * 校验必须拒绝这类目录，让 CLI 回退到 npm CDN / 内置目录。
 */

const newShapeCatalog = {
  version: '2026-07-26-claude-5-v1',
  fx: { CNY: 7.2 },
  aliases: {},
  providers: {
    openai: {
      codex: {
        models: {
          'gpt-5.6-sol': {
            currency: 'USD',
            input_per_million: 5,
            cached_input_per_million: 0.5,
            output_per_million: 30,
          },
        },
      },
    },
  },
};

function legacyCatalog() {
  return {
    version: '2026-07-09-official-v5',
    aliases: {},
    providers: {
      openai: {
        codex: {
          models: {
            'gpt-5.6-sol': {
              input_per_million_usd: 5,
              cached_input_per_million_usd: 0.5,
              output_per_million_usd: 30,
            },
          },
        },
      },
    },
  };
}

describe('assertPricingCatalog', () => {
  it('accepts the current catalog shape', () => {
    expect(() => assertPricingCatalog(newShapeCatalog)).not.toThrow();
  });

  it('rejects a legacy *_per_million_usd catalog from an un-upgraded Worker', () => {
    expect(() => assertPricingCatalog(legacyCatalog())).toThrow(/incompatible pricing catalog/);
  });

  it('rejects a catalog without an fx table', () => {
    const noFx = structuredClone(newShapeCatalog) as Record<string, unknown>;
    delete noFx.fx;
    expect(() => assertPricingCatalog(noFx)).toThrow(/missing fx table/);
  });

  it('rejects a catalog without an aliases map', () => {
    // calculateCost 直接取 catalog.aliases[model]，缺失会在首次计价时崩溃
    const noAliases = structuredClone(newShapeCatalog) as Record<string, unknown>;
    delete noAliases.aliases;
    expect(() => assertPricingCatalog(noAliases)).toThrow(/missing aliases map/);
  });

  it('still rejects structurally broken catalogs', () => {
    expect(() => assertPricingCatalog(null)).toThrow(/invalid pricing catalog/);
    expect(() => assertPricingCatalog({ version: '1', providers: {} })).toThrow(/invalid OpenAI pricing catalog/);
    expect(() => assertPricingCatalog({ providers: newShapeCatalog.providers })).toThrow(/version/);
  });
});
