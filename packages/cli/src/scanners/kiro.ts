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
  const modelId = (
    data.session_state?.rts_model_state?.model_info?.model_id
    ?? data.session_state?.rts_model_state?.model_info?.model_name
  )?.trim();
  if (modelId) return modelId;
  return getModelNameFromMetadata(data.metadata);
}

function getModelName(data: KiroRecord): string {
  return getModelNameFromData(data);
}

function getModelNameFromMetadata(metadata?: KiroMetadata): string {
  return metadata?.modelId?.trim() || metadata?.modelProvider?.trim() || 'unknown';
}

function resolveExecutionKey(data: KiroChatRecord | KiroSessionRecord, filePath: string): string {
  const candidate = data.executionId ?? data.actionId;
  const chatKey = typeof candidate === 'string' ? candidate.trim() : '';
  if (chatKey) return chatKey;
  const sessionKey = typeof data.session_id === 'string' ? data.session_id.trim() : '';
  if (sessionKey) return sessionKey;
  return `file:${hashPath(filePath)}`;
}

function getEventDate(data: KiroChatRecord | KiroSessionRecord, filePath: string): Promise<Date | null> {
  const ts = parseTs(
    data.metadata?.startTime
    ?? data.metadata?.endTime
    ?? data.created_at
    ?? data.updated_at,
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
