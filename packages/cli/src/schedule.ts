import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

const LABEL = 'com.aiusage.sync';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_PATH = join(homedir(), '.aiusage', 'sync.log');
const CRON_MARKER = '# aiusage-sync';
const SCHEDULE_LOOKBACK_DAYS = 7;
const SCHEDULE_BATCH_SIZE = 1;
const SCHEDULE_LOCK_PATH = join(homedir(), '.aiusage', 'sync.lock');
export const SCHEDULE_STATE_PATH = join(homedir(), '.aiusage', 'schedule-state.json');

export interface ScheduleStatus {
  enabled: boolean;
  installed?: boolean;
  loaded?: boolean;
  interval?: number;
  intervalLabel?: string;
  path?: string;
  command?: string;
  logPath?: string;
  includeToday?: boolean;
  lookbackDays?: number;
  runAtLoad?: boolean;
}

export function parseInterval(value: string): { seconds: number; label: string } {
  const match = value.match(/^(\d+)(m|h|d)$/);
  if (!match) throw new Error('--every 格式错误，示例: 30m, 1h, 2h, 1d');
  const num = parseInt(match[1], 10);
  const unit = match[2];
  let seconds: number;
  switch (unit) {
    case 'm': seconds = num * 60; break;
    case 'h': seconds = num * 3600; break;
    case 'd': seconds = num * 86400; break;
    default: throw new Error('不支持的时间单位');
  }
  if (seconds < 300) throw new Error('间隔不能少于 5 分钟');
  if (seconds > 86400) throw new Error('间隔不能超过 1 天');
  return { seconds, label: value };
}

export function formatInterval(seconds: number): string {
  if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export async function enableSchedule(intervalSeconds: number): Promise<ScheduleStatus> {
  return platform() === 'darwin'
    ? enableLaunchd(intervalSeconds)
    : enableCron(intervalSeconds);
}

export async function disableSchedule(): Promise<void> {
  return platform() === 'darwin' ? disableLaunchd() : disableCron();
}

export async function getScheduleStatus(): Promise<ScheduleStatus> {
  return platform() === 'darwin' ? getLaunchdStatus() : getCronStatus();
}

// ── resolve paths ──

export function resolveCommandPaths(): { nodePath: string; scriptPath: string } {
  const entryPath = process.argv[1];
  if (!entryPath) throw new Error('无法解析当前 aiusage 命令路径');
  const scriptPath = realpathSync(resolve(entryPath));
  if (scriptPath.includes('_npx') || scriptPath.includes('/npx-')) {
    throw new Error(
      '检测到通过 npx 运行，定时任务需要全局安装。\n请先执行: npm install -g @aiusage/cli',
    );
  }
  return { nodePath: resolveStableNodePath(process.execPath), scriptPath };
}

export function resolveStableNodePath(
  execPath: string,
  candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node'],
): string {
  let resolvedExec: string;
  try { resolvedExec = realpathSync(execPath); } catch { return execPath; }
  for (const candidate of candidates) {
    try {
      if (realpathSync(candidate) === resolvedExec) return candidate;
    } catch { /* candidate is not installed */ }
  }
  return execPath;
}

// ── macOS launchd ──

async function enableLaunchd(intervalSeconds: number): Promise<ScheduleStatus> {
  const { nodePath, scriptPath } = resolveCommandPaths();
  await mkdir(join(homedir(), '.aiusage'), { recursive: true });

  const plist = buildLaunchdPlist(nodePath, scriptPath, intervalSeconds);
  const domain = launchdDomain();
  const commands = buildLaunchdRegistrationCommands(domain, PLIST_PATH);

  const wasLoaded = await isLaunchdLoaded();
  const expectedArgs = scheduledArguments(nodePath, scriptPath);
  await replaceLaunchdPlist(PLIST_PATH, plist, wasLoaded, {
    validate: async path => { await execFileAsync('plutil', ['-lint', path]); },
    bootout: async () => {
      try { await execFileAsync('launchctl', commands.bootout); }
      catch (error) {
        if (!launchctlServiceNotFound(error)) throw error;
      }
    },
    bootstrap: async () => { await retryLaunchctlBootstrap(commands.bootstrap); },
    verify: async () => {
      const { stdout } = await execFileAsync('launchctl', ['print', `${domain}/${LABEL}`]);
      if (!launchdOutputHasArguments(stdout, expectedArgs)) {
        throw new Error('launchd 已加载，但运行参数与新配置不一致');
      }
    },
  });

  return {
    enabled: true,
    installed: true,
    loaded: true,
    interval: intervalSeconds,
    intervalLabel: formatInterval(intervalSeconds),
    path: PLIST_PATH,
    includeToday: true,
    lookbackDays: SCHEDULE_LOOKBACK_DAYS,
    runAtLoad: true,
  };
}

export function buildLaunchdRegistrationCommands(domain: string, plistPath: string): {
  bootout: string[];
  bootstrap: string[];
} {
  return {
    bootout: ['bootout', `${domain}/${LABEL}`],
    bootstrap: ['bootstrap', domain, plistPath],
  };
}

export async function retryLaunchctlBootstrap(
  args: string[],
  run: (args: string[]) => Promise<void> = async launchctlArgs => {
    await execFileAsync('launchctl', launchctlArgs);
  },
  wait: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds)),
): Promise<void> {
  const delays = [250, 500];
  for (let attempt = 0; ; attempt++) {
    try {
      await run(args);
      return;
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined) throw error;
      await wait(delay);
    }
  }
}

export function buildLaunchdPlist(nodePath: string, scriptPath: string, intervalSeconds: number): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...scheduledArguments(nodePath, scriptPath).map(arg => `    <string>${escapeXml(arg)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    `  <!-- AIUsageIntervalSeconds: ${intervalSeconds} -->`,
    ...renderLaunchdTrigger(intervalSeconds),
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(LOG_PATH)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(LOG_PATH)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

interface LaunchdReplaceOperations {
  validate: (path: string) => Promise<void>;
  bootout: () => Promise<void>;
  bootstrap: () => Promise<void>;
  verify: () => Promise<void>;
}

export async function replaceLaunchdPlist(
  plistPath: string,
  content: string,
  wasLoaded: boolean,
  operations: LaunchdReplaceOperations,
): Promise<void> {
  const stagedPath = `${plistPath}.new-${process.pid}-${Date.now()}`;
  let previous: string | undefined;
  try { previous = await readFile(plistPath, 'utf-8'); } catch { /* first install */ }

  await writeFile(stagedPath, content, 'utf-8');
  let bootedOut = false;
  let installedNew = false;
  try {
    await operations.validate(stagedPath);
    if (wasLoaded) {
      await operations.bootout();
      bootedOut = true;
    }
    await rename(stagedPath, plistPath);
    installedNew = true;
    await operations.bootstrap();
    await operations.verify();
  } catch (error) {
    if (installedNew) {
      try {
        await operations.bootout();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], '回滚 launchd 配置失败；保留新 plist 以匹配可能仍加载的新服务');
      }
      if (previous === undefined) {
        await rm(plistPath, { force: true });
      } else {
        await writeFile(plistPath, previous, 'utf-8');
      }
    }
    if (wasLoaded && bootedOut) await operations.bootstrap();
    throw error;
  } finally {
    await rm(stagedPath, { force: true });
  }
}

async function disableLaunchd(): Promise<void> {
  try { await execFileAsync('launchctl', ['bootout', `${launchdDomain()}/${LABEL}`]); } catch { /* not loaded */ }
  try { await unlink(PLIST_PATH); } catch { /* ok */ }
}

async function getLaunchdStatus(): Promise<ScheduleStatus> {
  try {
    await stat(PLIST_PATH);
  } catch {
    return { enabled: false };
  }
  try {
    const content = await readFile(PLIST_PATH, 'utf-8');
    const loaded = await isLaunchdLoaded();
    return { ...parseLaunchdPlist(content, loaded), path: PLIST_PATH };
  } catch {
    return { enabled: false };
  }
}

export function parseLaunchdPlist(content: string, loaded: boolean): ScheduleStatus {
  const intervalMatch = content.match(/<!--\s*AIUsageIntervalSeconds:\s*(\d+)\s*-->/)
    ?? content.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
  const interval = intervalMatch ? parseInt(intervalMatch[1], 10) : undefined;
  const argumentsMatch = content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  const args = argumentsMatch
    ? [...argumentsMatch[1].matchAll(/<string>([^<]*)<\/string>/g)].map(match => unescapeXml(match[1]))
    : [];
  const lookbackIndex = args.indexOf('--lookback');
  const lookbackDays = lookbackIndex >= 0 ? parseInt(args[lookbackIndex + 1] ?? '', 10) : undefined;
  const logMatch = content.match(/<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/);

  return {
    enabled: loaded,
    installed: true,
    loaded,
    interval,
    intervalLabel: interval ? formatInterval(interval) : undefined,
    command: args.length > 0 ? args.join(' ') : undefined,
    logPath: logMatch ? unescapeXml(logMatch[1]) : undefined,
    includeToday: args.includes('--today') || Number.isFinite(lookbackDays),
    lookbackDays: Number.isFinite(lookbackDays) ? lookbackDays : undefined,
    runAtLoad: /<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(content),
  };
}

// ── Linux cron ──

async function enableCron(intervalSeconds: number): Promise<ScheduleStatus> {
  const { nodePath, scriptPath } = resolveCommandPaths();
  const cronLine = buildCronLine(nodePath, scriptPath, intervalSeconds);

  await mkdir(join(homedir(), '.aiusage'), { recursive: true });

  let existing = '';
  try {
    const { stdout } = await execFileAsync('crontab', ['-l']);
    existing = stdout;
  } catch { /* no crontab */ }

  const filtered = existing
    .split('\n')
    .filter((line) => !line.includes(CRON_MARKER))
    .join('\n')
    .trimEnd();

  const newContent = filtered ? `${filtered}\n${cronLine}\n` : `${cronLine}\n`;
  await writeCrontab(newContent);

  return {
    enabled: true,
    installed: true,
    loaded: true,
    interval: intervalSeconds,
    intervalLabel: formatInterval(intervalSeconds),
    includeToday: true,
    lookbackDays: SCHEDULE_LOOKBACK_DAYS,
  };
}

export function buildCronLine(
  nodePath: string,
  scriptPath: string,
  intervalSeconds: number,
  logPath = LOG_PATH,
): string {
  const cronExpr = secondsToCron(intervalSeconds);
  return `${cronExpr} flock -n ${quoteCronArg(SCHEDULE_LOCK_PATH)} ${quoteCronArg(nodePath)} ${quoteCronArg(scriptPath)} sync --lookback ${SCHEDULE_LOOKBACK_DAYS} --batch-size ${SCHEDULE_BATCH_SIZE} --scheduled >> ${quoteCronArg(logPath)} 2>&1 ${CRON_MARKER}`;
}

async function disableCron(): Promise<void> {
  let existing = '';
  try {
    const { stdout } = await execFileAsync('crontab', ['-l']);
    existing = stdout;
  } catch { return; }

  const filtered = existing
    .split('\n')
    .filter((line) => !line.includes(CRON_MARKER))
    .join('\n')
    .trimEnd();

  if (!filtered) {
    try { await execFileAsync('crontab', ['-r']); } catch { /* ok */ }
  } else {
    await writeCrontab(filtered + '\n');
  }
}

async function getCronStatus(): Promise<ScheduleStatus> {
  try {
    const { stdout } = await execFileAsync('crontab', ['-l']);
    const line = stdout.split('\n').find((l) => l.includes(CRON_MARKER));
    if (!line) return { enabled: false };
    const interval = cronToSeconds(line);
    const lookbackMatch = line.match(/--lookback\s+(\d+)/);
    const lookbackDays = lookbackMatch ? parseInt(lookbackMatch[1], 10) : undefined;
    const includeToday = line.includes('--today') || Number.isFinite(lookbackDays);
    // cron 行格式: */5 * * * * /path/to/node /path/to/aiusage sync --lookback 7 >> /log 2>&1 # marker
    const logPath = parseCronLogPath(line);
    // 提取 cron 表达式后的命令部分
    const cmdMatch = line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+?)(?:\s*>>)/);
    const command = cmdMatch?.[1];
    return {
      enabled: true,
      installed: true,
      loaded: true,
      interval,
      intervalLabel: interval ? formatInterval(interval) : undefined,
      command,
      logPath,
      includeToday,
      lookbackDays: Number.isFinite(lookbackDays) ? lookbackDays : undefined,
    };
  } catch {
    return { enabled: false };
  }
}

async function writeCrontab(content: string): Promise<void> {
  const tmpFile = join(tmpdir(), `aiusage-cron-${Date.now()}`);
  await writeFile(tmpFile, content, 'utf-8');
  try {
    await execFileAsync('crontab', [tmpFile]);
  } finally {
    try { await unlink(tmpFile); } catch { /* ok */ }
  }
}

function secondsToCron(seconds: number): string {
  const minutes = seconds / 60;
  if (Number.isInteger(minutes) && minutes <= 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
  const hours = seconds / 3600;
  if (Number.isInteger(hours) && hours < 24 && 24 % hours === 0) return `0 */${hours} * * *`;
  if (seconds === 86400) return '10 0 * * *';
  throw new Error('Linux cron 无法精确表示该间隔；请使用可整除 60 分钟或 24 小时的间隔');
}

function quoteCronArg(value: string): string {
  const cronEscaped = value.replace(/%/g, '\\%');
  return `'${cronEscaped.replace(/'/g, `'"'"'`)}'`;
}

export function parseCronLogPath(line: string): string | undefined {
  const raw = line.match(/>>\s*(.+?)\s+2>&1/)?.[1]?.trim();
  if (!raw) return undefined;
  const joined = raw.replace(/'"'"'/g, "'");
  const unquoted = joined.startsWith("'") && joined.endsWith("'") ? joined.slice(1, -1) : joined;
  return unquoted.replace(/\\%/g, '%');
}

function cronToSeconds(cronLine: string): number | undefined {
  const parts = cronLine.trim().split(/\s+/);
  if (parts.length < 5) return undefined;
  const [minute, hour] = parts;
  const minMatch = minute.match(/^\*\/(\d+)$/);
  if (minMatch) return parseInt(minMatch[1], 10) * 60;
  const hourMatch = hour.match(/^\*\/(\d+)$/);
  if (hourMatch && minute === '0') return parseInt(hourMatch[1], 10) * 3600;
  if (minute === '10' && hour === '0') return 86400;
  return undefined;
}

function launchdDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('无法解析当前 macOS 用户 ID');
  return `gui/${uid}`;
}

async function isLaunchdLoaded(): Promise<boolean> {
  try {
    await execFileAsync('launchctl', ['print', `${launchdDomain()}/${LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

function scheduledArguments(nodePath: string, scriptPath: string): string[] {
  return [
    '/usr/bin/lockf', '-k', '-s', '-t', '0', SCHEDULE_LOCK_PATH,
    nodePath, scriptPath, 'sync', '--lookback', String(SCHEDULE_LOOKBACK_DAYS), '--batch-size', String(SCHEDULE_BATCH_SIZE), '--scheduled',
  ];
}

export async function scheduledBackfillDue(statePath = SCHEDULE_STATE_PATH, now = new Date()): Promise<boolean> {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf-8')) as { lastBackfillDate?: string };
    return state.lastBackfillDate !== localDate(now);
  } catch {
    return true;
  }
}

export async function recordScheduledBackfill(statePath = SCHEDULE_STATE_PATH, now = new Date()): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const stagedPath = `${statePath}.new-${process.pid}`;
  await writeFile(stagedPath, JSON.stringify({ lastBackfillDate: localDate(now) }, null, 2) + '\n', 'utf-8');
  await rename(stagedPath, statePath);
}

export async function runScheduledSync(
  task: (backfillDue: boolean) => Promise<void>,
  statePath = SCHEDULE_STATE_PATH,
  scheduledAt = new Date(),
): Promise<void> {
  const backfillDue = await scheduledBackfillDue(statePath, scheduledAt);
  await task(backfillDue);
  if (backfillDue) await recordScheduledBackfill(statePath, scheduledAt);
}

function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function launchctlServiceNotFound(error: unknown): boolean {
  const execError = error as NodeJS.ErrnoException & { stderr?: string };
  return /could not find service|no such process|service not found/i.test(execError.stderr ?? execError.message ?? '');
}

export function launchdOutputHasArguments(output: string, expectedArgs: string[]): boolean {
  const block = output.match(/arguments\s*=\s*\{([\s\S]*?)\}/)?.[1];
  if (!block) return false;
  const actualArgs = block.split('\n').map(line => line.trim()).filter(Boolean);
  return actualArgs.length === expectedArgs.length && actualArgs.every((arg, index) => arg === expectedArgs[index]);
}

function renderLaunchdTrigger(intervalSeconds: number): string[] {
  const minutes = intervalSeconds / 60;
  if (Number.isInteger(minutes) && minutes > 0 && minutes <= 60 && 60 % minutes === 0) {
    const minuteValues = Array.from({ length: 60 / minutes }, (_, index) => index * minutes);
    return renderCalendarEntries(minuteValues.map(minute => ({ minute })));
  }

  const hours = intervalSeconds / 3600;
  if (Number.isInteger(hours) && hours > 0 && hours <= 24 && 24 % hours === 0) {
    const hourValues = Array.from({ length: 24 / hours }, (_, index) => index * hours);
    return renderCalendarEntries(hourValues.map(hour => ({ hour, minute: 0 })));
  }

  return [
    '  <key>StartInterval</key>',
    `  <integer>${intervalSeconds}</integer>`,
  ];
}

function renderCalendarEntries(entries: Array<{ hour?: number; minute: number }>): string[] {
  const lines = ['  <key>StartCalendarInterval</key>', '  <array>'];
  for (const entry of entries) {
    lines.push('    <dict>');
    if (entry.hour !== undefined) {
      lines.push('      <key>Hour</key>', `      <integer>${entry.hour}</integer>`);
    }
    lines.push('      <key>Minute</key>', `      <integer>${entry.minute}</integer>`, '    </dict>');
  }
  lines.push('  </array>');
  return lines;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
