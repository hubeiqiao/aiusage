# AIUsage

Track and visualize your AI coding assistant token usage across Claude Code and Codex.

AIUsage collects local token statistics, syncs them to a self-hosted Cloudflare Worker, and displays usage trends on a public dashboard — all without sending any conversation content.

## Features

- **Local scanning** — Parse Claude Code and Codex session logs to extract token usage
- **Usage reports** — Terminal reports with daily trends, model breakdowns, and cost estimates
- **Cloud sync** — Upload aggregated stats to your own Cloudflare Worker + D1 database
- **Public dashboard** — Read-only web UI showing usage trends, top models, and costs
- **Privacy first** — Only token counts are uploaded; project names can be masked or hidden
- **Multi-device** — Register multiple machines with device-scoped tokens
- **Auto scheduling** — Set up periodic sync via launchd (macOS) or cron (Linux)

## Architecture

```
┌─────────────┐         ┌──────────────────────┐
│  Controller  │── sync ──▶  Cloudflare Worker  │
│  (CLI tool)  │         │  + D1 Database       │
└─────────────┘         └──────────┬───────────┘
                                   │
                            public API
                                   │
                        ┌──────────▼───────────┐
                        │     Dashboard        │
                        │  (read-only web UI)  │
                        └──────────────────────┘
```

- **Controller** (`@aiusage/controller`) — Local CLI for scanning, reporting, and syncing
- **Worker** (`packages/worker`) — Cloudflare Worker handling ingestion, cost calculation, and public API
- **Shared** (`packages/shared`) — Common types and constants

## Quick Start

### Local reporting (no server needed)

```bash
npm install -g @aiusage/controller

aiusage report --range 7d
aiusage scan --date 2026-03-31
```

### Deploy your own server

Prerequisites: [Node.js](https://nodejs.org/) >= 18, [pnpm](https://pnpm.io/), [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

```bash
# Clone and install
git clone https://github.com/ennann/aiusage.git
cd aiusage
pnpm install

# Login to Cloudflare
npx wrangler login

# Create D1 database
npx wrangler d1 create aiusage-db
# Copy the database_id into packages/worker/wrangler.jsonc

# Run database migration
npx wrangler d1 migrations apply aiusage-db --remote

# Set secrets
npx wrangler secret put SITE_ID
npx wrangler secret put ENROLL_TOKEN
npx wrangler secret put DEVICE_TOKEN_SECRET
npx wrangler secret put PROJECT_NAME_SALT

# Deploy
cd packages/worker
npx wrangler deploy
```

### Connect your device

```bash
aiusage init --server https://your-worker.example.com --site-id <SITE_ID>
aiusage enroll --enroll-token <ENROLL_TOKEN> --device-name "My MacBook"
aiusage sync
aiusage schedule on --every 1h
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `aiusage report [--range 7d\|1m\|3m\|all] [--json]` | Local usage report |
| `aiusage scan [--date YYYY-MM-DD] [--json]` | Scan a single day |
| `aiusage init --server URL --site-id ID` | Initialize config |
| `aiusage health` | Test server connectivity |
| `aiusage enroll --enroll-token TOKEN` | Register device |
| `aiusage sync [--lookback N]` | Upload data to server |
| `aiusage schedule [on\|off] [--every 1h]` | Manage auto sync |
| `aiusage doctor` | Run diagnostic checks |
| `aiusage config set <key> <value>` | Update local settings |

## API Endpoints

### Device API (authenticated)

- `GET /api/v1/health` — Connectivity check
- `POST /api/v1/enroll` — Register a new device
- `POST /api/v1/ingest/daily` — Upload daily usage data

### Public API (read-only, CORS enabled)

- `GET /api/v1/public/overview?range=7d` — Summary and daily trend
- `GET /api/v1/public/breakdowns?range=7d&limit=50` — Detailed breakdowns with pagination

## Privacy

Project names are sensitive. AIUsage supports three display modes for the public dashboard:

| Mode | Behavior |
|------|----------|
| `masked` (default) | Stable pseudonyms like `Project A1F4` via HMAC |
| `hidden` | Project dimension not shown |
| `plain` | Real project names (private deployments only) |

Set via `PUBLIC_PROJECT_VISIBILITY` in `wrangler.jsonc`.

## Project Structure

```
aiusage/
├── packages/
│   ├── controller/    # CLI tool (published as @aiusage/controller)
│   ├── worker/        # Cloudflare Worker + D1
│   └── shared/        # Shared types and constants
├── docs/
│   └── technical-design.md
├── turbo.json
└── pnpm-workspace.yaml
```

## Development

```bash
pnpm install
pnpm build        # Build all packages
pnpm lint         # Type check all packages

# Local worker development
cd packages/worker
npx wrangler d1 migrations apply aiusage-db --local
npx wrangler dev
```

## License

[MIT](LICENSE)
