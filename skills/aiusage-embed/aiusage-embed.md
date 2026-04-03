---
name: embed-widgets
description: Help users embed AIUsage dashboard widgets into external webpages using iframe. Covers all 7 widget types, URL parameters, theming, and common recipes.
trigger: when the user asks about embedding widgets, iframe integration, or sharing dashboard components on other pages
tools:
  - Read
---

# AIUsage Embed Widgets Skill

You are helping the user embed AIUsage dashboard widgets into external webpages via iframe.

## Overview

AIUsage provides 7 embeddable widgets accessible at `/embed?widget=<name>`. Each widget renders as a standalone component — no header, footer, or navigation — designed for iframe embedding.

The full interactive documentation with live previews is available at `/embed/docs` on the user's deployed site.

## Available Widgets

| Widget | ID | Description | `items` support |
|--------|----|-------------|-----------------|
| KPI Cards Row 1 | `stats-row1` | Estimated cost, total tokens, input, output, cached | Yes, index 0-4 |
| KPI Cards Row 2 | `stats-row2` | Active days, sessions, cost/session, avg daily, cache rate | Yes, index 0-4 |
| Cost Trend | `cost-trend` | Daily cost bar chart with multi-provider stacking | No |
| Token Trend | `token-trend` | Daily token usage area chart by type | No |
| Token Composition | `token-composition` | Daily token type stacked bar chart | No |
| Token Flow | `flow` | Model-to-project Sankey diagram | No |
| Share Analysis | `share` | Provider/model/device donut charts | Yes, 0=provider, 1=model, 2=device |

## URL Parameters

Base URL: `https://<your-site>/embed`

| Parameter | Values | Default | Description |
|-----------|--------|---------|-------------|
| `widget` | See table above | — | Widget type (**required**) |
| `items` | Comma-separated indices, e.g. `0,2,4` | All | Which sub-items to display |
| `range` | `7d` / `30d` / `90d` / `month` / `all` | `30d` | Time range |
| `theme` | `light` / `dark` / `auto` | `auto` | Color theme |
| `transparent` | `0` / `1` | `0` | Transparent background (for colored host pages) |
| `locale` | `en` / `zh` | `en` | UI language |
| `deviceId` | device ID string | — | Filter by device |
| `product` | product name string | — | Filter by product |

## Recommended iframe Heights

| Widget | Height |
|--------|--------|
| `stats-row1` | 100px |
| `stats-row2` | 100px |
| `cost-trend` | 360px |
| `token-trend` | 380px |
| `token-composition` | 380px |
| `flow` | 420px |
| `share` | 480px |

## Common Recipes

### Single KPI card (e.g. estimated cost only)

```html
<iframe src="https://your-site/embed?widget=stats-row1&items=0&range=7d"
  width="240" height="100" frameborder="0"></iframe>
```

### Cost trend, dark mode, transparent background

```html
<iframe src="https://your-site/embed?widget=cost-trend&theme=dark&transparent=1&range=30d"
  width="100%" height="360" frameborder="0"></iframe>
```

### Provider + device share only (skip model)

```html
<iframe src="https://your-site/embed?widget=share&items=0,2"
  width="100%" height="360" frameborder="0"></iframe>
```

### Chinese locale, 90 days range

```html
<iframe src="https://your-site/embed?widget=token-trend&locale=zh&range=90d"
  width="100%" height="380" frameborder="0"></iframe>
```

### Multiple widgets in a grid

```html
<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
  <iframe src="https://your-site/embed?widget=cost-trend&range=7d" width="100%" height="360" frameborder="0"></iframe>
  <iframe src="https://your-site/embed?widget=token-trend&range=7d" width="100%" height="380" frameborder="0"></iframe>
</div>
```

## How It Works

1. The user's AIUsage site serves the dashboard as a Single Page Application (SPA)
2. When the path starts with `/embed`, the SPA renders `<EmbedApp />` instead of the full dashboard
3. `EmbedApp` reads URL parameters, fetches data from the same `/api/v1/public/overview` endpoint, and renders only the requested widget
4. No authentication required — uses the same public read-only API as the main dashboard

## Troubleshooting

- **"Missing ?widget= parameter"** — The `widget` query parameter is required. Add `?widget=stats-row1` (or another valid widget ID).
- **Widget shows demo data** — The API is unreachable. Check that the AIUsage Worker is deployed and the site URL is correct.
- **Dark mode doesn't match host page** — Use `theme=dark` or `theme=light` explicitly instead of `auto`. Add `transparent=1` if the host page has a non-white/non-black background.
- **Too tall / too short** — Adjust the iframe `height` attribute. See recommended heights above.
- **Want only specific cards** — Use the `items` parameter with comma-separated zero-based indices.

## Related Pages

- `/embed/docs` — Interactive documentation with live previews and copyable embed codes
- `/pricing` — Model pricing reference
- `/` — Main dashboard
