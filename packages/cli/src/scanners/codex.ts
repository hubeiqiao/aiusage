import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { calculateCost, type IngestBreakdown } from '@aiusage/shared';
import { fileModifiedTs, normalizeModelName, runWithConcurrency, resolveProjectFields, type ProjectFields } from './utils.js';

const FILE_CONCURRENCY = 16;
const MAX_LINE_BYTES = 64 * 1024 * 1024; // 64 MB
type CodexServiceTier = 'fast' | 'priority' | null;

// 回放/归档转储识别阈值：Codex 重放一个会话时会把大量 token_count 事件
// 以近乎同一时刻写入同一文件，若照常计数会导致重复计费。
const REPLAY_SCAN_MIN_FILE_BYTES = 1024 * 1024;
const REPLAY_MIN_TOKEN_EVENTS = 200;
const REPLAY_MAX_SPAN_MS = 60_000;

/** 默认扫描的 Codex 数据目录（相对 home），覆盖标准 Codex 及 ninerouter 客户端。 */
const DEFAULT_CODEX_DIRNAMES = ['.codex', '.codex-kiro'];

function resolveCodexDirs(codexDir?: string): string[] {
  if (codexDir) return [codexDir];
  const home = homedir();
  return DEFAULT_CODEX_DIRNAMES.map(name => join(home, name));
}

interface CodexModelMeta {
  provider: string;
  product: string;
  model: string;
}

/**
 * 解析 Codex turn_context 中的模型名。
 * 部分客户端（如 .codex-kiro）通过 ninerouter 路由第三方模型，
 * 形如 `kr/claude-opus-4.8`，需按真实 provider 归类并归一化模型名。
 */
function resolveCodexModelMeta(rawModel: string): CodexModelMeta {
  const stripped = rawModel.includes('/') ? rawModel.slice(rawModel.lastIndexOf('/') + 1) : rawModel;
  const lower = stripped.toLowerCase();

  if (lower.startsWith('claude')) {
    const model = lower.replace(/\./g, '-').replace(/-\d{8}$/, '');
    return { provider: 'anthropic', product: 'codex', model };
  }

  return { provider: 'openai', product: 'codex', model: normalizeModelName(rawModel) };
}

interface CodexRecord {
  type?: string;
  timestamp?: string;
  payload?: CodexPayload;
}

interface CodexPayload {
  type?: string;
  model?: string;
  model_name?: string;
  model_info?: { slug?: string };
  cwd?: string;
  id?: string;
  forked_from_id?: string;
  source?: unknown;
  thread_source?: string;
  turn_id?: string;
  started_at?: number;
  info?: {
    model?: string;
    model_name?: string;
    last_token_usage?: TokenUsage;
    total_token_usage?: TokenUsage;
  };
}

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexTotals {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

interface CodexFileState {
  currentModel: string;
  projectFields: ProjectFields;
  hasSessionWorkspace: boolean;
  previousTotals?: CodexTotals;
  sessionIdFromMeta?: string;
  sessionForkedFromId?: string;
  forkedChildSessionId?: string;
  forkedChildReplaySessionId?: string;
  waitingForChildTurn: boolean;
  inheritedBaseline?: CodexTotals;
  inheritedReportedTotal?: number;
  taskStartedTurnIds: Set<string>;
  childIsUserFork: boolean;
  currentProvider: string;
  currentProduct: string;
}

interface CodexUsageEvent {
  usageDate: string;
  signature: string;
  model: string;
  provider: string;
  product: string;
  projectFields: ProjectFields;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  costUSD?: number;
  pricingVersion?: string;
}

export async function scanCodex(
  targetDate: string,
  codexDir?: string,
  projectAliases?: Record<string, string>,
): Promise<IngestBreakdown[]> {
  const groupedByDate = await scanCodexDates([targetDate], codexDir, projectAliases);
  return groupedByDate.get(targetDate) ?? [];
}

export async function scanCodexDates(
  targetDates: string[],
  codexDir?: string,
  projectAliases?: Record<string, string>,
): Promise<Map<string, IngestBreakdown[]>> {
  const targetDateSet = new Set(targetDates);
  const groupedByDate = new Map<string, Map<string, IngestBreakdown>>();
  for (const targetDate of targetDateSet) groupedByDate.set(targetDate, new Map());

  // 同时扫描标准 Codex 与 ninerouter 客户端目录（.codex-kiro）。
  // service tier 是每个目录各自的配置，需按文件记住来源目录的档位。
  const sessionFiles: string[] = [];
  const tierByFile: CodexServiceTier[] = [];
  for (const baseDir of resolveCodexDirs(codexDir)) {
    const serviceTier = await detectCodexServiceTier(baseDir);
    for (const filePath of await collectSessionFiles(baseDir)) {
      sessionFiles.push(filePath);
      tierByFile.push(serviceTier);
    }
  }
  if (sessionFiles.length === 0) {
    return new Map([...targetDateSet].map((targetDate) => [targetDate, []]));
  }

  // 文件并发解析、按稳定路径顺序合并：既保留扫描速度，也让 fork 重放的
  // first-wins 归属不受异步完成顺序影响。
  const eventsByFile: CodexUsageEvent[][] = Array.from({ length: sessionFiles.length }, () => []);
  await runWithConcurrency(sessionFiles, FILE_CONCURRENCY, async (filePath, index) => {
    eventsByFile[index] = await processCodexFile(filePath, projectAliases, tierByFile[index]);
  });

  // 跨文件去重，但 key 必须带 session/fork scope；纯 token 数值全局去重会误杀独立会话。
  const globalSeenSigs = new Set<string>();
  for (const events of eventsByFile) {
    for (const event of events) {
      if (globalSeenSigs.has(event.signature)) continue;
      globalSeenSigs.add(event.signature);
      if (!targetDateSet.has(event.usageDate)) continue;
      mergeCodexEvent(groupedByDate, event);
    }
  }

  return new Map(
    [...groupedByDate.entries()].map(([usageDate, grouped]) => [usageDate, [...grouped.values()]]),
  );
}

/** 流式逐行读取单个 Codex JSONL 文件 */
/**
 * 判断文件是否是「回放转储」：同一文件里出现大量 token_count 事件，
 * 且时间跨度极短（Codex 重放会话时的特征）。这类文件的事件是历史副本，
 * 计入会造成重复计费。归档目录下的文件不设体积门槛。
 */
async function isReplayDump(filePath: string): Promise<boolean> {
  const isArchived = filePath.includes(`${sep}archived_sessions${sep}`);
  if (!isArchived) {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size < REPLAY_SCAN_MIN_FILE_BYTES) return false;
    } catch {
      return false;
    }
  }

  const input = createReadStream(filePath, { encoding: 'utf-8' });
  try {
    const rl = createInterface({ input, crlfDelay: Infinity });
    let tokenEvents = 0;
    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = 0;

    for await (const line of rl) {
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) continue;

      let record: CodexRecord;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      if (record.type !== 'event_msg') continue;
      if (record.payload?.type !== 'token_count') continue;

      const ts = parseTimestamp(record.timestamp)?.getTime();
      if (!ts) continue;

      tokenEvents += 1;
      minTime = Math.min(minTime, ts);
      maxTime = Math.max(maxTime, ts);

      // 已经确定跨度够长 → 正常会话，无需继续读。
      if (tokenEvents >= REPLAY_MIN_TOKEN_EVENTS && maxTime - minTime > REPLAY_MAX_SPAN_MS) {
        return false;
      }
    }

    return tokenEvents >= REPLAY_MIN_TOKEN_EVENTS && maxTime - minTime <= REPLAY_MAX_SPAN_MS;
  } catch {
    return false;
  } finally {
    input.destroy();
  }
}

async function processCodexFile(
  filePath: string,
  projectAliases: Record<string, string> | undefined,
  serviceTier: CodexServiceTier,
): Promise<CodexUsageEvent[]> {
  const events: CodexUsageEvent[] = [];
  // 回放/归档转储会把整段历史以近乎同一时刻重写一遍，跳过以免重复计费。
  if (await isReplayDump(filePath)) return events;
  const input = createReadStream(filePath, { encoding: 'utf-8' });
  try {
    const rl = createInterface({
      input,
      crlfDelay: Infinity,
    });

    const fileSessionId = basename(filePath, '.jsonl');
    const fallbackTs = await fileModifiedTs(filePath);
    const state: CodexFileState = {
      currentModel: 'unknown',
      currentProvider: 'openai',
      currentProduct: 'codex',
      projectFields: { project: 'unknown', projectDisplay: 'unknown' },
      hasSessionWorkspace: false,
      waitingForChildTurn: false,
      taskStartedTurnIds: new Set(),
      childIsUserFork: false,
    };

    for await (const line of rl) {
      if (!line) continue;

      // 大行保护
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) continue;

      let record: CodexRecord;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const payload = record.payload;
      if (!payload) continue;
      const payloadModel = extractCodexModel(payload);
      const isTokenCount = record.type === 'event_msg' && payload.type === 'token_count';

      // 子会话文件会先复制父会话历史。保持 child 的 workspace/session 状态，
      // 直到能确定自己的 turn_context，再开始计数。
      if (state.waitingForChildTurn) {
        if (record.type === 'turn_context' && childTurnStartsOwnSession(state, payload.turn_id)) {
          state.waitingForChildTurn = false;
          state.forkedChildReplaySessionId = undefined;
          state.taskStartedTurnIds.clear();
          state.childIsUserFork = false;
          state.sessionIdFromMeta = state.forkedChildSessionId ?? state.sessionIdFromMeta;
        } else {
          if (record.type === 'event_msg' && payload.type === 'task_started'
            && childTaskStartsOwnSession(state, payload.turn_id, payload.started_at)) {
            if (payload.turn_id) state.taskStartedTurnIds.add(payload.turn_id);
          }
          if (record.type === 'session_meta' && payload.id
            && payload.id !== state.forkedChildSessionId) {
            state.forkedChildReplaySessionId = payload.id;
          }
          if (isTokenCount) rememberInheritedBaseline(state, payload.info);
          continue;
        }
      }

      if (record.type === 'session_meta') {
        const sessionId = payload.id?.trim();
        if (sessionId) state.sessionIdFromMeta = sessionId;
        const forkParent = payload.forked_from_id?.trim() ?? forkParentFromSource(payload.source);
        if (forkParent) {
          const repeatedActiveChild = !state.waitingForChildTurn
            && Boolean(sessionId)
            && state.forkedChildSessionId === sessionId;
          state.sessionForkedFromId = forkParent;
          state.forkedChildSessionId = sessionId;
          if (!repeatedActiveChild) {
            state.waitingForChildTurn = true;
            state.forkedChildReplaySessionId = undefined;
            state.inheritedBaseline = undefined;
            state.inheritedReportedTotal = undefined;
            state.taskStartedTurnIds.clear();
            state.childIsUserFork = payload.thread_source === 'user';
          }
        }
        if (payload.cwd) {
          state.projectFields = resolveProjectFields(payload.cwd, projectAliases);
          state.hasSessionWorkspace = true;
        }
        continue;
      }

      if (record.type === 'turn_context') {
        if (payloadModel && payloadModel !== '<synthetic>') {
          applyCodexModel(state, payloadModel, serviceTier);
        }
        if (payload.cwd && !state.hasSessionWorkspace) {
          state.projectFields = resolveProjectFields(payload.cwd, projectAliases);
        }
        continue;
      }

      if (!isTokenCount) continue;
      const info = payload.info;
      if (!info?.total_token_usage && !info?.last_token_usage) continue;

      if (payloadModel && payloadModel !== '<synthetic>') {
        applyCodexModel(state, payloadModel, serviceTier);
      }
      const ts = parseTimestamp(record.timestamp) ?? fallbackTs;
      if (!ts) continue;
      const usageDate = toDateKey(ts);

      const total = info.total_token_usage ? totalsFromUsage(info.total_token_usage) : undefined;
      const last = info.last_token_usage ? totalsFromUsage(info.last_token_usage) : undefined;
      if (shouldSkipInheritedSnapshot(state, info.total_token_usage, total)) continue;
      state.inheritedBaseline = undefined;
      state.inheritedReportedTotal = undefined;

      const parsed = resolveCodexIncrement(total, last, state.previousTotals);
      if (!parsed) continue;
      if (!parsed.tokens) {
        state.previousTotals = parsed.nextTotals;
        continue;
      }
      const { tokens, nextTotals } = parsed;
      const cachedInput = Math.min(tokens.cached, tokens.input);
      const nonCachedInput = Math.max(tokens.input - cachedInput, 0);
      const output = tokens.output;
      const reasoning = tokens.reasoning;
      if (nonCachedInput + cachedInput + output + reasoning === 0) continue;
      state.previousTotals = nextTotals;

      const dedupScope = state.sessionForkedFromId
        ?? state.sessionIdFromMeta
        ?? fileSessionId;
      const signature = total
        ? `codex|${dedupScope}|${state.currentModel}|${total.input}|${total.cached}|${total.output}|${total.reasoning}`
        : `codex|${dedupScope}|${state.currentModel}|${ts.getTime()}|${tokens.input}|${tokens.cached}|${tokens.output}|${tokens.reasoning}`;

      // ninerouter 路由的 Anthropic 模型要按 anthropic/claude-code 查表：
      // 目录里没有 anthropic/codex 这个组合，写死 openai 会导致这些事件
      // 拿不到 costUSD，本地报告只能显示 $0 并给出「未配置单价」警告。
      const costProduct = state.currentProvider === 'anthropic' ? 'claude-code' : state.currentProduct;
      const eventCost = calculateCost(state.currentProvider, costProduct, state.currentModel, {
        inputTokens: nonCachedInput,
        cachedInputTokens: cachedInput,
        cacheWriteTokens: 0,
        outputTokens: output,
      });
      const exactEventCost = eventCost.costStatus === 'exact' ? eventCost.estimatedCostUsd : undefined;
      events.push({
        usageDate,
        signature,
        model: state.currentModel,
        provider: state.currentProvider,
        product: state.currentProduct,
        projectFields: { ...state.projectFields },
        inputTokens: nonCachedInput,
        cachedInputTokens: cachedInput,
        outputTokens: output,
        reasoningOutputTokens: reasoning,
        costUSD: exactEventCost,
        pricingVersion: exactEventCost !== undefined ? eventCost.pricingVersion : undefined,
      });
    }
  } catch {
    // 文件在扫描期间被移动、归档或损坏时跳过该文件。
  } finally {
    input.destroy();
  }
  return events;
}

function mergeCodexEvent(
  groupedByDate: Map<string, Map<string, IngestBreakdown>>,
  event: CodexUsageEvent,
): void {
  const grouped = groupedByDate.get(event.usageDate);
  if (!grouped) return;
  const key = `${event.provider}|${event.product}|${event.model}|${event.projectFields.project}`;
  const existing = grouped.get(key);
  if (existing) {
    existing.eventCount += 1;
    existing.inputTokens += event.inputTokens;
    existing.cachedInputTokens += event.cachedInputTokens;
    existing.outputTokens += event.outputTokens;
    existing.reasoningOutputTokens += event.reasoningOutputTokens;
    if (event.costUSD !== undefined) {
      existing.costUSD = (existing.costUSD ?? 0) + event.costUSD;
      existing.pricingVersion = event.pricingVersion;
    }
    return;
  }

  const breakdown: IngestBreakdown = {
    provider: event.provider,
    product: event.product,
    channel: 'cli',
    model: event.model,
    project: event.projectFields.project,
    projectDisplay: event.projectFields.projectDisplay,
    projectAlias: event.projectFields.projectAlias,
    eventCount: 1,
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens,
    cacheWriteTokens: 0,
    outputTokens: event.outputTokens,
    reasoningOutputTokens: event.reasoningOutputTokens,
  };
  if (event.costUSD !== undefined) {
    breakdown.costUSD = event.costUSD;
    breakdown.pricingVersion = event.pricingVersion;
  }
  grouped.set(key, breakdown);
}

function forkParentFromSource(source: unknown): string | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const subagent = (source as Record<string, unknown>).subagent;
  if (!subagent || typeof subagent !== 'object' || Array.isArray(subagent)) return undefined;
  const spawn = (subagent as Record<string, unknown>).thread_spawn;
  if (!spawn || typeof spawn !== 'object' || Array.isArray(spawn)) return undefined;
  const parent = (spawn as Record<string, unknown>).parent_thread_id;
  return typeof parent === 'string' && parent.trim() ? parent.trim() : undefined;
}

function clampToken(value: number | undefined): number {
  return Math.max(Number.isFinite(value) ? value! : 0, 0);
}

function extractCodexModel(payload: CodexPayload): string | undefined {
  return payload.model
    ?? payload.model_name
    ?? payload.model_info?.slug
    ?? payload.info?.model
    ?? payload.info?.model_name;
}

function totalsFromUsage(usage: TokenUsage): CodexTotals {
  return {
    input: clampToken(usage.input_tokens),
    cached: Math.max(
      clampToken(usage.cached_input_tokens),
      clampToken(usage.cache_read_input_tokens),
    ),
    output: clampToken(usage.output_tokens),
    reasoning: clampToken(usage.reasoning_output_tokens),
  };
}

function totalsEqual(a: CodexTotals, b: CodexTotals): boolean {
  return a.input === b.input
    && a.cached === b.cached
    && a.output === b.output
    && a.reasoning === b.reasoning;
}

function totalsDelta(current: CodexTotals, previous: CodexTotals): CodexTotals | undefined {
  if (current.input < previous.input || current.cached < previous.cached
    || current.output < previous.output || current.reasoning < previous.reasoning) return undefined;
  return {
    input: current.input - previous.input,
    cached: current.cached - previous.cached,
    output: current.output - previous.output,
    reasoning: current.reasoning - previous.reasoning,
  };
}

function totalsAdd(a: CodexTotals, b: CodexTotals): CodexTotals {
  return {
    input: a.input + b.input,
    cached: a.cached + b.cached,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}

function totalsSum(value: CodexTotals): number {
  return value.input + value.cached + value.output + value.reasoning;
}

function looksLikeStaleRegression(current: CodexTotals, previous: CodexTotals, last: CodexTotals): boolean {
  const previousSum = totalsSum(previous);
  const currentSum = totalsSum(current);
  const lastSum = totalsSum(last);
  if (previousSum <= 0 || currentSum <= 0 || lastSum <= 0) return false;
  return currentSum * 100 >= previousSum * 98 || currentSum + lastSum * 2 >= previousSum;
}

function resolveCodexIncrement(
  total: CodexTotals | undefined,
  last: CodexTotals | undefined,
  previous: CodexTotals | undefined,
): { tokens?: CodexTotals; nextTotals?: CodexTotals } | undefined {
  if (total && last && previous) {
    if (totalsEqual(total, previous)) return undefined;
    if (!totalsDelta(total, previous) && looksLikeStaleRegression(total, previous, last)) return undefined;
    return { tokens: last, nextTotals: total };
  }
  if (total && last) return { tokens: last, nextTotals: total };
  if (total && previous) {
    if (totalsEqual(total, previous)) return undefined;
    const delta = totalsDelta(total, previous);
    return delta ? { tokens: delta, nextTotals: total } : { nextTotals: total };
  }
  if (total) return { tokens: total, nextTotals: total };
  if (last && previous) return { tokens: last, nextTotals: totalsAdd(previous, last) };
  if (last) return { tokens: last };
  return undefined;
}

function rememberInheritedBaseline(
  state: CodexFileState,
  info: CodexPayload['info'],
): void {
  const usage = info?.total_token_usage;
  if (!usage) return;
  const totals = totalsFromUsage(usage);
  state.previousTotals = totals;
  state.inheritedBaseline = totals;
  state.inheritedReportedTotal = reportedTotalTokens(usage);
}

function shouldSkipInheritedSnapshot(
  state: CodexFileState,
  usage: TokenUsage | undefined,
  totals: CodexTotals | undefined,
): boolean {
  const reported = usage ? reportedTotalTokens(usage) : undefined;
  if (reported != null && state.inheritedReportedTotal != null
    && reported <= state.inheritedReportedTotal) return true;
  const baseline = state.inheritedBaseline;
  return Boolean(totals && baseline
    && totals.input <= baseline.input
    && totals.cached <= baseline.cached
    && totals.output <= baseline.output
    && totals.reasoning <= baseline.reasoning);
}

function reportedTotalTokens(usage: TokenUsage): number | undefined {
  return typeof usage.total_tokens === 'number' && usage.total_tokens >= 0
    ? usage.total_tokens
    : undefined;
}

function childTurnStartsOwnSession(state: CodexFileState, turnId: string | undefined): boolean {
  if (!state.forkedChildReplaySessionId) return true;
  const childId = state.forkedChildSessionId;
  if (!childId) return true;
  const childKey = uuidV7OrderKey(childId);
  if (!turnId || !childKey) return true;
  const turnKey = uuidV7OrderKey(turnId);
  if (!turnKey) return state.childIsUserFork || state.taskStartedTurnIds.has(turnId);
  const turnMs = turnKey.slice(0, 12);
  const childMs = childKey.slice(0, 12);
  if (turnMs > childMs) return true;
  if (turnMs < childMs) return false;
  return state.childIsUserFork || state.taskStartedTurnIds.has(turnId);
}

function childTaskStartsOwnSession(
  state: CodexFileState,
  turnId: string | undefined,
  startedAt: number | undefined,
): boolean {
  const childId = state.forkedChildSessionId;
  if (!turnId || !childId) return false;
  const childKey = uuidV7OrderKey(childId);
  if (!childKey) return true;
  const turnKey = uuidV7OrderKey(turnId);
  if (turnKey) return turnKey.slice(0, 12) >= childKey.slice(0, 12);
  const childStartedMs = Number.parseInt(childKey.slice(0, 12), 16);
  return Number.isFinite(startedAt) && startedAt! >= Math.floor(childStartedMs / 1_000);
}

function uuidV7OrderKey(id: string): string | undefined {
  const parts = id.split('-');
  if (parts.length !== 5 || parts[0]?.length !== 8 || parts[1]?.length !== 4
    || parts[2]?.length !== 4 || parts[3]?.length !== 4 || parts[4]?.length !== 12
    || !parts[2]?.startsWith('7') || !parts.every(part => /^[0-9a-f]+$/i.test(part))) return undefined;
  return parts.join('').toLowerCase();
}

async function collectSessionFiles(baseDir: string): Promise<string[]> {
  // 与 Codex 本身的生命周期一致：活动会话优先，归档副本随后；各目录
  // 内按路径排序，确保重复事件的 workspace 归属稳定。
  const activePaths: string[] = [];
  const sessionsDir = join(baseDir, 'sessions');
  await walkDir(sessionsDir, activePaths);
  activePaths.sort();

  const archivedPaths: string[] = [];
  await walkDir(join(baseDir, 'archived_sessions'), archivedPaths);
  archivedPaths.sort();

  return [...activePaths, ...archivedPaths];
}

async function detectCodexServiceTier(baseDir: string): Promise<CodexServiceTier> {
  let config = '';
  try {
    config = await readFile(join(baseDir, 'config.toml'), 'utf-8');
  } catch {
    return null;
  }

  const serviceTier = config.match(/^\s*service_tier\s*=\s*["']([^"']+)["']/m)?.[1]?.trim().toLowerCase();
  if (serviceTier === 'priority') return 'priority';
  if (serviceTier === 'fast') return 'fast';

  const fastMode = config.match(/^\s*fast_mode\s*=\s*(true|false)\s*$/m)?.[1];
  return fastMode === 'true' ? 'fast' : null;
}

/**
 * ninerouter 会把 Anthropic 模型路由到 Codex 客户端下（如 `kr/claude-opus-4.8`）。
 * 这类事件要按 anthropic 归类，且不适用 OpenAI 的 fast/priority 档位后缀。
 */
function applyCodexModel(state: CodexFileState, rawModel: string, serviceTier: CodexServiceTier): void {
  const meta = resolveCodexModelMeta(rawModel);
  state.currentProvider = meta.provider;
  state.currentProduct = meta.product;
  state.currentModel = meta.provider === 'openai'
    ? applyCodexServiceTier(meta.model, serviceTier)
    : meta.model;
}

function applyCodexServiceTier(model: string, serviceTier: CodexServiceTier): string {
  if (!serviceTier) return model;
  if (model.endsWith('-fast') || model.endsWith('-priority')) return model;
  const supportsFast = model === 'gpt-5.5' || model === 'gpt-5.4';
  const supportsPriority =
    model === 'gpt-5.6' ||
    model === 'gpt-5.6-sol' ||
    model === 'gpt-5.6-terra' ||
    model === 'gpt-5.6-luna' ||
    supportsFast;
  if ((serviceTier === 'fast' && supportsFast) || (serviceTier === 'priority' && supportsPriority)) {
    return `${model}-${serviceTier}`;
  }
  return model;
}

async function walkDir(dir: string, result: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, result);
    } else if (entry.name.endsWith('.jsonl')) {
      result.push(fullPath);
    }
  }
}

function parseTimestamp(value?: string): Date | null {
  if (!value) return null;
  try {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
