import type { Env } from '../types.js';

export function handleHome(_env: Env): Response {
  return new Response(renderHomePage(), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function renderHomePage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AIUsage Dashboard</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f7fb;
        --panel: #ffffff;
        --text: #11203a;
        --muted: #60708a;
        --line: #d9e1ec;
        --accent: #1166ee;
        --accent-soft: #eaf2ff;
        --success: #0b7a43;
        --shadow: 0 18px 40px rgba(17, 32, 58, 0.08);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
        background:
          radial-gradient(circle at top right, rgba(17, 102, 238, 0.08), transparent 28%),
          linear-gradient(180deg, #f8fbff 0%, var(--bg) 100%);
        color: var(--text);
      }

      .wrap {
        max-width: 1120px;
        margin: 0 auto;
        padding: 32px 20px 56px;
      }

      .hero {
        display: flex;
        gap: 16px;
        align-items: end;
        justify-content: space-between;
        margin-bottom: 24px;
      }

      .hero h1 {
        margin: 0;
        font-size: clamp(28px, 5vw, 42px);
        line-height: 1;
        letter-spacing: -0.03em;
      }

      .hero p {
        margin: 10px 0 0;
        color: var(--muted);
      }

      .toolbar {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }

      select, button, .link-btn {
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.92);
        color: var(--text);
        border-radius: 12px;
        padding: 10px 14px;
        font: inherit;
      }

      button, .link-btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
        cursor: pointer;
      }

      .link-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-decoration: none;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
        margin-bottom: 24px;
      }

      .card, .panel {
        background: rgba(255, 255, 255, 0.88);
        border: 1px solid rgba(217, 225, 236, 0.88);
        border-radius: 20px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(14px);
      }

      .card {
        padding: 18px;
      }

      .label {
        color: var(--muted);
        font-size: 13px;
      }

      .value {
        margin-top: 8px;
        font-size: clamp(24px, 4vw, 34px);
        font-weight: 700;
        letter-spacing: -0.03em;
      }

      .subvalue {
        margin-top: 6px;
        font-size: 13px;
        color: var(--muted);
      }

      .layout {
        display: grid;
        grid-template-columns: 1.05fr 1.35fr;
        gap: 16px;
      }

      .panel {
        padding: 20px;
      }

      .panel h2 {
        margin: 0 0 14px;
        font-size: 18px;
      }

      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 13px;
        font-weight: 600;
      }

      .status.ok {
        background: rgba(11, 122, 67, 0.12);
        color: var(--success);
      }

      .trend {
        display: grid;
        gap: 10px;
      }

      .trend-row {
        display: grid;
        grid-template-columns: 92px 1fr auto auto;
        gap: 10px;
        align-items: center;
        font-size: 13px;
      }

      .bar {
        height: 10px;
        border-radius: 999px;
        background: #e9eff8;
        overflow: hidden;
      }

      .bar > span {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, #67a0ff 0%, #1166ee 100%);
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }

      th, td {
        text-align: left;
        padding: 12px 10px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
      }

      th {
        color: var(--muted);
        font-weight: 600;
      }

      .mono {
        font-family: ui-monospace, "SFMono-Regular", monospace;
      }

      .empty, .error {
        color: var(--muted);
        padding: 16px 0;
      }

      .error {
        color: #b42318;
      }

      @media (max-width: 920px) {
        .grid, .layout {
          grid-template-columns: 1fr;
        }

        .trend-row {
          grid-template-columns: 78px 1fr;
        }

        .trend-row .metric {
          grid-column: span 2;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <section class="hero">
        <div>
          <h1>AIUsage</h1>
          <p>一个 Worker，同时承载公开汇总页与 API。</p>
        </div>
        <div class="toolbar">
          <select id="range">
            <option value="7d">最近 7 天</option>
            <option value="3m">最近 3 个月</option>
            <option value="all">全部</option>
          </select>
          <a class="link-btn" href="/pricing">Pricing</a>
          <button id="refresh">刷新</button>
        </div>
      </section>

      <section class="grid" id="summary">
        <article class="card"><div class="label">总天数</div><div class="value">-</div></article>
        <article class="card"><div class="label">总事件数</div><div class="value">-</div></article>
        <article class="card"><div class="label">总成本</div><div class="value">-</div></article>
        <article class="card"><div class="label">服务状态</div><div class="value">-</div></article>
      </section>

      <section class="layout">
        <article class="panel">
          <h2>趋势</h2>
          <div id="trend" class="trend">
            <div class="empty">加载中...</div>
          </div>
        </article>

        <article class="panel">
          <h2>明细 Top 20</h2>
          <div id="table-wrap">
            <div class="empty">加载中...</div>
          </div>
        </article>
      </section>
    </div>

    <script>
      const rangeEl = document.getElementById('range');
      const refreshEl = document.getElementById('refresh');
      const summaryEl = document.getElementById('summary');
      const trendEl = document.getElementById('trend');
      const tableWrapEl = document.getElementById('table-wrap');

      async function load() {
        const range = rangeEl.value;
        setLoading();

        try {
          const [health, overview, breakdowns] = await Promise.all([
            fetchJson('/api/v1/health'),
            fetchJson('/api/v1/public/overview?range=' + encodeURIComponent(range)),
            fetchJson('/api/v1/public/breakdowns?range=' + encodeURIComponent(range) + '&limit=20'),
          ]);

          renderSummary(health, overview);
          renderTrend(overview.dailyTrend || []);
          renderTable(breakdowns.data || []);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          trendEl.innerHTML = '<div class="error">取数失败：' + escapeHtml(message) + '</div>';
          tableWrapEl.innerHTML = '<div class="error">取数失败：' + escapeHtml(message) + '</div>';
        }
      }

      function setLoading() {
        trendEl.innerHTML = '<div class="empty">加载中...</div>';
        tableWrapEl.innerHTML = '<div class="empty">加载中...</div>';
      }

      function renderSummary(health, overview) {
        const cards = [
          { label: '总天数', value: number(overview.totalDays), subvalue: 'range=' + rangeEl.value },
          { label: '总事件数', value: number(overview.totalEvents), subvalue: '所有设备汇总' },
          { label: '总成本', value: usd(overview.totalCostUsd), subvalue: '公开接口聚合结果' },
          { label: '服务状态', value: '<span class="status ok">正常</span>', subvalue: escapeHtml(health.siteId + ' · v' + health.version) },
        ];

        summaryEl.innerHTML = cards.map(card => (
          '<article class="card">' +
            '<div class="label">' + card.label + '</div>' +
            '<div class="value">' + card.value + '</div>' +
            '<div class="subvalue">' + card.subvalue + '</div>' +
          '</article>'
        )).join('');
      }

      function renderTrend(items) {
        if (!items.length) {
          trendEl.innerHTML = '<div class="empty">暂无趋势数据</div>';
          return;
        }

        const maxCost = Math.max(...items.map(item => Number(item.estimatedCostUsd || 0)), 1);
        trendEl.innerHTML = items.map(item => {
          const width = Math.max(6, Math.round((Number(item.estimatedCostUsd || 0) / maxCost) * 100));
          return (
            '<div class="trend-row">' +
              '<div class="mono">' + escapeHtml(item.usageDate) + '</div>' +
              '<div class="bar metric"><span style="width:' + width + '%"></span></div>' +
              '<div>' + number(item.eventCount) + ' 次</div>' +
              '<div>' + usd(item.estimatedCostUsd) + '</div>' +
            '</div>'
          );
        }).join('');
      }

      function renderTable(rows) {
        if (!rows.length) {
          tableWrapEl.innerHTML = '<div class="empty">暂无明细数据</div>';
          return;
        }

        tableWrapEl.innerHTML =
          '<table>' +
            '<thead><tr><th>日期</th><th>来源</th><th>模型</th><th>项目</th><th>事件</th><th>成本</th></tr></thead>' +
            '<tbody>' +
              rows.map(row => (
                '<tr>' +
                  '<td class="mono">' + escapeHtml(row.usage_date) + '</td>' +
                  '<td>' + escapeHtml(row.provider + ' / ' + row.product) + '</td>' +
                  '<td>' + escapeHtml(row.model) + '</td>' +
                  '<td>' + escapeHtml(row.project) + '</td>' +
                  '<td>' + number(row.event_count) + '</td>' +
                  '<td>' + usd(row.estimated_cost_usd) + '</td>' +
                '</tr>'
              )).join('') +
            '</tbody>' +
          '</table>';
      }

      async function fetchJson(url) {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }
        return response.json();
      }

      function number(value) {
        return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
      }

      function usd(value) {
        return '$' + Number(value || 0).toFixed(4);
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      rangeEl.addEventListener('change', load);
      refreshEl.addEventListener('click', load);
      load();
    </script>
  </body>
</html>`;
}
