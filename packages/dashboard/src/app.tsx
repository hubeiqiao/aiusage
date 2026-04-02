import React, { useEffect, useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  Sankey, ResponsiveContainer, XAxis, YAxis, Tooltip
} from 'recharts';
import { RefreshCw, BarChart2, Zap, Calendar, Database, Filter } from 'lucide-react';
import type { OverviewResponse, SankeyGraph } from '@aiusage/shared';
import { Button } from './components/ui/button';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from './components/ui/chart';
import { Select } from './components/ui/select';

const PIE_COLORS = ['#0f172a', '#334155', '#475569', '#64748b', '#94a3b8', '#cbd5e1', '#e2e8f0'];
const TOKEN_SERIES = [
  { key: 'inputTokens', label: 'Input', color: '#64748b' },
  { key: 'cachedInputTokens', label: 'Cached', color: '#94a3b8' },
  { key: 'cacheWriteTokens', label: 'Write', color: '#cbd5e1' },
  { key: 'outputTokens', label: 'Output', color: '#0f172a' },
  { key: 'reasoningOutputTokens', label: 'Reasoning', color: '#334155' },
] as const;
const RANGE_OPTIONS = [
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: '90d', label: 'Last 90 Days' },
  { value: 'all', label: 'All Time' },
];

const COST_CHART_CONFIG = { estimatedCostUsd: { label: 'Cost', color: '#0f172a' } } satisfies ChartConfig;
const TOKEN_CHART_CONFIG = Object.fromEntries(TOKEN_SERIES.map((s) => [s.key, { label: s.label, color: s.color }])) satisfies ChartConfig;

type RangeValue = '7d' | '30d' | '90d' | 'all';

interface FacetOption { value: string; label: string; }
interface OverviewPayload extends OverviewResponse { ok: boolean; }
interface BreakdownRow {
  device_id: string; usage_date: string; provider: string; product: string; channel: string;
  model: string; project: string; event_count: number; input_tokens: number;
  cached_input_tokens: number; cache_write_tokens: number; output_tokens: number;
  reasoning_output_tokens: number; total_tokens: number; estimated_cost_usd: number;
}
interface BreakdownPayload {
  ok: boolean; data: BreakdownRow[]; sort: string; order: string;
  pagination: { total: number; limit: number; offset: number; hasMore: boolean; };
}
interface HealthPayload { ok: boolean; siteId: string; version: string; }
interface FiltersState { range: string; deviceId: string; provider: string; product: string; channel: string; model: string; }
interface TableState { offset: number; limit: number; sort: string; order: 'asc' | 'desc'; }

class ChartBoundary extends React.Component<{ children: React.ReactNode; title: string }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode; title: string }) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: unknown) { console.error(`${this.props.title} crashed`, error); }
  render() {
    if (this.state.hasError) return <ChartEmpty label={`${this.props.title} Error`} danger />;
    return this.props.children;
  }
}

function fetchJson<T>(url: string): Promise<T> {
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<T>;
  });
}

function formatUsd(value: number): string { return `$${Number(value || 0).toFixed(4)}`; }
function formatUsdCompact(value: number): string {
  const amount = Number(value || 0);
  if (amount >= 1000) return `$${amount.toFixed(0)}`;
  if (amount >= 100) return `$${amount.toFixed(1)}`;
  if (amount >= 10) return `$${amount.toFixed(1)}`;
  return `$${amount.toFixed(2)}`;
}
function formatNumber(value: number): string { return new Intl.NumberFormat('en-US').format(Number(value || 0)); }
function shortDate(value: string): string { return value.slice(5); }
function longDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function buildQuery(filters: FiltersState): string {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
  return params.toString();
}

function buildBreakdownQuery(filters: FiltersState, table: TableState): string {
  const params = new URLSearchParams(buildQuery(filters));
  params.set('limit', String(table.limit)); params.set('offset', String(table.offset));
  params.set('sort', table.sort); params.set('order', table.order);
  return params.toString();
}

function sum(values: number[]): number { return values.reduce((total, value) => total + Number(value || 0), 0); }

function foldItems<T extends { estimatedCostUsd: number; label: string; value: string }>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const head = items.slice(0, limit - 1);
  const tail = items.slice(limit - 1);
  const other = tail.reduce((acc, item) => ({ ...acc, estimatedCostUsd: acc.estimatedCostUsd + Number(item.estimatedCostUsd || 0) }), { ...tail[0], value: 'other', label: 'Other', estimatedCostUsd: 0 });
  return [...head, other];
}

function transformSankey(input?: SankeyGraph) {
  if (!input || !input.nodes.length || !input.links.length) return null;
  const nodes = input.nodes.map(n => ({ name: n.label || n.id }));
  const idToIndex = new Map(input.nodes.map((n, i) => [n.id, i]));
  const links = input.links
    .map(l => ({ source: idToIndex.get(l.source), target: idToIndex.get(l.target), value: Number(l.value || 0) }))
    .filter((l): l is { source: number; target: number; value: number } => l.source !== undefined && l.target !== undefined && l.value > 0);
  if (!links.length) return null;
  return { nodes, links };
}

function ChartEmpty({ label, danger = false }: { label: string; danger?: boolean }) {
  return <div className={`grid min-h-[220px] place-items-center text-sm ${danger ? 'text-red-500' : 'text-slate-400'}`}>{label}</div>;
}

function SimpleKpiCard({ label, value, icon: Icon }: { label: string; value: string; icon: React.ElementType }) {
  return (
    <div className="minimal-card p-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-slate-500">{label}</div>
        <Icon className="h-4 w-4 text-slate-400" />
      </div>
      <div className="mt-2 text-3xl font-bold tracking-tight text-slate-900 tabular-nums">
        {value}
      </div>
    </div>
  );
}

function MinimalSelect({ value, options, onChange, placeholder }: { value: string; options: FacetOption[]; onChange: (v: string) => void; placeholder: string; }) {
  return (
    <select
      className="h-9 min-w-[120px] rounded-md border border-slate-200 bg-white px-3 py-1 text-sm shadow-sm transition-colors focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400/20"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}

function CostChart({ data }: { data: OverviewPayload['dailyTrend'] }) {
  if (!data.length) return <ChartEmpty label="No data" />;
  return (
    <ChartContainer config={COST_CHART_CONFIG} className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, left: 10, right: 10, bottom: 0 }}>
          <defs>
            <linearGradient id="cost-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#0f172a" stopOpacity={0.2} />
              <stop offset="95%" stopColor="#0f172a" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="#e2e8f0" strokeDasharray="4 4" />
          <XAxis dataKey="usageDate" tickLine={false} axisLine={false} tickMargin={10} tickFormatter={shortDate} minTickGap={24} stroke="#64748b" fontSize={12} />
          <YAxis tickLine={false} axisLine={false} width={48} tickMargin={10} tickFormatter={(v) => formatUsdCompact(Number(v))} stroke="#64748b" fontSize={12} />
          <ChartTooltip cursor={{ stroke: '#cbd5e1' }} content={<ChartTooltipContent indicator="line" labelFormatter={longDate} formatter={(v) => formatUsd(Number(v))} />} />
          <Area dataKey="estimatedCostUsd" type="monotone" fill="url(#cost-gradient)" fillOpacity={1} stroke="#0f172a" strokeWidth={2} activeDot={{ r: 4, strokeWidth: 0, fill: '#0f172a' }} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
}

function MixChart({ data, title }: { data: Array<{ label: string; value: string; estimatedCostUsd: number }>; title: string; }) {
  const folded = foldItems(data, 6);
  const total = sum(folded.map((item) => item.estimatedCostUsd));
  if (!folded.length) return <ChartEmpty label="No data" />;

  return (
    <div className="flex flex-col h-full gap-6 xl:flex-row xl:items-center">
      <ChartContainer config={{}} className="h-[180px] w-full shrink-0 xl:w-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={folded} dataKey="estimatedCostUsd" nameKey="label" innerRadius={60} outerRadius={80} paddingAngle={2} stroke="none">
              {folded.map((item, idx) => <Cell key={`${title}-${item.value}`} fill={PIE_COLORS[idx % PIE_COLORS.length]} />)}
            </Pie>
            <ChartTooltip content={<ChartTooltipContent formatter={(v) => formatUsd(Number(v))} />} />
          </PieChart>
        </ResponsiveContainer>
      </ChartContainer>
      <div className="flex w-full flex-col gap-3">
        {folded.map((item, idx) => (
          <div key={`${title}-${item.value}`} className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2 overflow-hidden">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: PIE_COLORS[idx % PIE_COLORS.length] }} />
              <span className="truncate font-medium text-slate-700">{item.label}</span>
            </div>
            <div className="text-right ml-4">
              <span className="font-mono text-slate-900 tabular-nums">{formatUsd(item.estimatedCostUsd)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlowChart({ data }: { data: SankeyGraph | undefined }) {
  const sankeyData = transformSankey(data);
  if (!sankeyData) return <ChartEmpty label="No data" />;
  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <Sankey
          data={sankeyData}
          nodePadding={40}
          margin={{ left: 10, right: 10, top: 10, bottom: 10 }}
          link={{ stroke: '#cbd5e1', strokeOpacity: 0.5, fill: 'none' }}
          node={{ fill: '#0f172a', stroke: '#0f172a', strokeWidth: 1 }}
        >
          <Tooltip wrapperClassName="minimal-card !border-slate-200 !bg-white !rounded-md" cursor={false}/>
        </Sankey>
      </ResponsiveContainer>
    </div>
  );
}

function TokensChart({ data }: { data: OverviewPayload['tokenComposition'] }) {
  if (!data.length) return <ChartEmpty label="No data" />;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-4">
        {TOKEN_SERIES.map((series) => (
          <div key={series.key} className="flex items-center gap-2 text-sm">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: series.color }} />
            <span className="font-medium text-slate-700">{series.label}</span>
            <span className="font-mono text-slate-500 tabular-nums ml-1">
              {formatNumber(sum(data.map((row) => Number(row[series.key] || 0))))}
            </span>
          </div>
        ))}
      </div>
      <ChartContainer config={TOKEN_CHART_CONFIG} className="h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 0, left: 0, right: 0, bottom: 0 }} barSize={16}>
            <CartesianGrid vertical={false} stroke="#e2e8f0" strokeDasharray="4 4" />
            <XAxis dataKey="usageDate" tickLine={false} axisLine={false} tickMargin={10} tickFormatter={shortDate} minTickGap={24} stroke="#64748b" fontSize={12} />
            <YAxis tickLine={false} axisLine={false} width={52} tickMargin={10} tickFormatter={(v) => formatNumber(Math.round(Number(v)))} stroke="#64748b" fontSize={12} />
            <ChartTooltip cursor={{fill: '#f1f5f9'}} content={<ChartTooltipContent labelFormatter={longDate} formatter={(v) => formatNumber(Number(v))} />} />
            {TOKEN_SERIES.map((series, i) => (
              <Bar key={series.key} dataKey={series.key} name={series.label} stackId="tokens" fill={series.color} radius={i === TOKEN_SERIES.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartContainer>
    </div>
  );
}

function RecordsTable({ rows, pagination, onPrev, onNext }: { rows: BreakdownRow[]; pagination: BreakdownPayload['pagination']; onPrev: () => void; onNext: () => void; }) {
  if (!rows.length) return <ChartEmpty label="No records found" />;
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              {['Date', 'Device', 'Provider', 'Product', 'Channel', 'Model', 'Project', 'Events', 'Input', 'Output', 'Tokens', 'Cost'].map(label => (
                <th key={label} className="whitespace-nowrap px-4 py-3 font-medium text-slate-500">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, i) => (
              <tr key={`${row.usage_date}-${row.model}-${row.project}-${i}`} className="hover:bg-slate-50 transition-colors">
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-500">{row.usage_date}</td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-500">{row.device_id}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-700">{row.provider}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-700">{row.product}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-700">{row.channel}</td>
                <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900">{row.model}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-700">{row.project}</td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-600 tabular-nums">{formatNumber(row.event_count)}</td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-600 tabular-nums">{formatNumber(sum([row.input_tokens, row.cached_input_tokens, row.cache_write_tokens]))}</td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-600 tabular-nums">{formatNumber(sum([row.output_tokens, row.reasoning_output_tokens]))}</td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-600 tabular-nums">{formatNumber(row.total_tokens)}</td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-sm font-semibold text-slate-900 tabular-nums">{formatUsd(row.estimated_cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex items-center justify-between px-2">
        <div className="text-sm text-slate-500">
          Showing {pagination.offset + 1}-{Math.min(pagination.offset + pagination.limit, pagination.total)} of {formatNumber(pagination.total)}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" className="shadow-sm" disabled={pagination.offset <= 0} onClick={onPrev}>Prev</Button>
          <Button variant="ghost" className="shadow-sm" disabled={!pagination.hasMore} onClick={onNext}>Next</Button>
        </div>
      </div>
    </>
  );
}

export function App() {
  const [filters, setFilters] = useState<FiltersState>({ range: '30d', deviceId: '', provider: '', product: '', channel: '', model: '' });
  const [table, setTable] = useState<TableState>({ offset: 0, limit: 15, sort: 'estimated_cost_usd', order: 'desc' });
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [breakdowns, setBreakdowns] = useState<BreakdownPayload | null>(null);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError(null);
      try {
        const [overviewResult, breakdownResult, healthResult] = await Promise.all([
          fetchJson<OverviewPayload>(`/api/v1/public/overview?${buildQuery(filters)}`),
          fetchJson<BreakdownPayload>(`/api/v1/public/breakdowns?${buildBreakdownQuery(filters, table)}`),
          fetchJson<HealthPayload>('/api/v1/health').catch(() => ({ ok: false, siteId: 'unknown', version: 'unknown' })),
        ]);
        if (cancelled) return;
        setOverview(overviewResult); setBreakdowns(breakdownResult); setHealth(healthResult);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [filters, table.offset, table.sort, table.order, refreshKey]);

  const fOpts = useMemo(() => {
    const opts = overview?.filters.options;
    return {
      devices: opts?.devices ?? [], providers: opts?.providers ?? [],
      products: opts?.products ?? [], channels: opts?.channels ?? [], models: opts?.models ?? []
    };
  }, [overview]);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 min-h-screen">
      
      {/* Header */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between animate-fade-in">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 border-none m-0 shadow-none">AI Usage</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm shadow-sm text-slate-600">
            <span className={`h-2 w-2 rounded-full ${health?.ok ? 'bg-green-500' : 'bg-slate-400'}`} />
            {health?.ok ? health.siteId : 'Loading'}
          </div>
          <Button variant="ghost" onClick={() => setRefreshKey(v => v + 1)} className="shadow-sm">
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="mb-8 flex flex-wrap items-center gap-3 animate-fade-in delay-100">
        <span className="flex text-sm font-medium text-slate-500"><Filter className="mr-2 h-4 w-4"/>Filter by</span>
        <MinimalSelect value={filters.range} placeholder="Time Range" options={RANGE_OPTIONS} onChange={v => setFilters(f => ({ ...f, range: v }))} />
        <MinimalSelect value={filters.deviceId} placeholder="Device" options={fOpts.devices} onChange={v => setFilters(f => ({ ...f, deviceId: v }))} />
        <MinimalSelect value={filters.provider} placeholder="Provider" options={fOpts.providers} onChange={v => setFilters(f => ({ ...f, provider: v }))} />
        <MinimalSelect value={filters.product} placeholder="Product" options={fOpts.products} onChange={v => setFilters(f => ({ ...f, product: v }))} />
        <MinimalSelect value={filters.model} placeholder="Model" options={fOpts.models} onChange={v => setFilters(f => ({ ...f, model: v }))} />
      </div>

      {loading && !overview ? (
        <div className="flex justify-center py-12"><div className="h-8 w-8 animate-spin rounded-full border-b-2 border-t-2 border-slate-900" /></div>
      ) : error ? (
        <div className="minimal-card flex h-64 flex-col items-center justify-center p-8 text-center text-red-600">
          <Database className="h-8 w-8 mb-3 opacity-50" />
          <div className="text-sm font-medium">{error}</div>
        </div>
      ) : (
        <div className="grid gap-6">
          
          {/* KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
            <SimpleKpiCard label="Cost" value={formatUsd(overview?.totalCostUsd ?? 0)} icon={BarChart2} />
            <SimpleKpiCard label="Events" value={formatNumber(overview?.totalEvents ?? 0)} icon={Zap} />
            <SimpleKpiCard label="Days" value={formatNumber(overview?.activeDays ?? 0)} icon={Calendar} />
            <SimpleKpiCard label="Avg / Day" value={formatUsd(overview?.averageDailyCostUsd ?? 0)} icon={BarChart2} />
          </div>

          {/* Cost Chart */}
          <div className="minimal-card p-6 animate-fade-in delay-100">
            <h2 className="mb-6 text-lg font-semibold tracking-tight text-slate-900">Cost Trend</h2>
            <ChartBoundary title="Cost">
              <CostChart data={overview?.dailyTrend ?? []} />
            </ChartBoundary>
          </div>

          {/* Model / Flow Row */}
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="minimal-card p-6 lg:col-span-1 animate-fade-in delay-200">
              <h2 className="mb-6 text-lg font-semibold tracking-tight text-slate-900">Model Proportions</h2>
              <ChartBoundary title="Model mix">
                <MixChart data={overview?.modelCostShare ?? []} title="model" />
              </ChartBoundary>
            </div>
            <div className="minimal-card p-6 lg:col-span-2 animate-fade-in delay-200">
              <h2 className="mb-6 text-lg font-semibold tracking-tight text-slate-900">Token Flow</h2>
              <ChartBoundary title="Flow">
                <FlowChart data={overview?.sankey} />
              </ChartBoundary>
            </div>
          </div>

          {/* Tokens Stacked Bar */}
          <div className="minimal-card p-6 animate-fade-in delay-300">
            <h2 className="mb-6 text-lg font-semibold tracking-tight text-slate-900">Token Composition</h2>
            <ChartBoundary title="Tokens">
              <TokensChart data={overview?.tokenComposition ?? []} />
            </ChartBoundary>
          </div>

          {/* Table */}
          <div className="minimal-card p-6 animate-fade-in delay-300">
            <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">Records</h2>
              <div className="flex gap-2">
                <Select value={table.sort} onChange={(e) => setTable(t => ({ ...t, sort: e.target.value, offset: 0 }))}>
                  <option value="estimated_cost_usd">Sort by Cost</option>
                  <option value="event_count">Sort by Events</option>
                  <option value="total_tokens">Sort by Tokens</option>
                  <option value="usage_date">Sort by Date</option>
                </Select>
                <Button variant="ghost" onClick={() => setTable(t => ({ ...t, order: t.order === 'desc' ? 'asc' : 'desc', offset: 0 }))} className="shadow-sm w-9 px-0">
                  {table.order === 'desc' ? '↓' : '↑'}
                </Button>
              </div>
            </div>
            <ChartBoundary title="Records">
              <RecordsTable
                rows={breakdowns?.data ?? []}
                pagination={breakdowns?.pagination ?? { total: 0, limit: table.limit, offset: table.offset, hasMore: false }}
                onPrev={() => setTable(t => ({ ...t, offset: Math.max(0, t.offset - t.limit) }))}
                onNext={() => setTable(t => ({ ...t, offset: t.offset + t.limit }))}
              />
            </ChartBoundary>
          </div>

        </div>
      )}
    </main>
  );
}
