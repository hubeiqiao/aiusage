import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as schedule from '../schedule.js';

const {
  parseInterval,
  resolveCommandPaths,
} = schedule;

type ReliabilityScheduleApi = typeof schedule & {
  buildLaunchdPlist?: (nodePath: string, scriptPath: string, intervalSeconds: number) => string;
  buildCronLine?: (nodePath: string, scriptPath: string, intervalSeconds: number, logPath?: string) => string;
  buildLaunchdRegistrationCommands?: (domain: string, plistPath: string) => {
    bootout: string[];
    bootstrap: string[];
  };
  parseLaunchdPlist?: (content: string, loaded: boolean) => schedule.ScheduleStatus;
  replaceLaunchdPlist?: (
    plistPath: string,
    content: string,
    wasLoaded: boolean,
    operations: {
      validate: (path: string) => Promise<void>;
      bootout: () => Promise<void>;
      bootstrap: () => Promise<void>;
      verify: () => Promise<void>;
    },
  ) => Promise<void>;
  launchdOutputHasArguments?: (output: string, expectedArgs: string[]) => boolean;
  resolveStableNodePath?: (execPath: string, candidates?: string[]) => string;
  parseCronLogPath?: (line: string) => string | undefined;
  retryLaunchctlBootstrap?: (
    args: string[],
    run: (args: string[]) => Promise<void>,
    wait: (milliseconds: number) => Promise<void>,
  ) => Promise<void>;
  scheduledBackfillDue?: (statePath: string, now: Date) => Promise<boolean>;
  recordScheduledBackfill?: (statePath: string, now: Date) => Promise<void>;
  runScheduledSync?: (
    task: (backfillDue: boolean) => Promise<void>,
    statePath: string,
    scheduledAt: Date,
  ) => Promise<void>;
};

const reliabilityApi = schedule as ReliabilityScheduleApi;

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('schedule', () => {
  it('resolves volatile command shims to the stable package script', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiusage-schedule-'));
    tempDirs.push(root);

    const stableScript = join(root, 'node_modules', '@aiusage', 'cli', 'dist', 'cli.js');
    await mkdir(dirname(stableScript), { recursive: true });
    await writeFile(stableScript, '#!/usr/bin/env node\n', 'utf-8');

    const shimPath = join(root, 'fnm_multishells', '1234', 'bin', 'aiusage');
    await mkdir(dirname(shimPath), { recursive: true });
    await symlink(stableScript, shimPath);

    const originalArgv = process.argv;
    process.argv = [originalArgv[0] ?? 'node', shimPath];
    try {
      const paths = resolveCommandPaths();
      await expect(realpath(paths.scriptPath)).resolves.toBe(await realpath(stableScript));
    } finally {
      process.argv = originalArgv;
    }
  });

  it('prefers a stable Node symlink over a versioned executable path', async () => {
    expect(reliabilityApi.resolveStableNodePath).toBeTypeOf('function');
    const root = await mkdtemp(join(tmpdir(), 'aiusage-node-path-'));
    tempDirs.push(root);
    const versioned = join(root, 'Cellar', 'node', '23.9.0', 'bin', 'node');
    const stable = join(root, 'bin', 'node');
    await mkdir(dirname(versioned), { recursive: true });
    await mkdir(dirname(stable), { recursive: true });
    await writeFile(versioned, '', 'utf-8');
    await symlink(versioned, stable);

    expect(reliabilityApi.resolveStableNodePath!(versioned, [stable])).toBe(stable);
  });

  it('parses schedule intervals', () => {
    expect(parseInterval('5m')).toEqual({ seconds: 300, label: '5m' });
    expect(parseInterval('2h')).toEqual({ seconds: 7200, label: '2h' });
  });

  it('renders a durable macOS schedule that backfills seven closed days plus today', () => {
    expect(reliabilityApi.buildLaunchdPlist).toBeTypeOf('function');

    const plist = reliabilityApi.buildLaunchdPlist!(
      '/opt/homebrew/bin/node',
      '/opt/homebrew/bin/aiusage',
      300,
    );

    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>StartCalendarInterval</key>');
    expect(plist).not.toContain('<key>StartInterval</key>');
    expect(plist).toContain('<string>--lookback</string>');
    expect(plist).toContain('<string>7</string>');
    expect(plist).toContain('<string>--batch-size</string>');
    expect(plist).toContain('<string>1</string>');
    expect(plist).toContain('<string>--scheduled</string>');
    expect(plist).not.toContain('<string>--today</string>');
  });

  it('keeps exact StartInterval semantics when an interval cannot be represented evenly by the calendar', () => {
    expect(reliabilityApi.buildLaunchdPlist).toBeTypeOf('function');

    const plist = reliabilityApi.buildLaunchdPlist!(
      '/opt/homebrew/bin/node',
      '/opt/homebrew/bin/aiusage',
      420,
    );

    expect(plist).toContain('<key>StartInterval</key>\n  <integer>420</integer>');
    expect(plist).not.toContain('<key>StartCalendarInterval</key>');
  });

  it('reports an installed launchd plist as disabled when the service is not loaded', () => {
    expect(reliabilityApi.parseLaunchdPlist).toBeTypeOf('function');

    const plist = reliabilityApi.buildLaunchdPlist!(
      '/opt/homebrew/bin/node',
      '/opt/homebrew/bin/aiusage',
      300,
    );
    const status = reliabilityApi.parseLaunchdPlist!(plist, false);

    expect(status).toMatchObject({
      enabled: false,
      installed: true,
      loaded: false,
      lookbackDays: 7,
      runAtLoad: true,
    });
    expect(status.command).toContain('/usr/bin/lockf -k -s -t 0');
    expect(status.command).toContain('/opt/homebrew/bin/node /opt/homebrew/bin/aiusage sync --lookback 7 --batch-size 1');
  });

  it('renders Linux cron with the same rolling backfill window', () => {
    expect(reliabilityApi.buildCronLine).toBeTypeOf('function');

    const line = reliabilityApi.buildCronLine!(
      '/usr/bin/node',
      '/usr/local/bin/aiusage',
      1800,
    );

    expect(line).toContain(`flock -n '${join(homedir(), '.aiusage', 'sync.lock')}'`);
    expect(line).toContain("'/usr/bin/node' '/usr/local/bin/aiusage' sync --lookback 7");
    expect(line).toContain('--batch-size 1');
    expect(line).toContain('--scheduled');
    expect(line).not.toContain('--today');
  });

  it.each(['7m', '59m', '90m'])('rejects Linux interval %s instead of silently changing its frequency', (value) => {
    expect(reliabilityApi.buildCronLine).toBeTypeOf('function');
    const { seconds } = parseInterval(value);

    expect(() => reliabilityApi.buildCronLine!('/usr/bin/node', '/usr/bin/aiusage', seconds))
      .toThrow('Linux cron 无法精确表示该间隔');
  });

  it('quotes cron paths containing spaces and cron-special percent signs', () => {
    expect(reliabilityApi.buildCronLine).toBeTypeOf('function');

    const line = reliabilityApi.buildCronLine!(
      '/Users/Joe Data/node%bin',
      '/Users/Joe Data/aiusage',
      1800,
      '/Users/Joe Data/sync%.log',
    );

    expect(line).toContain("'/Users/Joe Data/node\\%bin'");
    expect(line).toContain("'/Users/Joe Data/aiusage'");
    expect(line).toContain(">> '/Users/Joe Data/sync\\%.log'");
    expect(reliabilityApi.parseCronLogPath?.(line)).toBe('/Users/Joe Data/sync%.log');
  });

  it('registers macOS schedules with bootout and bootstrap instead of legacy load commands', () => {
    expect(reliabilityApi.buildLaunchdRegistrationCommands).toBeTypeOf('function');

    expect(reliabilityApi.buildLaunchdRegistrationCommands!(
      'gui/501',
      '/Users/joe/Library/LaunchAgents/com.aiusage.sync.plist',
    )).toEqual({
      bootout: ['bootout', 'gui/501/com.aiusage.sync'],
      bootstrap: ['bootstrap', 'gui/501', '/Users/joe/Library/LaunchAgents/com.aiusage.sync.plist'],
    });
  });

  it('retries transient launchctl bootstrap failures after bootout', async () => {
    expect(reliabilityApi.retryLaunchctlBootstrap).toBeTypeOf('function');
    let calls = 0;
    const waits: number[] = [];

    await reliabilityApi.retryLaunchctlBootstrap!(
      ['bootstrap', 'gui/501', '/tmp/test.plist'],
      async () => {
        calls++;
        if (calls < 3) throw new Error('Bootstrap failed: 5: Input/output error');
      },
      async milliseconds => { waits.push(milliseconds); },
    );

    expect(calls).toBe(3);
    expect(waits).toEqual([250, 500]);
  });

  it('restores the previous plist and loaded service when bootstrap fails', async () => {
    expect(reliabilityApi.replaceLaunchdPlist).toBeTypeOf('function');
    const root = await mkdtemp(join(tmpdir(), 'aiusage-launchd-rollback-'));
    tempDirs.push(root);
    const plistPath = join(root, 'com.aiusage.sync.plist');
    await writeFile(plistPath, 'old-plist', 'utf-8');
    let bootstrapCalls = 0;

    await expect(reliabilityApi.replaceLaunchdPlist!(plistPath, 'new-plist', true, {
      validate: async () => {},
      bootout: async () => {},
      bootstrap: async () => {
        bootstrapCalls++;
        if (bootstrapCalls === 1) throw new Error('bootstrap failed');
      },
      verify: async () => {},
    })).rejects.toThrow('bootstrap failed');

    expect(await import('node:fs/promises').then(fs => fs.readFile(plistPath, 'utf-8'))).toBe('old-plist');
    expect(bootstrapCalls).toBe(2);
  });

  it('uses the kernel-backed macOS lockf wrapper instead of a PID lock', () => {
    const plist = reliabilityApi.buildLaunchdPlist!(
      '/opt/homebrew/bin/node',
      '/opt/homebrew/bin/aiusage',
      300,
    );

    expect(plist).toContain('<string>/usr/bin/lockf</string>');
    expect(plist).toContain('<string>-k</string>');
    expect(plist).toContain('<string>-s</string>');
    expect(plist).toContain('<string>-t</string>\n    <string>0</string>');
  });

  it('runs the expensive rolling backfill at most once per local day', async () => {
    expect(reliabilityApi.scheduledBackfillDue).toBeTypeOf('function');
    expect(reliabilityApi.recordScheduledBackfill).toBeTypeOf('function');
    const root = await mkdtemp(join(tmpdir(), 'aiusage-schedule-state-'));
    tempDirs.push(root);
    const statePath = join(root, 'schedule-state.json');
    const morning = new Date(2026, 7, 17, 8, 0, 0);
    const evening = new Date(2026, 7, 17, 20, 0, 0);
    const nextDay = new Date(2026, 7, 18, 0, 1, 0);

    await expect(reliabilityApi.scheduledBackfillDue!(statePath, morning)).resolves.toBe(true);
    await reliabilityApi.recordScheduledBackfill!(statePath, morning);
    await expect(reliabilityApi.scheduledBackfillDue!(statePath, evening)).resolves.toBe(false);
    await expect(reliabilityApi.scheduledBackfillDue!(statePath, nextDay)).resolves.toBe(true);
  });

  it('does not mark the next local day complete when a backfill crosses midnight', async () => {
    expect(reliabilityApi.runScheduledSync).toBeTypeOf('function');
    const root = await mkdtemp(join(tmpdir(), 'aiusage-schedule-midnight-'));
    tempDirs.push(root);
    const statePath = join(root, 'schedule-state.json');
    const scheduledAt = new Date(2026, 7, 17, 23, 55, 0);
    const afterMidnight = new Date(2026, 7, 18, 0, 5, 0);
    let receivedBackfillDue = false;

    await reliabilityApi.runScheduledSync!(async (backfillDue) => {
      receivedBackfillDue = backfillDue;
    }, statePath, scheduledAt);

    expect(receivedBackfillDue).toBe(true);
    await expect(reliabilityApi.scheduledBackfillDue!(statePath, afterMidnight)).resolves.toBe(true);
  });

  it('keeps the new plist in place if rollback cannot unload its service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiusage-launchd-rollback-failure-'));
    tempDirs.push(root);
    const plistPath = join(root, 'com.aiusage.sync.plist');
    await writeFile(plistPath, 'old-plist', 'utf-8');
    let bootoutCalls = 0;

    await expect(reliabilityApi.replaceLaunchdPlist!(plistPath, 'new-plist', true, {
      validate: async () => {},
      bootout: async () => {
        bootoutCalls++;
        if (bootoutCalls === 2) throw new Error('rollback bootout failed');
      },
      bootstrap: async () => {},
      verify: async () => { throw new Error('verify failed'); },
    })).rejects.toThrow('回滚 launchd 配置失败');

    expect(await import('node:fs/promises').then(fs => fs.readFile(plistPath, 'utf-8'))).toBe('new-plist');
  });

  it('restores the previous loaded plist when post-bootstrap verification fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiusage-launchd-verify-rollback-'));
    tempDirs.push(root);
    const plistPath = join(root, 'com.aiusage.sync.plist');
    await writeFile(plistPath, 'old-plist', 'utf-8');
    let bootstrapCalls = 0;

    await expect(reliabilityApi.replaceLaunchdPlist!(plistPath, 'new-plist', true, {
      validate: async () => {},
      bootout: async () => {},
      bootstrap: async () => { bootstrapCalls++; },
      verify: async () => { throw new Error('verify failed'); },
    })).rejects.toThrow('verify failed');

    expect(await import('node:fs/promises').then(fs => fs.readFile(plistPath, 'utf-8'))).toBe('old-plist');
    expect(bootstrapCalls).toBe(2);
  });

  it('distinguishes the newly loaded launchd definition from an old today-only job', () => {
    expect(reliabilityApi.launchdOutputHasArguments).toBeTypeOf('function');
    const output = `arguments = {\n  /usr/bin/node\n  /usr/bin/aiusage\n  sync\n  --today\n}`;

    expect(reliabilityApi.launchdOutputHasArguments!(output, [
      '/usr/bin/lockf',
      '-k',
      '-s',
      '-t',
      '0',
      join(homedir(), '.aiusage', 'sync.lock'),
      '/usr/bin/node',
      '/usr/bin/aiusage',
      'sync',
      '--lookback',
      '7',
      '--batch-size',
      '1',
      '--scheduled',
    ])).toBe(false);
  });
});
