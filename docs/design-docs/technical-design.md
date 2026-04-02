# AIUsage 技术方案 v1

## 1. 目标

将当前本地统计脚本产品化为一个可开源、可自动上报、可公网展示的系统。
架构采用：Node.js + TypeScript Monorepo

核心约束：

- 以 `device_id + usage_date` 作为唯一统计单元
- 默认不统计当天，只统计本地时区当天 `00:00` 之前的闭合日
- 支持 Claude / Codex
- 支持项目 / 模型 / 厂商 / 设备维度统计
- 默认公开展示，但敏感项目名必须可隐藏

## 2. 最终架构

第一版只保留 3 个核心组件：

- 云端：`单 Cloudflare Worker`
- 数据库：`Cloudflare D1`
- 本地：`controller`

其中：

- Worker 同时承载：
  - 前端静态页
  - 公开只读 API
  - 设备接口
- D1 存日汇总与 breakdown
- controller 负责本地采集、enroll、sync、定时任务

用户视角只暴露 2 个概念：

- 云端站点
- 本地采集器

不要求用户理解 Worker / D1 的区别。

### 2.1 D1 容量预估

按 3 台设备、每台每天产生约 20 条 breakdown 估算：

- 每日新增：~60 行 breakdown + 3 行 daily_usage
- 每月新增：~1,900 行
- 每年新增：~23,000 行
- 单行约 500 字节，年增量约 12 MB

D1 免费层 500 MB，付费层 5 GB，足以支撑多年使用。若设备数或维度组合显著增长，可考虑按月归档历史 breakdown。

## 3. 信任模型

第一版采用单租户模型：

- 一次部署出来的一整套服务，就是一个独立项目
- 一个项目对应一套独立的：
  - Worker
  - D1
  - secrets
  - 公开站点 URL

项目归属通过 `SITE_ID` 标识。

规则：

- `SITE_ID` 在 `setup cloudflare` 时生成
- Worker 启动时加载 `SITE_ID`
- controller enroll 后持久化 `SITE_ID`
- enroll / ingest 请求都带 `SITE_ID`
- 服务端校验 token 与请求体中的 `SITE_ID` 一致

## 4. 采集与同步

### 4.1 运行原则

- 每次只处理闭合日
- 默认每天本地时间 `00:10` 自动同步
- 每次回补最近 `7` 个闭合日
- 服务端按 `device_id + usage_date` 幂等覆盖

### 4.2 设备注册

不使用全局上传 token，采用两段式：

1. 部署时生成 `ENROLL_TOKEN`
2. 新设备执行 `enroll`
3. 服务端签发该设备专属 `DEVICE_TOKEN`
4. 以后只用 `DEVICE_TOKEN` 上传

这样可以：

- 单独停用某台设备
- 单独轮换某台设备 token
- 一台机器泄露不影响其他机器

### 4.3 DEVICE_TOKEN 格式

采用 HMAC 签名的 opaque token：

- payload：`siteId + deviceId + token_version + issued_at`
- 签名密钥：`DEVICE_TOKEN_SECRET`
- 输出格式：`dtok_<base64url(payload.signature)>`

校验时 Server 重算签名即可，无需查库。`token_version` 变更时旧 token 自然失效。

### 4.4 ENROLL_TOKEN 安全控制

- 支持轮换：执行 `wrangler secret put ENROLL_TOKEN` 即可使旧 token 失效
- 配置 `MAX_DEVICES`（默认 10），超限拒绝 enroll
- 部署者可在全部设备 enroll 后删除 `ENROLL_TOKEN` 以关闭注册入口

### 4.5 本地配置

建议路径：

- macOS / Linux：`~/.aiusage/config.json`

包含：

- `siteId`
- `apiBaseUrl`
- `deviceId`
- `deviceAlias`
- `deviceToken`
- `lookbackDays`
- `projectAliases`
- `lastSuccessfulUploadAt`

规则：

- `ENROLL_TOKEN` 默认不落盘
- `deviceToken` 仅保存在本机

## 5. 数据模型

### 5.1 统计维度

每条聚合明细至少包含：

- `usage_date`
- `device_id`
- `provider`
- `product`
- `channel`
- `model`
- `project`

`channel` 枚举值：

- `cli`：命令行工具（Claude Code、Codex CLI）
- `ide`：编辑器集成（VS Code 插件等）
- `web`：网页端
- `api`：直接 API 调用

第一版仅支持 `cli`，其余预留。

### 5.2 统计指标

- `event_count`
- `input_tokens`
- `cached_input_tokens`
- `cache_write_tokens`
- `output_tokens`
- `reasoning_output_tokens`
- `estimated_cost_usd`
- `cost_status`

说明：

- `cached_input_tokens` 统一表示"从缓存读取的输入 token"，覆盖 Anthropic 的 `cache_read_input_tokens` 和 OpenAI 的 `cached_tokens`
- `cache_write_tokens` 表示"写入缓存的 token"，仅 Anthropic 有此概念，OpenAI 填 0
- Claude 的 5m / 1h cache write 在第一版统一并入 `cache_write_tokens`

### 5.3 项目识别

项目提取优先级：

1. 日志里的 `cwd`
2. Git 仓库名
3. 路径最后一级目录名
4. 无法识别则为 `unknown`

本地支持 alias：

```json
{
  "projectAliases": {
    "/Users/Ethan/Projects/AIUsage": "AIUsage"
  }
}
```

## 6. 上报格式

只上传聚合结果，不上传原始对话内容。

controller 只上传原始 token 计数，**不包含成本字段**。成本由 Server 根据 pricing catalog 统一计算（见第 11 节）。

示例：

```json
{
  "siteId": "site_xxxxx",
  "schemaVersion": "1.0",
  "generatedAt": "2026-04-01T00:10:12+08:00",
  "device": {
    "deviceId": "mbp-ethan-01",
    "deviceAlias": "MacBook Pro 工作机",
    "hostname": "Ethan-MacBook-Pro",
    "timezone": "Asia/Shanghai",
    "appVersion": "0.1.0"
  },
  "days": [
    {
      "usageDate": "2026-03-31",
      "breakdowns": [
        {
          "provider": "openai",
          "product": "codex",
          "channel": "cli",
          "model": "gpt-5.4",
          "project": "AIUsage",
          "eventCount": 31,
          "inputTokens": 320000,
          "cachedInputTokens": 80000,
          "cacheWriteTokens": 0,
          "outputTokens": 61000,
          "reasoningOutputTokens": 21000
        },
        {
          "provider": "anthropic",
          "product": "claude-code",
          "channel": "cli",
          "model": "claude-sonnet-4-6",
          "project": "AIUsage",
          "eventCount": 151,
          "inputTokens": 880345,
          "cachedInputTokens": 130003,
          "cacheWriteTokens": 90000,
          "outputTokens": 169455,
          "reasoningOutputTokens": 59421
        }
      ]
    }
  ]
}
```

Server 在 ingest 成功后返回计算结果：

```json
{
  "ok": true,
  "daysProcessed": 1,
  "costSummary": {
    "2026-03-31": {
      "estimatedCostUsd": 18.6231,
      "costStatus": "exact"
    }
  }
}
```

## 7. 数据库设计

第一版只保留 3 张表。

### 7.1 `devices`

```sql
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  hostname TEXT,
  public_label TEXT,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  token_version INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  app_version TEXT
);
```

### 7.2 `daily_usage`

```sql
CREATE TABLE daily_usage (
  device_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  cost_status TEXT NOT NULL DEFAULT 'exact',
  pricing_version TEXT,
  top_project_by_cost TEXT,
  top_project_cost_usd REAL,
  top_model_by_cost TEXT,
  top_model_cost_usd REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, usage_date),
  FOREIGN KEY (device_id) REFERENCES devices(device_id)
);
```

字段说明：

- `cost_status` 聚合规则：取该日所有 breakdown 中的最差状态。优先级 `unavailable > estimated > exact`。即只要有一条 breakdown 无法定价，日级别即为 `unavailable`
- `top_project_by_cost` / `top_model_by_cost`：在 ingest 时一次性计算写入，后续 breakdown 追加或修改时随之重算。不作为独立查询依据，仅用于 overview 展示的快速读取

### 7.3 `daily_usage_breakdown`

```sql
CREATE TABLE daily_usage_breakdown (
  device_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  provider TEXT NOT NULL,
  product TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'cli',
  model TEXT NOT NULL DEFAULT 'unknown',
  project TEXT NOT NULL DEFAULT 'unknown',
  event_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  cost_status TEXT NOT NULL DEFAULT 'exact',
  pricing_version TEXT,
  extra_metrics_json TEXT,
  source_meta_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, usage_date, provider, product, channel, model, project),
  FOREIGN KEY (device_id, usage_date)
    REFERENCES daily_usage(device_id, usage_date)
    ON DELETE CASCADE
);
```

推荐索引：

```sql
CREATE INDEX idx_daily_usage_date ON daily_usage(usage_date);
CREATE INDEX idx_breakdown_project ON daily_usage_breakdown(project, usage_date);
CREATE INDEX idx_breakdown_model ON daily_usage_breakdown(model, usage_date);
CREATE INDEX idx_breakdown_provider_product ON daily_usage_breakdown(provider, product, usage_date);
```

## 8. 隐私策略

项目名是敏感信息，公开页必须支持隐藏。

分两层：

- 上传侧：controller 可做本地 alias 或过滤
- 展示侧：公开接口按部署配置脱敏

公开展示模式：

- `hidden`：不展示项目维度
- `masked`：稳定伪名，如 `Project A1F4`
- `plain`：真实项目名，仅私有部署使用

默认：

- 公开接口：`masked`

如果使用 `masked`：

- 算法：`HMAC_SHA256(project_name, PROJECT_NAME_SALT)`
- 输出：前 6 到 8 位作为稳定伪名

公开页默认不展示：

- 原始项目名
- 本地路径
- Git 仓库 URL
- 设备真实 hostname

## 9. API 设计

第一版只保留 2 组接口：设备接口、公开接口。

### 9.1 统一错误响应格式

所有接口在出错时返回统一格式：

```json
{
  "ok": false,
  "error": {
    "code": "DEVICE_DISABLED",
    "message": "Device has been disabled by administrator"
  }
}
```

标准错误码：

| 错误码 | HTTP 状态码 | 说明 |
|--------|-----------|------|
| `INVALID_TOKEN` | 401 | token 无效或已过期 |
| `TOKEN_VERSION_MISMATCH` | 401 | token_version 不匹配，需重新 enroll |
| `SITE_ID_MISMATCH` | 403 | 请求体中 siteId 与 token 不一致 |
| `DEVICE_ID_MISMATCH` | 403 | 请求体中 deviceId 与 token 不一致 |
| `DEVICE_DISABLED` | 403 | 设备已被停用 |
| `MAX_DEVICES_REACHED` | 403 | 已达设备数上限 |
| `INVALID_PAYLOAD` | 400 | 请求体校验失败 |
| `INTERNAL_ERROR` | 500 | 服务端内部错误 |

### 9.2 CORS 配置

Worker 需对公开只读接口（`/api/v1/public/*`）配置 CORS：

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`

设备接口（`/api/v1/enroll`、`/api/v1/ingest/*`）不需要 CORS，仅供 controller 调用。

### 9.3 设备接口

#### `GET /api/v1/health`

用途：

- controller 测试到 Worker 的连通性
- `aiusage doctor` 前置检查
- 部署完成后的快速校验

无需鉴权，仅返回最小必要信息。

响应示例：

```json
{
  "ok": true,
  "siteId": "site_xxxxx",
  "service": "aiusage",
  "version": "0.1.0",
  "time": "2026-04-01T00:10:12+08:00"
}
```

#### `POST /api/v1/enroll`

Headers：

- `Authorization: Bearer <ENROLL_TOKEN>`
- `Content-Type: application/json`

Body：

```json
{
  "siteId": "site_xxxxx",
  "deviceId": "mbp-ethan-01",
  "deviceAlias": "MacBook Pro 工作机",
  "hostname": "Ethan-MacBook-Pro",
  "timezone": "Asia/Shanghai",
  "appVersion": "0.1.0"
}
```

Response：

```json
{
  "ok": true,
  "siteId": "site_xxxxx",
  "deviceId": "mbp-ethan-01",
  "deviceToken": "dtok_xxxxx",
  "issuedAt": "2026-04-01T00:10:12+08:00"
}
```

服务端校验：

- `ENROLL_TOKEN` 有效
- `siteId` 与 Worker 配置的 `SITE_ID` 一致
- 当前设备数未超过 `MAX_DEVICES`
- 若 `deviceId` 已存在且 `status = active`，重新签发 token 并递增 `token_version`

#### `POST /api/v1/ingest/daily`

Headers：

- `Authorization: Bearer <DEVICE_TOKEN>`
- `Content-Type: application/json`

Body：

- 使用第 6 节定义的日聚合 JSON
- controller 上传原始 token 计数，不含成本字段
- 成本由 Server 根据 pricing catalog 计算并写入

服务端必须校验：

- token 签名有效
- token 内的 `siteId` 与 body 一致
- token 内的 `deviceId` 与 body.device.deviceId 一致
- `devices.status = active`
- `devices.token_version` 与 token 中版本一致

### 9.4 公开接口

#### `GET /api/v1/public/overview`

用途：

- Dashboard 总览
- 趋势图
- 概览卡片

建议参数：

- `range=7d|3m|all`
- `deviceId`
- `provider`
- `product`

#### `GET /api/v1/public/breakdowns`

用途：

- 明细表格
- drill-down
- embed 组件

建议参数：

- `date`
- `range=7d|3m|all`
- `deviceId`
- `provider`
- `product`
- `model`
- `project`
- `limit`（默认 50，最大 200）
- `offset`（默认 0，用于分页）

响应中附带分页信息：

```json
{
  "ok": true,
  "data": [...],
  "pagination": {
    "total": 342,
    "limit": 50,
    "offset": 0,
    "hasMore": true
  }
}
```

## 10. 密钥管理

必须区分 4 类凭证。

### 10.1 部署凭证

仅用于部署 Cloudflare 资源：

- Wrangler 登录态
- Cloudflare API Token

规则：

- 只存在于部署者本机或 CI
- 不下发到 Worker
- 不下发到 controller
- 不出现在前端

### 10.2 Worker 运行时配置

普通配置：

- `SITE_ID`
- `APP_BASE_URL`
- `PUBLIC_SITE_URL`
- `PUBLIC_PROJECT_VISIBILITY`（`hidden` / `masked` / `plain`）
- `DEFAULT_TIMEZONE`
- `MAX_DEVICES`（默认 10）

Secret：

- `ENROLL_TOKEN`（支持随时轮换，`wrangler secret put` 即可使旧 token 失效）
- `DEVICE_TOKEN_SECRET`
- `PROJECT_NAME_SALT`

### 10.3 Controller 本地配置

首次 enroll 前：

- `apiBaseUrl`
- `siteId`
- `deviceId`
- `deviceAlias`

enroll 后：

- `deviceToken`
- `lookbackDays`
- `projectAliases`

规则：

- `ENROLL_TOKEN` 默认不落盘
- `deviceToken` 仅保存在本机配置文件
- controller 不持有 Cloudflare API Token

### 10.4 浏览器前端

第一版前端不配置任何写权限 API Key。

规则：

- 前端只调公开只读接口
- 前端不暴露 `ENROLL_TOKEN`
- 前端不暴露 `DEVICE_TOKEN_SECRET`
- 前端不暴露 Cloudflare API Token

## 11. 定价目录与成本计算

成本计算应由 Server 统一完成，不由 controller 决定最终价格。

职责划分：

- controller：
  - 上传原始 token 计数
  - 上传 `provider / product / model` 等基础字段
  - 不计算、不上传成本
- Server：
  - 读取 pricing catalog
  - 归一化模型 ID
  - 计算成本
  - 写入 `estimated_cost_usd`
  - 记录 `pricing_version`
  - 聚合 breakdown 成本至 `daily_usage`

这样做的好处：

- 多设备口径一致
- 更新价格时只改 Server
- 不会因为 controller 版本不同导致同一天价格不同

### 11.1 定价配置方式

第一版推荐直接使用 Server 侧 JSON 文件：

- `pricing.catalog.json`
  - 仓库内默认价目表
- `pricing.override.json`
  - 部署者可选覆盖

运行时规则：

1. 读取 `pricing.catalog.json`
2. 若存在 `pricing.override.json`，则覆盖默认值
3. 形成当前有效 pricing catalog

第一版不需要页面配置。

### 11.2 定价结构建议

所有厂商使用统一的字段命名：

```json
{
  "version": "2026-04-01-official-v1",
  "providers": {
    "anthropic": {
      "claude-code": {
        "models": {
          "claude-sonnet-4-6": {
            "input_per_million_usd": 3,
            "output_per_million_usd": 15,
            "cache_write_per_million_usd": 3.75,
            "cached_input_per_million_usd": 0.3
          }
        }
      }
    },
    "openai": {
      "codex": {
        "models": {
          "gpt-5.4": {
            "input_per_million_usd": 2.5,
            "output_per_million_usd": 15,
            "cached_input_per_million_usd": 0.25,
            "cache_write_per_million_usd": 0
          }
        }
      }
    }
  }
}
```

字段说明：

- `input_per_million_usd`：非缓存输入 token 单价
- `output_per_million_usd`：输出 token 单价
- `cached_input_per_million_usd`：缓存命中的输入 token 单价
- `cache_write_per_million_usd`：写入缓存的 token 单价（无此概念的厂商填 0）

### 11.3 模型归一化

Server 应支持：

- `aliases`
- `fallback_model`

例如：

```json
{
  "aliases": {
    "claude-sonnet-4-6-20250301": "claude-sonnet-4-6"
  }
}
```

规则：

- 能精确匹配就精确匹配
- 能 alias 映射就映射
- 否则尝试 fallback
- 仍无法识别则 `cost_status = unavailable`

### 11.4 成本状态

建议统一：

- `exact`
- `estimated`
- `unavailable`

其中：

- `exact`
  - 有明确模型与明确公开价格
- `estimated`
  - 使用 alias、fallback 或近似价格
- `unavailable`
  - 无法识别模型或没有价格

## 12. 部署流程

默认只支持单 Worker 模式。

推荐命令：

```bash
npx aiusage setup cloudflare
```

该命令负责：

1. 检查 `node` 与 `wrangler`
2. 检查 `wrangler whoami`
3. 生成 `SITE_ID`
4. 创建或绑定 D1
5. 写入 secrets
6. 执行 migration
7. 构建前端静态资源
8. 部署 Worker
9. 输出：
   - 公开站点 URL
   - `SITE_ID`
   - `ENROLL_TOKEN`
   - 第二台设备接入命令

关键命令骨架：

```bash
npx wrangler whoami
npx wrangler d1 create aiusage-prod
npx wrangler secret put ENROLL_TOKEN
npx wrangler secret put DEVICE_TOKEN_SECRET
npx wrangler secret put PROJECT_NAME_SALT
npx wrangler deploy
```

## 13. Controller 命令

```bash
npx aiusage init
npx aiusage health
npx aiusage enroll
npx aiusage config set device.alias "MacBook Pro 工作机"
npx aiusage config set privacy.projectVisibility masked
npx aiusage config set project.alias /Users/Ethan/Projects/AIUsage AIUsage
npx aiusage scan --date 2026-03-31 --json
npx aiusage sync
npx aiusage install-schedule
npx aiusage doctor
```

说明：

- `init`：初始化本地配置
- `health`：测试到 Worker 的连通性与 `SITE_ID`
- `enroll`：首次接入站点
- `config set`：本地别名与隐私配置
- `scan`：本地聚合调试
- `sync`：执行闭合日同步
- `install-schedule`：安装定时任务
- `doctor`：综合检查

第二台设备接入示例：

```bash
npx aiusage enroll \
  --server https://your-site.example.com \
  --site-id <SITE_ID> \
  --enroll-token <ENROLL_TOKEN> \
  --device-name "MacBook-Air"
```

## 14. 前端设计

第一版前端是只读单页 Dashboard，不提供网页登录后台。

### 14.1 单页模块

- 顶部总览
- 趋势模块
- 厂商模块
- 模型模块
- 项目模块
- 设备模块
- 明细模块

### 14.2 时间范围

公开页与 embed 默认支持：

- `7d`
- `3m`
- `all`

query 示例：

```text
?range=7d
?range=3m
?range=all
```

### 14.3 Embed

embed 不是第一版必上，但必须预留。

推荐支持：

- `/embed?widget=overview`
- `/embed?widget=trend`
- `/embed?widget=models`
- `/embed?widget=projects`
- `/embed?widget=devices`

推荐参数：

- `range=7d|3m|all`
- `deviceId`
- `provider`
- `product`
- `theme=light|dark|auto`
- `transparent=1`
- `limit=10`

要求：

- 使用同一套公开只读接口
- 路由和 query 参数保持稳定
- 适合 iframe 嵌入

## 15. 测试

### 15.1 Controller

- 日期边界
- 去重逻辑
- 项目识别
- 模型价格映射

### 15.2 Server

- health 接口
- enroll（含设备数上限校验）
- ingest 幂等 upsert
- 成本计算与 cost_status 聚合
- 脱敏输出
- D1 migration
- 错误码返回

### 15.3 端到端

- 部署完成后 `health` 正常
- 第二台设备 enroll 成功
- sync 后前端可见数据
- 停用设备后上报被拒绝
- `range=7d|3m|all` 在公开页与 embed 行为一致
- 超过 `MAX_DEVICES` 后 enroll 被拒绝
- `token_version` 变更后旧 token 失效

## 16. 开发顺序

### Phase 1

- 将 Python 迁移为 Node.js controller
- 完成 `scan / health / enroll / sync`

### Phase 2

- 完成 Worker API（含错误码与 CORS）
- 完成 D1 表结构与 migration
- 跑通单 Worker 部署

### Phase 3

- 完成单页 Dashboard
- 完成公开只读接口接入

### Phase 4

- 预留并实现基础 embed
- 补充主题、透明背景、更多筛选参数

## 17. 结论

第一版最终方案就是：

- 单 Cloudflare Worker
- 单 D1
- 单 controller
- 单页只读 Dashboard
- 多设备通过 `ENROLL_TOKEN -> DEVICE_TOKEN` 接入
- 成本由 Server 统一计算

这版已经可以作为开发依据。若继续推进，实现时优先补接口 schema 和定价目录初始数据即可。
