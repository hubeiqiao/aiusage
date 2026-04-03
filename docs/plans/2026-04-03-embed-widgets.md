# Embed Widgets 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 Dashboard 添加 `/embed` 路由，支持通过 URL 参数精确控制展示哪些 widget，适合 iframe 嵌入场景。

**Architecture:** 纯前端方案。Wrangler 已配置 SPA 回退（`not_found_handling: "single-page-application"`），`/embed` 路径自动回退到 `index.html`。前端在 `main.tsx` 入口根据 `window.location.pathname` 判断是否为 embed 模式，渲染专用的 `<EmbedApp />` 组件。embed 组件复用现有 chart/card 组件，不渲染 header/footer/筛选栏，支持透明背景和主题控制。

**Tech Stack:** React 18 + Vite + Recharts + Tailwind CSS（与现有 dashboard 完全一致）

---

## Widget 参数体系

### URL 格式

```
/embed?widget=<name>[&items=0,2,4][&range=7d][&theme=dark][&transparent=1][&locale=zh]
```

### Widget 清单

| widget 值 | 说明 | 支持 `items` 参数 |
|-----------|------|-------------------|
| `stats-row1` | 指标卡第一行（5 个：预估费用、总 Token、输入、输出、缓存） | ✅ `0-4` |
| `stats-row2` | 指标卡第二行（5 个：活跃天、会话数、单次费用、日均、缓存率） | ✅ `0-4` |
| `cost-trend` | 费用趋势折线/柱状图 | ❌ |
| `token-trend` | Token 趋势面积图 | ❌ |
| `token-composition` | Token 构成柱状图 | ❌ |
| `flow` | Token 流向桑基图 | ❌ |
| `share` | 占比环形图（厂商、模型、设备） | ✅ `0-2` |

### `items` 参数

- 逗号分隔的索引号：`items=0,2,4` → 展示第 1、3、5 个
- 省略则展示全部
- 索引从 0 开始

### 通用参数

| 参数 | 值 | 默认 |
|------|-----|------|
| `range` | `7d` / `30d` / `90d` / `month` / `all` | `30d` |
| `theme` | `light` / `dark` / `auto` | `auto` |
| `transparent` | `1` / `0` | `0` |
| `locale` | `en` / `zh` | `en` |
| `deviceId` | 设备 ID | 空（全部） |
| `product` | 产品筛选 | 空（全部） |

### 使用示例

```html
<!-- 只展示预估费用 + 缓存命中率 -->
<iframe src="https://your-site/embed?widget=stats-row1&items=0&range=7d" />
<iframe src="https://your-site/embed?widget=stats-row2&items=4&range=7d" />

<!-- 费用趋势，深色透明 -->
<iframe src="https://your-site/embed?widget=cost-trend&theme=dark&transparent=1" />

<!-- 只展示厂商和设备占比 -->
<iframe src="https://your-site/embed?widget=share&items=0,2" />
```

---

## Task 1: 定义 embed 参数解析工具函数

**Files:**
- Create: `packages/dashboard/src/embed/parse-params.ts`
- Create: `packages/dashboard/src/embed/types.ts`

**Step 1: 创建类型定义**

```typescript
// packages/dashboard/src/embed/types.ts
export type EmbedWidget =
  | 'stats-row1'
  | 'stats-row2'
  | 'cost-trend'
  | 'token-trend'
  | 'token-composition'
  | 'flow'
  | 'share';

export type EmbedTheme = 'light' | 'dark' | 'auto';

export interface EmbedParams {
  widget: EmbedWidget | null;
  items: number[] | null;       // null = show all
  range: string;
  theme: EmbedTheme;
  transparent: boolean;
  locale: 'en' | 'zh';
  deviceId: string;
  product: string;
}
```

**Step 2: 创建参数解析函数**

```typescript
// packages/dashboard/src/embed/parse-params.ts
import type { EmbedParams, EmbedWidget, EmbedTheme } from './types';

const VALID_WIDGETS = new Set<EmbedWidget>([
  'stats-row1', 'stats-row2', 'cost-trend', 'token-trend',
  'token-composition', 'flow', 'share',
]);

export function parseEmbedParams(search: string): EmbedParams {
  const p = new URLSearchParams(search);

  const rawWidget = p.get('widget') ?? '';
  const widget = VALID_WIDGETS.has(rawWidget as EmbedWidget)
    ? (rawWidget as EmbedWidget)
    : null;

  const rawItems = p.get('items');
  const items = rawItems
    ? rawItems.split(',').map(Number).filter((n) => !Number.isNaN(n) && n >= 0)
    : null;

  const rawTheme = p.get('theme') ?? 'auto';
  const theme: EmbedTheme =
    rawTheme === 'light' || rawTheme === 'dark' ? rawTheme : 'auto';

  const rawLocale = p.get('locale') ?? 'en';
  const locale = rawLocale === 'zh' ? 'zh' : 'en';

  return {
    widget,
    items: items && items.length > 0 ? items : null,
    range: p.get('range') || '30d',
    theme,
    transparent: p.get('transparent') === '1',
    locale,
    deviceId: p.get('deviceId') ?? '',
    product: p.get('product') ?? '',
  };
}
```

**Step 3: Commit**

```bash
git add packages/dashboard/src/embed/
git commit -m "✨ feat(embed): 定义 embed 参数类型与解析函数"
```

---

## Task 2: 提取共享数据 hook

当前 `App` 组件内的数据获取逻辑（fetch + KPI 计算）是内联的。embed 需要复用同样的数据，所以需要提取为共享 hook。

**Files:**
- Create: `packages/dashboard/src/hooks/use-overview.ts`
- Modify: `packages/dashboard/src/app.tsx` — 将 `fetchJson`、`buildQuery`、`padMonth`、KPI 计算逻辑移入 hook，App 改为调用 hook

**Step 1: 创建 `useOverview` hook**

从 `app.tsx` 中提取以下逻辑到 `packages/dashboard/src/hooks/use-overview.ts`：

- `fetchJson` 函数
- `buildQuery` 函数
- `padMonth` 函数及其辅助函数 `currentMonthDates`
- `FiltersState` 接口
- `OverviewPayload` / `HealthPayload` 接口
- `useEffect` 数据获取逻辑（lines 1003-1030）
- `useMemo` KPI 计算逻辑（lines 1033-1045）
- `useMemo` filter options 逻辑（lines 1048-1051）

hook 签名：

```typescript
export function useOverview(filters: FiltersState) {
  // ... 返回 { overview, health, kpis, fOpts, loading, error, isDemo, refresh }
}
```

**Step 2: 修改 `app.tsx`，将 App 组件改为调用 `useOverview`**

删除 App 中被提取的内联逻辑，替换为：

```typescript
const { overview, health, kpis, fOpts, loading, error, isDemo, refresh } = useOverview(filters);
```

原有的 `tick` 状态用 `refresh()` 回调替代。

**Step 3: 验证 dashboard 功能不受影响**

```bash
cd /Users/Ethan/Projects/AIUsage && pnpm --filter @aiusage/dashboard build
```

Expected: 构建成功，无类型错误。

**Step 4: Commit**

```bash
git add packages/dashboard/src/hooks/ packages/dashboard/src/app.tsx
git commit -m "♻️ refactor(dashboard): 提取 useOverview hook 供 embed 复用"
```

---

## Task 3: 提取 widget 子组件为独立文件

当前所有组件都在 `app.tsx` 单文件内。embed 需要独立引用这些组件，需要拆分。

**Files:**
- Create: `packages/dashboard/src/components/kpi-card.tsx`
- Create: `packages/dashboard/src/components/cost-trend-chart.tsx`
- Create: `packages/dashboard/src/components/token-trend-chart.tsx`
- Create: `packages/dashboard/src/components/token-composition-chart.tsx`
- Create: `packages/dashboard/src/components/flow-chart.tsx`
- Create: `packages/dashboard/src/components/donut-section.tsx`
- Create: `packages/dashboard/src/components/chart-helpers.tsx` — `SectionHeader`、`ChartLegend`、`ChartBoundary`、`EmptyState`、`Skeleton`
- Create: `packages/dashboard/src/constants.ts` — `TOKEN_SERIES`、`CHART_COLORS`、`PROVIDER_COLORS` 等常量
- Create: `packages/dashboard/src/utils/format.ts` — `formatUsd`、`formatCompact`、`formatPercent` 等格式化函数
- Create: `packages/dashboard/src/i18n.ts` — `I18N`、`Locale`、`T` 类型
- Modify: `packages/dashboard/src/app.tsx` — 改为从新文件 import

**原则：**
- 每个组件 export 其 props 接口
- 常量和工具函数各自独立文件
- `app.tsx` 仅保留 `App` 组件本身和布局逻辑
- 组件签名保持不变，纯粹的文件拆分

**Step 1: 逐一创建文件，移出代码**

按上述文件清单，从 `app.tsx` 中剪切对应代码到新文件，添加必要的 import/export。

**Step 2: 修改 `app.tsx`，改为从新文件 import**

**Step 3: 构建验证**

```bash
cd /Users/Ethan/Projects/AIUsage && pnpm --filter @aiusage/dashboard build
```

**Step 4: Commit**

```bash
git add packages/dashboard/src/
git commit -m "♻️ refactor(dashboard): 拆分 app.tsx 为独立组件文件"
```

---

## Task 4: 创建 EmbedApp 组件

**Files:**
- Create: `packages/dashboard/src/embed/embed-app.tsx`

**Step 1: 实现 EmbedApp**

```typescript
// packages/dashboard/src/embed/embed-app.tsx
import { useMemo } from 'react';
import { parseEmbedParams } from './parse-params';
import type { EmbedParams } from './types';
import { useOverview } from '../hooks/use-overview';
import { I18N, type T } from '../i18n';
import { applyTheme } from '../theme'; // 从 app.tsx 提取的 theme 逻辑
// ... import 各 widget 组件

export function EmbedApp() {
  const params = useMemo(() => parseEmbedParams(window.location.search), []);

  // 应用主题
  useEffect(() => {
    if (params.theme !== 'auto') applyTheme(params.theme);
  }, [params.theme]);

  // 透明背景
  useEffect(() => {
    if (params.transparent) {
      document.body.style.background = 'transparent';
      document.documentElement.style.background = 'transparent';
    }
  }, [params.transparent]);

  const t: T = I18N[params.locale];

  const { overview, kpis, loading, error } = useOverview({
    range: params.range,
    deviceId: params.deviceId,
    product: params.product,
  });

  if (!params.widget) {
    return <div className="p-4 text-sm text-slate-400">Missing ?widget= parameter</div>;
  }

  if (loading && !overview) return <LoadingSkeleton widget={params.widget} />;
  if (error) return <div className="p-4 text-sm text-red-400">{error}</div>;

  return (
    <div className="embed-root">
      <WidgetRenderer
        widget={params.widget}
        items={params.items}
        overview={overview}
        kpis={kpis}
        t={t}
        locale={params.locale}
      />
    </div>
  );
}
```

**Step 2: 实现 `WidgetRenderer`** — 根据 `widget` 值渲染对应组件

```typescript
function WidgetRenderer({ widget, items, overview, kpis, t, locale }: { ... }) {
  switch (widget) {
    case 'stats-row1':
      return <StatsRow1 items={items} overview={overview} kpis={kpis} t={t} locale={locale} />;
    case 'stats-row2':
      return <StatsRow2 items={items} overview={overview} kpis={kpis} t={t} locale={locale} />;
    case 'cost-trend':
      return <CostTrendEmbed overview={overview} t={t} />;
    case 'token-trend':
      return <TokenTrendEmbed overview={overview} t={t} locale={locale} />;
    case 'token-composition':
      return <TokenCompositionEmbed overview={overview} t={t} locale={locale} />;
    case 'flow':
      return <FlowEmbed overview={overview} t={t} />;
    case 'share':
      return <ShareEmbed items={items} overview={overview} t={t} />;
    default:
      return null;
  }
}
```

**Step 3: 实现 `StatsRow1` / `StatsRow2`** — 支持 `items` 过滤

```typescript
function StatsRow1({ items, overview, kpis, t, locale }: { ... }) {
  const allCards = [
    { label: t.estimatedCost, value: formatUsd(overview?.totalCostUsd ?? 0), highlight: true },
    { label: t.totalTokens, value: formatCompact(kpis?.totalTokens ?? 0, locale) },
    { label: t.inputTokens, value: formatCompact(kpis?.inputTokens ?? 0, locale) },
    { label: t.outputTokens, value: formatCompact(kpis?.outputTokens ?? 0, locale) },
    { label: t.cachedTokens, value: formatCompact(kpis?.cachedTokens ?? 0, locale) },
  ];
  const visible = items ? allCards.filter((_, i) => items.includes(i)) : allCards;
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${visible.length}, 1fr)` }}>
      {visible.map((c) => (
        <div key={c.label} className="card">
          <KpiCard {...c} />
        </div>
      ))}
    </div>
  );
}
```

`StatsRow2` 同理，包含活跃天、会话数、单次费用、日均、缓存率。

**Step 4: 实现 `ShareEmbed`** — 支持 `items` 过滤

```typescript
// items 索引: 0=厂商占比, 1=模型占比, 2=设备占比
function ShareEmbed({ items, overview, t }: { ... }) {
  const allSections = [
    { key: 'provider', title: t.providerShare, data: ... },
    { key: 'model', title: t.modelShare, data: ... },
    { key: 'device', title: t.deviceShare, data: ... },
  ];
  const visible = items ? allSections.filter((_, i) => items.includes(i)) : allSections;
  return (
    <div className="flex flex-col gap-6">
      {visible.map((s) => (
        <DonutSection key={s.key} title={s.title} data={s.data} ... />
      ))}
    </div>
  );
}
```

**Step 5: 趋势图 embed wrapper** — 无 `items`，直接复用现有组件

每个趋势图 embed wrapper 只需渲染对应 chart 组件 + 可选的 legend，不带 card 外壳（由 embed 容器自身控制样式）。

**Step 6: 构建验证**

```bash
cd /Users/Ethan/Projects/AIUsage && pnpm --filter @aiusage/dashboard build
```

**Step 7: Commit**

```bash
git add packages/dashboard/src/embed/
git commit -m "✨ feat(embed): 实现 EmbedApp 组件与全部 widget 渲染器"
```

---

## Task 5: 修改入口路由分发

**Files:**
- Modify: `packages/dashboard/src/main.tsx`

**Step 1: 根据路径渲染 App 或 EmbedApp**

```typescript
// packages/dashboard/src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app';
import { EmbedApp } from './embed/embed-app';
import './styles.css';

const isEmbed = window.location.pathname.startsWith('/embed');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isEmbed ? <EmbedApp /> : <App />}
  </React.StrictMode>,
);
```

无需 React Router。路径判断在挂载时执行一次即可。

**Step 2: 构建验证**

```bash
cd /Users/Ethan/Projects/AIUsage && pnpm --filter @aiusage/dashboard build
```

**Step 3: Commit**

```bash
git add packages/dashboard/src/main.tsx
git commit -m "✨ feat(embed): 入口路由分发 /embed 至 EmbedApp"
```

---

## Task 6: Embed 样式适配

**Files:**
- Modify: `packages/dashboard/src/styles.css`

**Step 1: 添加 embed 专用样式**

```css
/* Embed mode: 去除 body 默认 margin/padding，支持透明 */
.embed-root {
  padding: 8px;
  min-height: auto;
}

/* 当 transparent=1 时，通过 JS 设置 body 和 html 背景为 transparent */
/* card 在 embed 下也需要适配透明 */
body.embed-transparent .card {
  background: transparent;
  border: 1px solid var(--tw-border-opacity, rgba(148, 163, 184, 0.15));
}
```

**Step 2: Commit**

```bash
git add packages/dashboard/src/styles.css
git commit -m "🎨 style(embed): embed 模式样式适配"
```

---

## Task 7: 端到端验证

**Step 1: 启动 dev server**

```bash
cd /Users/Ethan/Projects/AIUsage && pnpm --filter @aiusage/dashboard dev
```

**Step 2: 验证以下 URL**

- `http://localhost:5173/embed?widget=stats-row1` — 展示全部 5 个指标卡
- `http://localhost:5173/embed?widget=stats-row1&items=0` — 只展示预估费用
- `http://localhost:5173/embed?widget=stats-row1&items=0,2,4` — 展示第 1、3、5 个
- `http://localhost:5173/embed?widget=stats-row2&items=4` — 只展示缓存命中率
- `http://localhost:5173/embed?widget=cost-trend&range=7d` — 7 天费用趋势
- `http://localhost:5173/embed?widget=token-trend` — Token 趋势
- `http://localhost:5173/embed?widget=token-composition` — Token 构成
- `http://localhost:5173/embed?widget=flow` — 桑基图
- `http://localhost:5173/embed?widget=share&items=0,2` — 厂商 + 设备占比
- `http://localhost:5173/embed?widget=cost-trend&theme=dark&transparent=1` — 深色透明
- `http://localhost:5173/embed?widget=stats-row1&locale=zh` — 中文

**Step 3: 验证主 Dashboard 未受影响**

- `http://localhost:5173/` — 正常展示

**Step 4: 构建验证**

```bash
pnpm --filter @aiusage/dashboard build
```

**Step 5: Commit（如有修复）**

---

## Task 8: 更新设计文档

**Files:**
- Modify: `dev/design-docs/technical-design.md` — 更新 14.3 Embed 章节

将设计文档中的 embed 部分更新为实际实现的参数体系，替换原来的 `widget=overview` 等占位描述。

**Step 1: 更新文档**

**Step 2: Commit**

```bash
git add dev/design-docs/technical-design.md
git commit -m "📝 docs: 更新 embed widget 参数体系文档"
```

---

## 依赖关系

```
Task 1 (参数解析) ──┐
                     ├── Task 4 (EmbedApp) ── Task 5 (路由) ── Task 6 (样式) ── Task 7 (验证) ── Task 8 (文档)
Task 2 (hook 提取) ──┤
                     │
Task 3 (组件拆分) ──┘
```

Task 1、2、3 可并行。Task 4 依赖 1+2+3。Task 5-8 串行。
