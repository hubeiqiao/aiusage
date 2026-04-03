# @aiusage/cli

`@aiusage/cli` 是 AIUsage 命令行工具，用于：

- 扫描本地 AI 编程工具的 Token 用量（Claude Code、Codex、Copilot CLI、Gemini CLI、Qwen Code、Kimi Code、Amp、Droid、OpenCode、Pi）
- 生成本地用量报告（最近 7 天、30 天、90 天或全部历史）
- 定时自动同步数据到 AIUsage Worker
- 诊断配置与连接问题

## 安装

```bash
npm install -g @aiusage/cli
```

或通过 `npx` 直接运行：

```bash
npx @aiusage/cli --help
```

安装后：

```bash
aiusage --help
```

## 命令

### report

本地用量报告，无需服务端。

```bash
aiusage report                          # 默认: 最近 7 天，英文，紧凑模式
aiusage report --range 1m               # 最近 30 天
aiusage report --range 3m               # 最近 90 天
aiusage report --range all              # 全部历史
aiusage report --detail                 # 展示全部列、热门模型、定价说明
aiusage report --lang zh                # 中文输出
aiusage report --no-emoji               # 禁用标题 emoji
aiusage report --json                   # JSON 输出
```

**紧凑模式**（默认）显示来源和每日汇总表，合并缓存列，保留 2 位小数成本。**详细模式**（`--detail`）展开所有列（CacheRead、CacheWrite、Reasoning），增加热门模型和定价说明，显示 4 位小数成本。

### scan

扫描单日数据并打印明细。

```bash
aiusage scan --date 2026-03-31
aiusage scan --date 2026-03-31 --json
```

省略 `--date` 时默认扫描昨天。

### init

初始化本地配置。

```bash
aiusage init --server https://your-worker.example.com --site-id your-site-id
```

### health

测试与 Worker 的连通性。

```bash
aiusage health
```

### enroll

将本设备注册到 Worker。

```bash
aiusage enroll \
  --server https://your-worker.example.com \
  --site-id your-site-id \
  --enroll-token your-enroll-token \
  --device-name "MacBook Pro"
```

### sync

上传用量数据到 Worker。默认覆盖最近 7 个已结束的日期。

```bash
aiusage sync
aiusage sync --today           # 包含今日实时数据
aiusage sync --date 2026-03-31
aiusage sync --lookback 14
```

使用 `--today` 上传当日（未完成）数据。服务端使用 upsert，部分数据会在下次同步时更新。

### schedule

管理定时同步。macOS 使用 `launchd`，Linux 使用 `cron`。

```bash
aiusage schedule on             # 启用，默认每 5 分钟
aiusage schedule on --every 30m # 自定义间隔
aiusage schedule off            # 关闭
aiusage schedule status         # 查看当前定时任务详情
```

支持间隔：`5m` – `1d`。定时同步始终包含今日实时数据（`--today`），确保看板数据及时更新。

`schedule status` 输出示例：

```
状态: 已启用
间隔: 每 5m
含今日: 是
命令: /usr/local/bin/node /usr/local/bin/aiusage sync --today
配置: ~/Library/LaunchAgents/com.aiusage.sync.plist
日志: ~/.aiusage/sync.log
```

### doctor

运行诊断检查，包括配置、服务端连通性、扫描目录和定时任务状态。

```bash
aiusage doctor
```

### config set

管理本地设置。

```bash
aiusage config set lang zh                              # 默认语言: en 或 zh
aiusage config set emoji false                          # 禁用报告标题 emoji
aiusage config set device.alias "MacBook Pro 工作机"
aiusage config set privacy.projectVisibility masked
aiusage config set project.alias /Users/me/Projects/MyApp MyApp
```

CLI 标志（`--lang`、`--no-emoji`）会覆盖配置值（仅当次生效）。

## 配置

配置文件：`~/.aiusage/config.json`

同步日志（定时任务启用时）：`~/.aiusage/sync.log`

## 许可证

MIT
