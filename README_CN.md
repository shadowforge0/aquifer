<div align="center">

# 🌊 Aquifer

**基于 PostgreSQL 的 AI Agent 长期记忆系统**

*Turn 级 embedding、三路 RRF 混合排序、信任评分、实体交叉查询、知识图谱、实体作用域——全部运行在 PostgreSQL + pgvector 上。*

[![npm version](https://img.shields.io/npm/v/@shadowforge0/aquifer-memory)](https://www.npmjs.com/package/@shadowforge0/aquifer-memory)
[![PostgreSQL 15+](https://img.shields.io/badge/PostgreSQL-15%2B-336791)](https://www.postgresql.org/)
[![pgvector](https://img.shields.io/badge/pgvector-0.7%2B-blue)](https://github.com/pgvector/pgvector)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [繁體中文](README_TW.md) | [简体中文](README_CN.md)

</div>

---

## 为什么选 Aquifer？

大多数 AI 记忆系统会在旁边挂一个向量数据库。Aquifer 的做法不同：**PostgreSQL 就是记忆本体**。

Session、摘要、turn 级 embedding、实体图谱——全部存在同一个数据库里，用同一个连接查询。不需要同步层、没有最终一致性问题、不用额外基础设施。

### 跟典型做法的差异

| | Aquifer | 典型向量 DB 做法 |
|---|---|---|
| **存储** | PostgreSQL + pgvector | 独立向量 DB + 应用 DB |
| **粒度** | Turn 级 embedding（不只是 session 摘要） | Session 或文档分片 |
| **排序** | 三路 RRF：FTS + session embedding + turn embedding | 单一向量相似度 |
| **知识图谱** | 内建实体提取与共现关系 | 通常是独立系统 |
| **多租户** | 每张表都有 `tenant_id`，第一天就内建 | 通常是事后补做 |
| **依赖** | `pg` + MCP SDK | 多个 SDK |

### 有和没有的差别

**没有 turn 级记忆——搜索只能命中模糊的摘要：**

> 查询："我们对 auth middleware 做了什么决定？"
> → 返回一份 2000 字的 session 摘要，里面某处提到了 auth

**有 Aquifer——搜索直接命中精确的对话片段：**

> 查询："我们对 auth middleware 做了什么决定？"
> → 返回那句原话："旧的 auth middleware 拆掉吧——法务说 session token 存储方式不合规"

---

## 需求

| 组件 | 必需？ | 用途 | 示例 |
|------|--------|------|------|
| Node.js >= 18 | 是 | Runtime | — |
| PostgreSQL 15+ | 是 | 存储 session、摘要、实体 | 本地、Docker 或 managed |
| pgvector extension | 是 | 向量相似度搜索 | `CREATE EXTENSION vector;`（`pgvector/pgvector` Docker image 内置） |
| Embedding 端点 | 是（recall 用） | Turn + session embedding | Ollama `bge-m3`、OpenAI `text-embedding-3-small`、任何 OpenAI 兼容 API |
| LLM 端点 | 可选 | `enrich` 阶段的内置摘要 | Ollama、OpenRouter、OpenAI——或自己传 `summaryFn` |
| `@modelcontextprotocol/sdk` + `zod` | 是（MCP server 用） | MCP 协议 runtime | 已列入 dependencies，自动安装 |

---

## 快速开始（MCP 服务器）

两行命令从零到可用的 MCP 记忆服务器——不需要设任何 env。Library API 用法请往下看 [Library API](#library-api)。

### 1. 起 stack

```bash
docker compose up -d
# PostgreSQL 16 + pgvector 和 Ollama（bge-m3 自动 pull）。
# 第一次运行会拉 model——`docker compose logs -f ollama-pull` 看进度。
```

已经有 PostgreSQL + pgvector 和 embedding 端点在跑？跳过这步——`quickstart` 会从环境变量读 `DATABASE_URL` / `EMBED_PROVIDER`（如果已设置）。

### 2. 验证

```bash
npx --yes @shadowforge0/aquifer-memory quickstart
```

就这样。`quickstart` 会自动探测 `localhost:5432` 的 PostgreSQL 和 `localhost:11434` 的 Ollama（步骤 1 起的或你自己的都行），跑 migration、embed 一个测试 session、recall 回来、清干净。看到 `✓ Aquifer is working` 就成功了。

长期使用建议装进项目省掉 `npx` 解析开销：`npm install @shadowforge0/aquifer-memory` 然后 `npx aquifer quickstart`。

要用 OpenAI 不用 Ollama？跑 `quickstart` 前 `export EMBED_PROVIDER=openai` + `OPENAI_API_KEY=sk-...`——model 默认 `text-embedding-3-small`。

### 3. 接到你的 MCP client

Claude Code、Claude Desktop 或任何支持 MCP 的 client——放进 `.mcp.json`（项目级）或 `claude_desktop_config.json`：

```jsonc
{
  "mcpServers": {
    "aquifer": {
      "command": "npx",
      "args": ["--yes", "@shadowforge0/aquifer-memory", "mcp"],
      "env": {
        "DATABASE_URL": "postgresql://aquifer:aquifer@localhost:5432/aquifer",
        "EMBED_PROVIDER": "ollama"
      }
    }
  }
}
```

或直接跑：`DATABASE_URL=... EMBED_PROVIDER=ollama npx aquifer mcp`。（MCP server 本身对 env 严格——`quickstart` 的 autodetect 是试用路径，不是 production 路径。）

需要 LLM 摘要、知识图谱、OpenAI embedding 或 reranker？往下看 [环境变量](#环境变量) 和 [docs/setup.md](docs/setup.md)。

---

## Library API

### 初始化

```javascript
const { createAquifer } = require('@shadowforge0/aquifer-memory');

const aquifer = createAquifer({
  db: 'postgresql://user:pass@localhost:5432/mydb',  // 连接字符串或 pg.Pool
  schema: 'memory',                    // PG schema 名称（默认 'aquifer'）
  tenantId: 'default',                 // 多租户隔离
  embed: {
    fn: async (texts) => embeddings,   // 你的 embedding 函数
    dim: 1024,                         // 可选，维度提示
  },
  llm: {
    fn: async (prompt) => text,        // 你的 LLM 函数（内置摘要用）
  },
  entities: {
    enabled: true,
    scope: 'my-app',                   // 实体命名空间（默认 'default'）
  },
});

// 执行 migration（可重复执行）
await aquifer.migrate();
```

### 写入路径：commit + enrich

```javascript
// 1. 保存 session
await aquifer.commit('conv-001', [
  { role: 'user', content: '我来说说新的 auth 做法...' },
  { role: 'assistant', content: '了解，所以计划是...' },
], { agentId: 'main' });

// 2. 丰富化：摘要 + turn embedding + 实体提取
const result = await aquifer.enrich('conv-001', {
  agentId: 'main',
  summaryFn: async (msgs) => ({ summaryText, structuredSummary, entityRaw }),
  entityParseFn: (text) => [{ name, normalizedName, type, aliases }],
  postProcess: async (ctx) => { /* 后处理 hook */ },
});
```

### 查询路径：recall

```javascript
const results = await aquifer.recall('auth middleware 决定', {
  agentId: 'main',
  limit: 5,
  entities: ['auth-middleware'],       // 可选：实体感知搜索
  entityMode: 'all',                   // 'any'（加分）或 'all'（硬筛）
});
// 返回排序后的 session，使用三路 RRF 融合
```

---

## 宿主集成

MCP 是主要的集成接口。Agent 宿主连接到 Aquifer MCP server，该 server 暴露五个工具：`session_recall`、`session_feedback`、`session_bootstrap`、`memory_stats`、`memory_pending`。

| 集成方式 | 路径 | 状态 | 使用场景 |
|----------|------|------|----------|
| MCP server | `consumers/mcp.js` | 主要 | Claude Code、OpenClaw、Codex 及任何支持 MCP 的宿主 |
| Library API | `createAquifer()` | 主要 | 后端应用、自定义 pipeline、直接 Node.js 调用 |
| CLI | `consumers/cli.js` | 辅助 | 运维、调试、手动 recall/backfill |
| OpenCode 导入 | `consumers/opencode.js` | 辅助 | 从 OpenCode 的 SQLite DB 导入 session |
| OpenClaw 插件 | `consumers/openclaw-plugin.js` | 仅兼容 | 通过 `before_reset` 捕获 session——不用于工具分发 |

### Claude Code

添加到项目的 `.claude.json` 或用户级 MCP 配置：

```json
{
  "mcpServers": {
    "aquifer": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/aquifer/consumers/mcp.js"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "AQUIFER_EMBED_BASE_URL": "http://localhost:11434/v1",
        "AQUIFER_EMBED_MODEL": "bge-m3"
      }
    }
  }
}
```

工具在 Claude Code 中显示为 `mcp__aquifer__session_recall`、`mcp__aquifer__session_feedback`、`mcp__aquifer__session_bootstrap` 等。

### OpenClaw

添加到 `openclaw.json` 的 `mcp.servers` 下：

```json
{
  "mcp": {
    "servers": {
      "aquifer": {
        "command": "node",
        "args": ["/path/to/aquifer/consumers/mcp.js"],
        "env": {
          "DATABASE_URL": "postgresql://...",
          "AQUIFER_EMBED_BASE_URL": "http://localhost:11434/v1",
          "AQUIFER_EMBED_MODEL": "bge-m3"
        }
      }
    }
  }
}
```

工具显示为 `aquifer__session_recall`、`aquifer__session_feedback`、`aquifer__memory_stats`、`aquifer__memory_pending`（宿主自动添加 server 名称前缀）。

OpenClaw 插件（`consumers/openclaw-plugin.js`）保留用于通过 `before_reset` 捕获 session，但**不是**推荐的工具分发路径。请使用 MCP。

### 其他支持 MCP 的宿主

任何支持 MCP stdio 的宿主都可以用相同方式连接——将其指向 `node consumers/mcp.js` 并设置所需的环境变量。MCP server 是规范的外部接口。

---

## 环境变量

| 变量 | 是否必需？ | 用途 | 示例 |
|------|-----------|------|------|
| `DATABASE_URL` | 是 | PostgreSQL 连接字符串 | `postgresql://user:pass@localhost:5432/mydb` |
| `AQUIFER_SCHEMA` | 否 | PG schema 名称（默认：`aquifer`） | `memory` |
| `AQUIFER_TENANT_ID` | 否 | 多租户 key（默认：`default`） | `my-app` |
| `AQUIFER_EMBED_BASE_URL` | 是（recall 需要） | Embedding API 基础 URL | `http://localhost:11434/v1` |
| `AQUIFER_EMBED_MODEL` | 是（recall 需要） | Embedding 模型名称 | `bge-m3` |
| `AQUIFER_EMBED_API_KEY` | 取决于提供商 | 托管 embedding 提供商的 API key | `sk-...` |
| `AQUIFER_EMBED_DIM` | 否 | Embedding 维度覆盖（自动检测） | `1024` |
| `AQUIFER_LLM_BASE_URL` | 否 | LLM API 基础 URL（内置摘要用） | `http://localhost:11434/v1` |
| `AQUIFER_LLM_MODEL` | 否 | LLM 模型名称 | `llama3.1` |
| `AQUIFER_LLM_API_KEY` | 取决于提供商 | 托管 LLM 提供商的 API key | `sk-...` |
| `AQUIFER_ENTITIES_ENABLED` | 否 | 启用知识图谱（默认：`false`） | `true` |
| `AQUIFER_ENTITY_SCOPE` | 否 | 实体命名空间（默认：`default`） | `my-app` |
| `AQUIFER_RERANK_ENABLED` | 否 | 启用 cross-encoder reranking | `true` |
| `AQUIFER_RERANK_PROVIDER` | 否 | Reranker 提供商：`tei`、`jina`、`openrouter` | `tei` |
| `AQUIFER_RERANK_BASE_URL` | 否 | Reranker 端点 | `http://localhost:8080` |
| `AQUIFER_AGENT_ID` | 否 | 默认 agent ID | `main` |

完整的环境变量到配置映射见 [consumers/shared/config.js](consumers/shared/config.js)。

---

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    createAquifer（入口）                      │
│         设定 · Migration · Ingest · Recall · Enrich          │
└────────┬──────────┬──────────┬──────────┬───────────────────┘
         │          │          │          │
    ┌────▼───┐ ┌────▼────┐ ┌──▼───┐ ┌───▼──────────┐
    │storage │ │hybrid-  │ │entity│ │   pipeline/   │
    │  .js   │ │rank.js  │ │ .js  │ │summarize.js   │
    └────────┘ └─────────┘ └──────┘ │embed.js       │
         │                     │    │extract-ent.js │
    ┌────▼───────────┐    ┌───▼──┐  │rerank.js      │
    │  PostgreSQL     │    │ LLM  │  └───────────────┘
    │  + pgvector     │    │ API  │
    └────────────────┘    └──────┘

    ┌───────────────────────────────────┐
    │         schema/                   │
    │  001-base.sql（sessions、          │
    │    summaries、turns、FTS）          │
    │  002-entities.sql（KG）             │
    │  003-trust-feedback.sql（信任评分） │
    └───────────────────────────────────┘
```

### 文件说明

| 文件 | 用途 |
|------|------|
| `index.js` | 入口——导出 `createAquifer`、`createEmbedder`、`createReranker` |
| `core/aquifer.js` | 主 facade：`migrate()`、`commit()`、`recall()`、`enrich()` |
| `core/storage.js` | Session/摘要/turn 的 CRUD、FTS 搜索、embedding 搜索 |
| `core/entity.js` | 实体 upsert、mention 追踪、关系图谱、名称规范化 |
| `core/hybrid-rank.js` | 三路 RRF 融合、时间衰减、信任乘数、实体加分、open-loop 加分 |
| `pipeline/summarize.js` | LLM 驱动的 session 摘要（结构化输出） |
| `pipeline/embed.js` | Embedding 客户端（任何 OpenAI 兼容 API） |
| `pipeline/extract-entities.js` | LLM 驱动的实体提取（12 种类型） |
| `pipeline/rerank.js` | Cross-encoder reranking（TEI、Jina、OpenRouter） |
| `pipeline/normalize/` | Session 规范化，过滤 Claude Code / gateway 噪音 |
| `consumers/opencode.js` | OpenCode SQLite 导入消费者 |
| `schema/001-base.sql` | DDL：sessions、summaries、turn_embeddings、FTS 索引 |
| `schema/002-entities.sql` | DDL：entities、mentions、relations、entity_sessions |
| `schema/003-trust-feedback.sql` | DDL：trust_score 字段、session_feedback 审计表 |

---

## 核心功能

### 三路混合检索（RRF）

```
查询 ──┬── FTS（BM25）              ──┐
       ├── Session embedding 搜索   ──├── RRF 融合 → 时间衰减 → 实体加分 → 结果
       └── Turn embedding 搜索     ──┘
```

- **全文搜索** — PostgreSQL `tsvector`，支持多语言排序
- **Session embedding** — 对 session 摘要做 cosine 相似度
- **Turn embedding** — 对单个 user turn 做 cosine 相似度
- **Reciprocal Rank Fusion** — 合并三份排名列表（K=60）
- **时间衰减** — sigmoid 衰减，可配置中点与斜率
- **实体加分** — 包含查询相关实体的 session 会获得分数提升
- **信任评分** — 根据明确反馈（helpful/unhelpful）的乘法信任系数
- **Open-loop 加分** — 有未解决项的 session 获得轻微提升
- **可选 cross-encoder reranking** — 支持 TEI、Jina、OpenRouter 提供商，对 RRF 结果做二次精排

### 实体交叉查询

明确指定要搜索的实体时，可以做 AND 语义筛选：

```javascript
const results = await aquifer.recall('auth 决定', {
  entities: ['auth-middleware', 'legal-compliance'],
  entityMode: 'all',  // 只返回同时包含两个实体的 session
});
```

- `entityMode: 'any'`（默认）— 提升匹配任一实体的 session
- `entityMode: 'all'` — 硬筛：只返回包含所有指定实体的 session

### 信任评分与反馈

Session 通过明确反馈累积信任分数。低信任的记忆在排序中会被压制，无论相关性多高。

```javascript
// 返回结果有用
await aquifer.feedback('session-id', { verdict: 'helpful' });

// 返回结果无关
await aquifer.feedback('session-id', { verdict: 'unhelpful' });
```

- 不对称：helpful +0.05，unhelpful −0.10（低质量记忆下沉更快）
- 排序中用乘法：trust=0.5 中性、trust=0 分数减半、trust=1.0 提升 50%
- 完整审计记录在 `session_feedback` 表

### Turn 级 Embedding

不只是 session 摘要——Aquifer 对每一条有意义的 user turn 独立 embedding。

- 过滤噪音：短消息、斜杠命令、确认语（"ok""好""收到"）
- 截断 2000 字符，跳过 5 字符以下的 turn
- 存储 turn 原文 + embedding + 位置，实现精确检索

### 知识图谱

内建实体提取与关系追踪：

- **12 种实体类型**：person、project、concept、tool、metric、org、place、event、doc、task、topic、other
- **实体规范化**：NFKC + 同形字映射 + 大小写折叠
- **共现关系**：无向边，带频率追踪
- **实体-session 映射**：哪些实体出现在哪些 session
- **排序加分**：包含相关实体的 session 分数更高

---

## Benchmark：LongMemEval

我们用 [LongMemEval_S](https://github.com/xiaowu0162/LongMemEval) 测试 Aquifer 的检索管线——470 题、19,195 个 sessions，共 98,795 条 turn embeddings。Per-question haystack 范围与官方协议一致，bge-m3 embedding 走 OpenRouter。

| Pipeline | R@1 | R@3 | R@5 | R@10 |
|----------|-----|-----|-----|------|
| Turn-only（单纯 cosine） | 89.5% | 96.6% | 98.1% | 98.9% |
| 三路混合（FTS + session_emb + turn_emb → RRF） | 79.2% | 94.0% | 97.7% | 98.9% |
| **三路混合 + Cohere Rerank v3.5（top-30）** | **96.0%** | **98.5%** | **99.3%** | **99.8%** |

测量日期 2026-04-19、Aquifer 1.2.1。

**关键观察。** Turn 级 embedding 本身就是主力——从 session 级（R@1 26.8%）到 turn 级（R@1 89.5%）是 3 倍的差距。三路混合在 R@3-R@10 比较稳，但 R@1 会被 FTS 跟 session 级信号拉下来。把 hybrid 的 top-30 丢进 cross-encoder（Cohere Rerank v3.5）重排之后，top-1 就补回来了——R@1 比 hybrid baseline 高 16.9pt，比 turn-only cosine 也多 6.5pt。只要 Aquifer 配好 reranker，这就是默认会跑的 production 路径。

### 多租户

每张表都包含 `tenant_id`（默认：`'default'`）。隔离在查询层强制执行——不会有跨租户数据泄漏。

### Schema 隔离

传入 `schema: 'my_app'` 给 `createAquifer()`，所有表都建在该 PostgreSQL schema 下。同一个数据库可以运行多个 Aquifer 实例互不冲突。

---

## API 参考

### `createAquifer(config)`

返回一个 Aquifer 实例。设定：

```javascript
{
  db,          // PG 连接字符串或 Pool 实例（必填）
  schema,      // PG schema 名称（默认 'aquifer'）
  tenantId,    // 多租户 key（默认 'default'）
  embed: { fn, dim },      // embedding 函数（recall 必需）
  llm: { fn },             // LLM 函数（内置摘要必需）
  entities: {
    enabled,               // 启用知识图谱（默认 false）
    scope,                 // 实体命名空间（默认 'default'）
    mergeCall,             // 合并实体提取到摘要 LLM 调用（默认 true）
  },
  rank: { rrf, timeDecay, access, entityBoost },  // 权重覆盖
}
```

#### `aquifer.migrate()`

执行 SQL migration（幂等）。创建表、索引、trigger 和扩展。

#### `aquifer.commit(sessionId, messages, opts)`

保存 session。返回 `{ id, sessionId, isNew }`。

#### `aquifer.enrich(sessionId, opts)`

丰富化已 commit 的 session：摘要、turn embedding、实体提取。支持自定义 pipeline（`summaryFn`、`entityParseFn`）和 `postProcess` 后处理 hook。使用乐观锁，卡住超过 10 分钟的 processing session 可被回收。

#### `aquifer.recall(query, opts)`

三路混合搜索。支持 `entities` + `entityMode` 做实体感知查询。

```javascript
const results = await aquifer.recall('搜索关键字', {
  agentId: 'main',
  limit: 10,
  entities: ['postgres', 'migration'],
  entityMode: 'all',
  weights: { rrf, timeDecay, access, entityBoost },
});
```

#### `aquifer.feedback(sessionId, opts)`

记录信任反馈。返回 `{ trustBefore, trustAfter, verdict }`。

#### `aquifer.bootstrap(opts)`

基于时间的 session 上下文加载器，用于新对话启动时获取近期记忆。

```javascript
const context = await aquifer.bootstrap({
  agentId: 'main',
  limit: 5,              // 返回 session 数量（默认 5）
  lookbackDays: 14,      // 回溯天数（默认 14）
  maxChars: 4000,        // 最大字符数截断（默认 4000）
  format: 'text',        // 'text' | 'structured' | 'both'
});
```

- 跨 session 去重，避免重复内容
- Sentinel 过滤，排除系统噪音
- `maxChars` 截断，确保不超出上下文预算

#### `aquifer.close()`

关闭 PostgreSQL 连接池（仅限 Aquifer 自行创建的 pool）。

---

## 设定

Aquifer 接受 `db` 连接（字符串或 `pg.Pool`），加上可选的 `embed` 和 `llm` 函数：

```javascript
createAquifer({
  db: 'postgresql://user:pass@localhost/mydb',  // 或既有 pg.Pool
  schema: 'aquifer',
  tenantId: 'default',
  embed: {
    fn: myEmbedFn,             // async (texts: string[]) => number[][]
    dim: 1024,
  },
  llm: {
    fn: myLlmFn,               // async (prompt: string) => string
  },
  entities: {
    enabled: true,
    scope: 'my-app',           // 实体命名空间——与 agentId 解耦
    mergeCall: true,
  },
  rank: { rrf: 0.65, timeDecay: 0.25, access: 0.10, entityBoost: 0.18 },
});
```

### 实体作用域（Entity Scope）

`entities.scope` 定义实体身份的命名空间。唯一约束是 `(tenant_id, normalized_name, entity_scope)`——不同 scope 中的同名实体会创建独立的实体。这让实体身份与 `agentId` 解耦，允许多个 agent 共享同一个实体命名空间。

---

## 数据库 Schema

### 001-base.sql

| 表 | 用途 |
|----|------|
| `sessions` | 原始对话数据，含 messages（JSONB）、token 数、时间戳 |
| `session_summaries` | LLM 生成的结构化摘要，含 embedding |
| `turn_embeddings` | 逐 turn 的 user 消息 embedding，实现精确检索 |

重要索引：messages GIN、`tsvector` GiST、embedding ivfflat、tenant/agent/timestamp B-tree。

### 002-entities.sql

| 表 | 用途 |
|----|------|
| `entities` | 规范化命名实体，含类型、别名、频率、entity_scope、可选 embedding |
| `entity_mentions` | 实体 × session 关联，含 mention 次数与上下文 |
| `entity_relations` | 共现边（无向，`CHECK src < dst`） |
| `entity_sessions` | 实体-session 关联，用于加分计算 |

重要索引：实体名称 trigram、embedding GiST、`(tenant_id, normalized_name, entity_scope)` 唯一索引。

### 003-trust-feedback.sql

| 表 | 用途 |
|----|------|
| `session_feedback` | 明确反馈审计记录（helpful/unhelpful 判定、信任分数变动） |

另在 `session_summaries` 新增 `trust_score` 字段（默认 0.5，范围 0–1）。

---

## 故障排除

**`error: type "vector" does not exist`** — pgvector 扩展未安装。以 superuser 身份执行 `CREATE EXTENSION IF NOT EXISTS vector;`，或使用自带该扩展的 `pgvector/pgvector` Docker 镜像。

**`aquifer mcp requires @modelcontextprotocol/sdk and zod`** — 这些现在是常规依赖，应该会自动安装。如果看到此错误，重新执行 `npm install` 确保所有依赖就位。

**Recall 没有返回结果** — 确保在 `commit` 之后执行了 `enrich`。原始 session 在丰富化（摘要 + embedding）之前不可搜索。运行 `aquifer stats` 检查摘要和 turn embedding 是否存在。

**OpenClaw 工具不可见** — 在 `openclaw.json` 中使用 `mcp.servers.aquifer`，不要用插件。工具显示为 `aquifer__session_recall` 等。插件（`consumers/openclaw-plugin.js`）仅用于 session 捕获。

**Embedding 提供商连接被拒** — 检查 `AQUIFER_EMBED_BASE_URL` 是否可达。本地 Ollama 需确保服务正在运行且模型已拉取（`ollama pull bge-m3`）。

---

## 依赖

| 包 | 用途 |
|----|------|
| `pg` ≥ 8.13 | PostgreSQL 客户端 |
| `@modelcontextprotocol/sdk` ≥ 1.29 | MCP server 协议 |
| `zod` ≥ 3.25 | Schema 验证（MCP 工具） |

LLM 和 embedding 调用使用原生 HTTP——不需要额外 SDK。

---

## 许可证

MIT
