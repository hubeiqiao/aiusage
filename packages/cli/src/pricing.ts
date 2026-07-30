import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { catalog as bundledCatalog, type PricingCatalog } from '@aiusage/shared';
import type { AIUsageConfig, SyncTarget } from './config.js';

const CACHE_DIR = join(homedir(), '.aiusage');
const CACHE_PATH = join(CACHE_DIR, 'pricing-cache.json');
const DEFAULT_CACHE_TTL_HOURS = 24;
const FETCH_TIMEOUT_MS = 5000;

const NPM_CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/@aiusage/cli@latest/pricing-catalog.json',
  'https://unpkg.com/@aiusage/cli@latest/pricing-catalog.json',
  'https://cdn.jsdelivr.net/npm/@aiusage/pricing@latest/catalog.json',
  'https://unpkg.com/@aiusage/pricing@latest/catalog.json',
];

export type PricingSource = 'remote' | 'cache' | 'bundled';

export interface PricingInfo {
  source: PricingSource;
  version: string;
  url?: string;
  fetchedAt?: string;
}

export interface ResolvedPricingCatalog {
  catalog: PricingCatalog;
  info: PricingInfo;
}

interface PricingCacheFile {
  fetchedAt: string;
  sourceUrl: string;
  catalog: PricingCatalog;
}

export function getPricingCachePath(): string {
  return CACHE_PATH;
}

export async function resolvePricingCatalog(
  config: AIUsageConfig,
  options: {
    forceRefresh?: boolean;
    explicitUrl?: string;
    target?: SyncTarget;
  } = {},
): Promise<ResolvedPricingCatalog> {
  const mode = config.pricing?.mode ?? 'auto';
  const cache = await readPricingCache();
  const ttlHours = config.pricing?.cacheTtlHours ?? DEFAULT_CACHE_TTL_HOURS;

  if (!options.forceRefresh && cache && (mode === 'manual' || mode === 'offline' || isCacheFresh(cache, ttlHours))) {
    return fromCache(cache);
  }

  if ((mode !== 'offline' || options.forceRefresh) && (mode === 'auto' || options.forceRefresh)) {
    const candidates = getPricingUrls(config, options);
    for (const url of candidates) {
      try {
        const catalog = await fetchPricingCatalog(url);
        const fetchedAt = new Date().toISOString();
        await writePricingCache({ fetchedAt, sourceUrl: url, catalog });
        return {
          catalog,
          info: { source: 'remote', version: catalog.version, url, fetchedAt },
        };
      } catch {
        // Try the next source; report/sync must not fail just because pricing refresh failed.
      }
    }
  }

  if (cache) return fromCache(cache);

  return {
    catalog: bundledCatalog,
    info: { source: 'bundled', version: bundledCatalog.version },
  };
}

export async function getPricingStatus(config: AIUsageConfig): Promise<{
  mode: 'auto' | 'manual' | 'offline';
  configuredUrl?: string;
  cachePath: string;
  cache?: {
    version: string;
    sourceUrl: string;
    fetchedAt: string;
  };
  bundled: {
    version: string;
  };
}> {
  const cache = await readPricingCache();
  return {
    mode: config.pricing?.mode ?? 'auto',
    configuredUrl: config.pricing?.url,
    cachePath: CACHE_PATH,
    cache: cache
      ? {
          version: cache.catalog.version,
          sourceUrl: cache.sourceUrl,
          fetchedAt: cache.fetchedAt,
        }
      : undefined,
    bundled: {
      version: bundledCatalog.version,
    },
  };
}

function getPricingUrls(
  config: AIUsageConfig,
  options: {
    explicitUrl?: string;
    target?: SyncTarget;
  },
): string[] {
  const urls = [
    options.explicitUrl,
    config.pricing?.url,
    options.target?.apiBaseUrl ? `${options.target.apiBaseUrl}/api/v1/public/pricing` : undefined,
    ...NPM_CDN_URLS,
  ].filter((url): url is string => Boolean(url));

  return [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
}

function isCacheFresh(cache: PricingCacheFile, ttlHours: number): boolean {
  const fetched = new Date(cache.fetchedAt).getTime();
  if (!Number.isFinite(fetched)) return false;
  return Date.now() - fetched < ttlHours * 60 * 60 * 1000;
}

function fromCache(cache: PricingCacheFile): ResolvedPricingCatalog {
  return {
    catalog: cache.catalog,
    info: {
      source: 'cache',
      version: cache.catalog.version,
      url: cache.sourceUrl,
      fetchedAt: cache.fetchedAt,
    },
  };
}

async function readPricingCache(): Promise<PricingCacheFile | null> {
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8');
    const cache = JSON.parse(raw) as PricingCacheFile;
    assertPricingCatalog(cache.catalog);
    if (!cache.fetchedAt || !cache.sourceUrl) return null;
    return cache;
  } catch {
    return null;
  }
}

async function writePricingCache(cache: PricingCacheFile): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8');
}

async function fetchPricingCatalog(url: string): Promise<PricingCatalog> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`pricing fetch failed: ${response.status}`);
  const data = await response.json();
  assertPricingCatalog(data);
  return data;
}

export function assertPricingCatalog(value: unknown): asserts value is PricingCatalog {
  const catalog = value as PricingCatalog | undefined;
  if (!catalog || typeof catalog !== 'object') throw new Error('invalid pricing catalog');
  if (!catalog.version || typeof catalog.version !== 'string') throw new Error('invalid pricing catalog version');
  if (!catalog.providers || typeof catalog.providers !== 'object') throw new Error('invalid pricing catalog providers');
  if (!catalog.providers.openai?.codex?.models) throw new Error('invalid OpenAI pricing catalog');

  // 形状校验：旧版目录（Worker 尚未升级时）用的是 `*_per_million_usd` 且没有 `fx`，
  // 与当前计价器不兼容。必须在这里拒绝，否则会算出 0/NaN 成本或直接抛错，
  // 让调用方回退到内置目录 / npm CDN。
  const models = catalog.providers.openai.codex.models as unknown as Record<string, Record<string, unknown>>;
  const sample = Object.values(models)[0];
  if (!sample || typeof sample !== 'object') throw new Error('invalid pricing catalog models');
  if (typeof sample.input_per_million !== 'number') {
    throw new Error('incompatible pricing catalog: expected input_per_million (legacy *_per_million_usd catalog?)');
  }
  if (!catalog.fx || typeof catalog.fx !== 'object') {
    throw new Error('incompatible pricing catalog: missing fx table');
  }
  // calculateCost 会直接取 catalog.aliases[model]，缺这个字段会在首次计价时崩溃，
  // 而不是回退到下一个来源。
  if (!catalog.aliases || typeof catalog.aliases !== 'object') {
    throw new Error('incompatible pricing catalog: missing aliases map');
  }
}
