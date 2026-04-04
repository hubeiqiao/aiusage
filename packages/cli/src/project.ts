import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface DiscoveredProject {
  /** 原始项目名（目录 basename） */
  name: string;
  /** 已设置的别名，无则为 undefined */
  alias?: string;
  /** 发现该项目的工具来源 */
  sources: string[];
}

/**
 * 扫描所有支持工具的数据目录，发现本机全部项目。
 * 仅读目录结构，不解析日志，速度快。
 */
export async function discoverProjects(
  projectAliases?: Record<string, string>,
): Promise<DiscoveredProject[]> {
  const projectMap = new Map<string, Set<string>>(); // name → sources

  function add(name: string, source: string) {
    if (!name || name === 'unknown') return;
    if (!projectMap.has(name)) projectMap.set(name, new Set());
    projectMap.get(name)!.add(source);
  }

  await Promise.all([
    // Claude: ~/.claude/projects/{encoded-path}/
    // 目录名是编码路径（- 替换 /），但项目名本身可能含 -，无法可靠还原。
    // 读取每个项目目录下第一个 jsonl 首行的 cwd 字段来获取真实项目名。
    discoverClaudeProjects().then(names => names.forEach(n => add(n, 'claude'))),

    // Codex: ~/.codex/sessions/YYYY/MM/DD/*.jsonl
    // 每个 session 首行 session_meta 含 cwd 字段
    discoverCodexProjects().then(names => names.forEach(n => add(n, 'codex'))),

    // Copilot CLI: ~/.copilot/session-state/{sessionId}/events.jsonl
    // 首行 session.start 含 data.context.gitRoot / cwd
    discoverCopilotProjects().then(names => names.forEach(n => add(n, 'copilot'))),

    // Gemini CLI: ~/.gemini/projects.json 含 { projects: { path: name } }
    discoverGeminiProjects().then(names => names.forEach(n => add(n, 'gemini'))),
  ]);

  // ���建结果
  const results: DiscoveredProject[] = [];
  for (const [name, sources] of projectMap) {
    const alias = projectAliases?.[name];
    results.push({
      name,
      alias,
      sources: [...sources].sort(),
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** 从 Claude 项目目录中读取 jsonl 首行的 cwd 来获取真实项目名 */
async function discoverClaudeProjects(): Promise<string[]> {
  const names: string[] = [];
  for (const baseDir of getClaudeDirs()) {
    let entries;
    try {
      entries = await readdir(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const projectDir = join(baseDir, entry.name);
      const name = await extractCwdFromFirstJsonl(projectDir);
      if (name && name !== 'unknown') names.push(name);
    }
  }
  return names;
}

/** 从 Codex session 文件中提取所有不同的项目名 */
async function discoverCodexProjects(): Promise<string[]> {
  const sessionsDir = join(homedir(), '.codex', 'sessions');
  const files = await walkJsonlFiles(sessionsDir);
  const projects = new Set<string>();

  for (const filePath of files) {
    const name = await extractCwdFromSessionMeta(filePath);
    if (name && name !== 'unknown') projects.add(name);
  }
  return [...projects];
}

/** 读取 Codex session jsonl 首行的 session_meta.payload.cwd */
async function extractCwdFromSessionMeta(filePath: string): Promise<string | undefined> {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return undefined;
    const line = buf.subarray(0, bytesRead).toString('utf-8').split('\n')[0];
    const record = JSON.parse(line);
    const cwd: string | undefined = record?.payload?.cwd;
    if (!cwd) return undefined;
    const parts = cwd.split('/').filter(Boolean);
    return parts[parts.length - 1] || undefined;
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

/** 递归查找目录下所有 .jsonl 文件 */
async function walkJsonlFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.jsonl')) result.push(full);
    }
  }
  await walk(dir);
  return result;
}

/**
 * 找到项目目录下的第一个 .jsonl 文件（顶层或子目录），
 * 读取前 32KB 内容，扫描各行找到含 cwd 字段的记录，提取 basename。
 */
async function extractCwdFromFirstJsonl(dir: string): Promise<string | undefined> {
  const jsonlPath = await findFirstJsonl(dir);
  if (!jsonlPath) return undefined;

  let fh;
  try {
    fh = await open(jsonlPath, 'r');
    const buf = Buffer.alloc(32 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return undefined;
    const lines = buf.subarray(0, bytesRead).toString('utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record?.cwd) {
          const parts = record.cwd.split('/').filter(Boolean);
          const name = parts[parts.length - 1];
          if (name) return name;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

/** 在目录中查找第一个 .jsonl 文件，先查顶层，再查一层子目录 */
async function findFirstJsonl(dir: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  // 顶层 jsonl
  const topJsonl = entries.find(e => e.isFile() && e.name.endsWith('.jsonl'));
  if (topJsonl) return join(dir, topJsonl.name);
  // 一层子目录
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const subFiles = await readdir(join(dir, entry.name));
      const sub = subFiles.find(f => f.endsWith('.jsonl'));
      if (sub) return join(dir, entry.name, sub);
    } catch {
      continue;
    }
  }
  return undefined;
}

/** 从 Copilot session events 首行提取项目名 */
async function discoverCopilotProjects(): Promise<string[]> {
  const dir = join(homedir(), '.copilot', 'session-state');
  const files = await walkJsonlFiles(dir);
  const projects = new Set<string>();

  for (const filePath of files) {
    let fh;
    try {
      fh = await open(filePath, 'r');
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead === 0) continue;
      const line = buf.subarray(0, bytesRead).toString('utf-8').split('\n')[0];
      const record = JSON.parse(line);
      const raw: string | undefined = record?.data?.context?.gitRoot ?? record?.data?.context?.cwd;
      if (raw) {
        const parts = raw.split('/').filter(Boolean);
        const name = parts[parts.length - 1];
        if (name && name !== 'unknown') projects.add(name);
      }
    } catch {
      continue;
    } finally {
      await fh?.close();
    }
  }
  return [...projects];
}

/** 从 Gemini projects.json 读取项目列表 */
async function discoverGeminiProjects(): Promise<string[]> {
  const filePath = join(homedir(), '.gemini', 'projects.json');
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const projects: Record<string, string> | undefined = data?.projects;
    if (!projects || typeof projects !== 'object') return [];
    const names: string[] = [];
    for (const [path, _name] of Object.entries(projects)) {
      const parts = path.split('/').filter(Boolean);
      const name = parts[parts.length - 1];
      if (name && name !== 'unknown') names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

function getClaudeDirs(): string[] {
  const envVar = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (envVar) {
    return envVar.split(',').map(p => p.trim()).filter(Boolean).map(p => join(p, 'projects'));
  }
  const home = homedir();
  return [
    join(home, '.config', 'claude', 'projects'),
    join(home, '.claude', 'projects'),
  ];
}

