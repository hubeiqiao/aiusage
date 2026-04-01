# @aiusage/controller

`@aiusage/controller` is the AIUsage command-line tool for:

- scanning local Claude Code and Codex token usage
- printing local usage summaries for the last 7 days, 30 days, 90 days, or all history
- scheduling automatic sync to an AIUsage Worker
- diagnosing configuration and connectivity issues

## Install

```bash
npm install -g @aiusage/controller
```

Or run it directly with `npx`:

```bash
npx @aiusage/controller --help
```

After installation:

```bash
aiusage --help
```

## Commands

### report

Local usage report. No cloud upload required.

```bash
aiusage report --range 7d
aiusage report --range 1m
aiusage report --range 3m
aiusage report --range all
aiusage report --range 7d --json
```

Reads data from `~/.claude/projects` (Claude Code) and `~/.codex` (Codex).

The report includes events, token breakdowns (input / cache read / cache write / output / reasoning), grouped totals by source, daily trend, top models, and estimated USD cost based on public pricing.

### scan

Scan a single day and print the breakdown.

```bash
aiusage scan --date 2026-03-31
aiusage scan --date 2026-03-31 --json
```

Defaults to yesterday when `--date` is omitted.

### init

Initialize local configuration.

```bash
aiusage init --server https://your-worker.example.com --site-id your-site-id
```

### health

Test connectivity to the Worker.

```bash
aiusage health
```

### enroll

Register this device with the Worker.

```bash
aiusage enroll \
  --server https://your-worker.example.com \
  --site-id your-site-id \
  --enroll-token your-enroll-token \
  --device-name "MacBook Pro"
```

### sync

Upload closed-day data to the Worker. Covers the last 7 days by default.

```bash
aiusage sync
aiusage sync --date 2026-03-31
aiusage sync --lookback 14
```

### schedule

Manage automatic sync. Uses `launchd` on macOS and `cron` on Linux.

```bash
aiusage schedule            # show status
aiusage schedule on         # enable, default every 1 hour
aiusage schedule on --every 2h
aiusage schedule on --every 30m
aiusage schedule off        # disable
```

Supported intervals: `10m` – `1d`. As long as your machine is awake for one interval within a day, yesterday's data will be uploaded.

### doctor

Run diagnostic checks on configuration, server connectivity, scanner directories, and schedule status.

```bash
aiusage doctor
```

### config set

Manage local settings.

```bash
aiusage config set device.alias "MacBook Pro 工作机"
aiusage config set privacy.projectVisibility masked
aiusage config set project.alias /Users/me/Projects/MyApp MyApp
```

## Configuration

Config file: `~/.aiusage/config.json`

Sync log (when scheduled): `~/.aiusage/sync.log`

## License

MIT
