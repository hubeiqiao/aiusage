import { getPricingCatalog, type ModelPricing } from '../utils/pricing.js';
import type { Env } from '../types.js';

export function handlePricing(_env: Env): Response {
  return new Response(renderPricingPage(), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function renderPricingPage(): string {
  const catalog = getPricingCatalog();
  const providerSections = Object.entries(catalog.providers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, products]) => {
      const productCards = Object.entries(products)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([product, definition]) => {
          const rows = Object.entries(definition.models)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([model, pricing]) => renderModelRow(model, pricing))
            .join('');

          return `
            <article class="product-card">
              <div class="product-head">
                <div>
                  <div class="eyebrow">产品</div>
                  <h3>${escapeHtml(product)}</h3>
                </div>
                <span class="pill">${Object.keys(definition.models).length} 个模型</span>
              </div>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>输入</th>
                      <th>缓存命中</th>
                      <th>缓存写入 5m</th>
                      <th>缓存写入 1h</th>
                      <th>输出</th>
                    </tr>
                  </thead>
                  <tbody>${rows}</tbody>
                </table>
              </div>
            </article>
          `;
        })
        .join('');

      return `
        <section class="provider-section">
          <div class="provider-head">
            <div>
              <div class="eyebrow">厂商</div>
              <h2>${escapeHtml(provider)}</h2>
            </div>
            <span class="pill">${Object.keys(products).length} 个产品线</span>
          </div>
          <div class="product-grid">${productCards}</div>
        </section>
      `;
    })
    .join('');

  const aliasRows = Object.entries(catalog.aliases)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([source, target]) => `
        <tr>
          <td class="mono">${escapeHtml(source)}</td>
          <td class="mono">${escapeHtml(target)}</td>
        </tr>
      `,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AIUsage Pricing</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f7fb;
        --panel: rgba(255, 255, 255, 0.9);
        --text: #11203a;
        --muted: #60708a;
        --line: #d9e1ec;
        --accent: #1166ee;
        --accent-soft: #eaf2ff;
        --shadow: 0 18px 40px rgba(17, 32, 58, 0.08);
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        font-family: "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(17, 102, 238, 0.08), transparent 24%),
          linear-gradient(180deg, #f8fbff 0%, var(--bg) 100%);
        color: var(--text);
      }

      .wrap {
        max-width: 1200px;
        margin: 0 auto;
        padding: 32px 20px 56px;
      }

      .hero {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 24px;
      }

      .hero h1 {
        margin: 0;
        font-size: clamp(30px, 5vw, 44px);
        line-height: 1;
        letter-spacing: -0.03em;
      }

      .hero p {
        margin: 12px 0 0;
        color: var(--muted);
      }

      .hero-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }

      .link-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        padding: 0 14px;
        border-radius: 12px;
        border: 1px solid var(--line);
        text-decoration: none;
        color: var(--text);
        background: rgba(255, 255, 255, 0.92);
      }

      .link-btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
        margin-bottom: 24px;
      }

      .card, .provider-section, .aliases {
        background: var(--panel);
        border: 1px solid rgba(217, 225, 236, 0.88);
        border-radius: 20px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(14px);
      }

      .card {
        padding: 18px;
      }

      .label, .eyebrow {
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

      .provider-section {
        padding: 20px;
        margin-bottom: 18px;
      }

      .provider-head, .product-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 16px;
      }

      .provider-head h2, .product-head h3 {
        margin: 4px 0 0;
        font-size: 24px;
      }

      .product-grid {
        display: grid;
        gap: 14px;
      }

      .product-card {
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 18px;
        background: rgba(248, 251, 255, 0.85);
      }

      .pill {
        display: inline-flex;
        align-items: center;
        min-height: 32px;
        padding: 0 12px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 13px;
        font-weight: 600;
        white-space: nowrap;
      }

      .table-wrap {
        overflow-x: auto;
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

      tbody tr:last-child td {
        border-bottom: 0;
      }

      .mono {
        font-family: ui-monospace, "SFMono-Regular", monospace;
      }

      .aliases {
        padding: 20px;
      }

      .aliases h2 {
        margin: 0 0 14px;
        font-size: 20px;
      }

      @media (max-width: 920px) {
        .hero, .provider-head, .product-head {
          align-items: start;
          flex-direction: column;
        }

        .stats {
          grid-template-columns: 1fr 1fr;
        }
      }

      @media (max-width: 640px) {
        .stats {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <section class="hero">
        <div>
          <h1>Pricing</h1>
          <p>展示 Worker 当前内置的定价目录，按厂商和产品线归类。</p>
        </div>
        <div class="hero-actions">
          <a class="link-btn" href="/">返回概览</a>
          <a class="link-btn primary" href="/api/v1/health">Health</a>
        </div>
      </section>

      <section class="stats">
        <article class="card">
          <div class="label">定价版本</div>
          <div class="value">${escapeHtml(catalog.version)}</div>
          <div class="subvalue">当前 Worker 内置目录</div>
        </article>
        <article class="card">
          <div class="label">厂商数</div>
          <div class="value">${Object.keys(catalog.providers).length}</div>
          <div class="subvalue">按 provider 分组</div>
        </article>
        <article class="card">
          <div class="label">产品线数</div>
          <div class="value">${countProducts(catalog.providers)}</div>
          <div class="subvalue">按 product 分类</div>
        </article>
        <article class="card">
          <div class="label">模型数</div>
          <div class="value">${countModels(catalog.providers)}</div>
          <div class="subvalue">全部可计费模型</div>
        </article>
      </section>

      ${providerSections}

      <section class="aliases">
        <div class="provider-head">
          <div>
            <div class="eyebrow">映射</div>
            <h2>模型别名</h2>
          </div>
          <span class="pill">${Object.keys(catalog.aliases).length} 条 alias</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>原始模型名</th>
                <th>归一化模型名</th>
              </tr>
            </thead>
            <tbody>${aliasRows}</tbody>
          </table>
        </div>
      </section>
    </div>
  </body>
</html>`;
}

function renderModelRow(model: string, pricing: ModelPricing): string {
  return `
    <tr>
      <td class="mono">${escapeHtml(model)}</td>
      <td>${usdPerMillion(pricing.input_per_million_usd)}</td>
      <td>${usdPerMillion(pricing.cached_input_per_million_usd)}</td>
      <td>${usdPerMillion(pricing.cache_write_5m_per_million_usd)}</td>
      <td>${usdPerMillion(pricing.cache_write_1h_per_million_usd)}</td>
      <td>${usdPerMillion(pricing.output_per_million_usd)}</td>
    </tr>
  `;
}

function countProducts(providers: Record<string, Record<string, { models: Record<string, ModelPricing> }>>): number {
  return Object.values(providers).reduce((sum, products) => sum + Object.keys(products).length, 0);
}

function countModels(providers: Record<string, Record<string, { models: Record<string, ModelPricing> }>>): number {
  return Object.values(providers).reduce(
    (sum, products) =>
      sum +
      Object.values(products).reduce((innerSum, product) => innerSum + Object.keys(product.models).length, 0),
    0,
  );
}

function usdPerMillion(value: number | null): string {
  if (value === null) return '-';
  return `$${value.toFixed(4)} / 1M`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
