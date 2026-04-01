// ── 统计维度 ──

export type Provider = 'anthropic' | 'openai';
export type Product = 'claude-code' | 'codex';
export type Channel = 'cli' | 'ide' | 'web' | 'api';
export type CostStatus = 'exact' | 'estimated' | 'unavailable';
export type DeviceStatus = 'active' | 'disabled';
export type ProjectVisibility = 'hidden' | 'masked' | 'plain';

// ── 上报格式 ──

export interface IngestPayload {
  siteId: string;
  schemaVersion: string;
  generatedAt: string;
  device: DeviceInfo;
  days: IngestDay[];
}

export interface DeviceInfo {
  deviceId: string;
  deviceAlias?: string;
  hostname: string;
  timezone: string;
  appVersion: string;
}

export interface IngestDay {
  usageDate: string;
  breakdowns: IngestBreakdown[];
}

export interface IngestBreakdown {
  provider: Provider;
  product: Product;
  channel: Channel;
  model: string;
  project: string;
  eventCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

// ── API 响应 ──

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  code: string;
  message: string;
}

export interface HealthResponse {
  ok: boolean;
  siteId: string;
  service: 'aiusage';
  version: string;
  time: string;
}

export interface EnrollResponse {
  siteId: string;
  deviceId: string;
  deviceToken: string;
  issuedAt: string;
}

export interface IngestResponse {
  daysProcessed: number;
  costSummary: Record<string, { estimatedCostUsd: number; costStatus: CostStatus }>;
}

// ── 公开接口 ──

export interface OverviewResponse {
  totalDays: number;
  totalEvents: number;
  totalCostUsd: number;
  dailyTrend: DailyTrendItem[];
}

export interface DailyTrendItem {
  usageDate: string;
  eventCount: number;
  estimatedCostUsd: number;
}

export interface BreakdownItem {
  deviceId: string;
  usageDate: string;
  provider: Provider;
  product: Product;
  channel: Channel;
  model: string;
  project: string;
  eventCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  estimatedCostUsd: number;
  costStatus: CostStatus;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}
