import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IngestBreakdown } from '@aiusage/shared';
import {
  dateKey,
  parseTs,
  walkFiles,
  initDateMap,
  accumulate,
  finalize,
  emptyResult,
} from './utils.js';

/**
 * Kiro scanner.
 *
 * 数据目录:
 * - ~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/*.chat
 * - ~/.kiro/sessions/cli/*.json
 */

interface KiroMetadata {
  modelId?: string;
  modelProvider?: string;
  startTime?: string | number;
  endTime?: string | number;
}

interface KiroModelInfo {
  model_name?: string;
  model_id?: string;
}

interface KiroSessionState {
  rts_model_state?: {
    model_info?: KiroModelInfo;
  };
}

interface KiroSessionRecord {
  session_id?: string;
  created_at?: string | number;
  updated_at?: string | number;
  session_state?: KiroSessionState;
  metadata?: KiroMetadata;
}

interface KiroChatRecord {
  actionId?: string;
  executionId?: string;
  metadata?: KiroMetadata;
  chat?: unknown[];
}

type KiroRecord = KiroChatRecord | KiroSessionRecord;

export async function scanKiroDates(
  targetDates: string[],
  baseDir?: string,
  _projectAliases?: Record<string, string>,
): Promise<Map<string, IngestBreakdown[]>> {
  const targetDateSet = new Set(targetDates);
  const dirs = resolveKiroDirs(baseDir);

  const files = (
    await Promise.all(
      dirs.flatMap((dir) => [walkFiles(dir, '.chat'), walkFiles(dir, '.json')]),
    )
  ).flat();

  if (files.length === 0) return emptyResult(targetDateSet);

  const groupedByDate = initDateMap(targetDateSet);
  const seenExecutionIds = new Set<string>();

  for (const filePath of files) {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    let data: KiroRecord;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }

    const dedupeKey = resolveExecutionKey(data, filePath);
    if (seenExecutionIds.has(dedupeKey)) continue;
    seenExecutionIds.add(dedupeKey);

    const eventTs = await getEventDate(data, filePath);
    if (!eventTs) continue;
    const usageDate = dateKey(eventTs);
    const dayMap = groupedByDate.get(usageDate);
    if (!dayMap) continue;

    const model = getModelName(data);
    const project = 'unknown';

    accumulate(
      dayMap,
      `${model}|${project}`,
      {
        provider: 'kiro',
        product: 'kiro',
        channel: 'cli',
        model,
        project,
        projectDisplay: 'unknown',
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    );
  }

  return finalize(groupedByDate);
}

function resolveKiroDirs(baseDir?: string): string[] {
  if (baseDir) return [baseDir];

  const envDir = process.env.KIRO_CHAT_DIR?.trim();
  if (envDir) return [envDir];

  return [
    join(
      homedir(),
      'Library',
      'Application Support',
      'Kiro',
      'User',
      'globalStorage',
      'kiro.kiroagent',
    ),
    join(
      homedir(),
      'Library',
      'Application Support',
      'Code',
      'User',
      'globalStorage',
      'kiro.kiroagent',
    ),
    join(homedir(), '.kiro', 'sessions', 'cli'),
  ];
}

function getModelNameFromData(data: KiroChatRecord | KiroSessionRecord): string {
  let modelId: string | undefined;
  if ('session_state' in data) {
    modelId = (
      data.session_state?.rts_model_state?.model_info?.model_id
      ?? data.session_state?.rts_model_state?.model_info?.model_name
    )?.trim();
  }

  if (modelId) return modelId;
  return getModelNameFromMetadata(data.metadata);
}

function getModelName(data: KiroRecord): string {
  return normalizeModelName(getModelNameFromData(data));
}

function getModelNameFromMetadata(metadata?: KiroMetadata): string {
  return normalizeModelName(
    metadata?.modelId?.trim() || metadata?.modelProvider?.trim() || 'unknown',
  );
}

function normalizeModelName(model: string): string {
  if (!model) return 'unknown';
  const lower = model.toLowerCase().replace(/_/g, '-');
  if (!lower.startsWith('claude-')) return model;

  let normalized = lower;
  normalized = normalized.replace(/\./g, '-');
  normalized = normalized.replace(/-v\d+(?:-\d+)*$/, '');
  normalized = normalized.replace(/-\d{8}$/, '');
  return normalized;
}

function resolveExecutionKey(data: KiroChatRecord | KiroSessionRecord, filePath: string): string {
  const candidate = 'executionId' in data ? data.executionId : undefined;
  const chatKey = typeof candidate === 'string' ? candidate.trim() : '';
  if (chatKey) return chatKey;
  const actionCandidate = 'actionId' in data ? data.actionId : undefined;
  const actionKey = typeof actionCandidate === 'string' ? actionCandidate.trim() : '';
  if (actionKey) return actionKey;
  const sessionKey = 'session_id' in data ? data.session_id : undefined;
  const sessionId = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  if (sessionId) return sessionId;
  return `file:${hashPath(filePath)}`;
}

function getEventDate(data: KiroChatRecord | KiroSessionRecord, filePath: string): Promise<Date | null> {
  const ts = parseTs(
    data.metadata?.startTime
    ?? data.metadata?.endTime
    ?? ('created_at' in data ? data.created_at : undefined)
    ?? ('updated_at' in data ? data.updated_at : undefined),
  );
  if (ts) return Promise.resolve(ts);
  return readFileMtime(filePath);
}

function readFileMtime(filePath: string): Promise<Date | null> {
  return (async () => {
    try {
      return (await stat(filePath)).mtime;
    } catch {
      return null;
    }
  })();
}

function hashPath(filePath: string): string {
  return createHash('sha1').update(filePath).digest('hex');
}
