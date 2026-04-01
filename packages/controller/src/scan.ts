import { scanClaudeDates } from './scanners/claude.js';
import { scanCodexDates } from './scanners/codex.js';
import type { IngestBreakdown } from '@aiusage/shared';

export interface ScanResult {
  usageDate: string;
  breakdowns: IngestBreakdown[];
  totals: {
    eventCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  };
}

interface ScanOptions {
  projectAliases?: Record<string, string>;
}

export async function scanDate(targetDate: string, options: ScanOptions = {}): Promise<ScanResult> {
  const [result] = await scanDates([targetDate], options);
  return result ?? {
    usageDate: targetDate,
    breakdowns: [],
    totals: createEmptyTotals(),
  };
}

export async function scanDates(targetDates: string[], options: ScanOptions = {}): Promise<ScanResult[]> {
  const uniqueDates = [...new Set(targetDates)];
  if (uniqueDates.length === 0) return [];

  const [claudeByDate, codexByDate] = await Promise.all([
    scanClaudeDates(uniqueDates, undefined, options.projectAliases),
    scanCodexDates(uniqueDates, undefined, options.projectAliases),
  ]);

  return uniqueDates.map((usageDate) => {
    const breakdowns = [...(claudeByDate.get(usageDate) ?? []), ...(codexByDate.get(usageDate) ?? [])];
    const totals = breakdowns.reduce(
      (acc, b) => ({
        eventCount: acc.eventCount + b.eventCount,
        inputTokens: acc.inputTokens + b.inputTokens,
        cachedInputTokens: acc.cachedInputTokens + b.cachedInputTokens,
        cacheWriteTokens: acc.cacheWriteTokens + b.cacheWriteTokens,
        outputTokens: acc.outputTokens + b.outputTokens,
        reasoningOutputTokens: acc.reasoningOutputTokens + b.reasoningOutputTokens,
      }),
      createEmptyTotals(),
    );

    return { usageDate, breakdowns, totals };
  });
}

function createEmptyTotals(): ScanResult['totals'] {
  return {
    eventCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}
