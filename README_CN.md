<div align="center">

# 🌊 Aquifer

**基于 PostgreSQL 的 AI Agent 长期记忆系统**

*Turn 级 embedding、三路 RRF 混合排序、内建知识图谱——全部运行在 PostgreSQL + pgvector 上。*

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
| **依赖** | 只有 `pg` | 多个 SDK |

### 有和没有的差别

**没有 turn 级记忆——搜索只能命中模糊的摘要：**

> 查询："我们对 auth middleware 做了什么决定？"
> → 返回一份 2000 字的 session 摘要，里面某处提到了 auth

**有 Aquifer——搜索直接命中精确的对话片段：**

> 查询："我们对 auth middleware 做了什么决定？"
> → 返回那句原话："旧的 auth middleware 拆掉吧——法务说 session token 存储方式不合规"

---

## 快速开始

### 前置需求

- Node.js >= 18
- PostgreSQL 15+，已安装 [pgvector](https://github.com/pgvector/pgvector)
- Embedding API（OpenAI、Ollama 或任何 OpenAI 兼容端点）

### 安装

```bash
npm install @shadowforge0/aquifer-memory
```

### 初始化

```javascript
const { createAquifer } = require('@shadowforge0/aquifer-memory');

const aquifer = createAquifer({
  schema: 'memory',                    // PG schema 名称（默认 'aquifer'）
  pg: {
    connectionString: 'postgresql://user:pass@localhost:5432/mydb',
  },
  embedder: {
    baseURL: 'http://localhost:11434/v1',   // Ollama
    model: 'bge-m3',
    apiKey: 'ollama',
  },
  llm: {
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
  },
});

// 执行 migration（可重复执行）
await aquifer.migrate();
```

### 写入 session

```javascript
await aquifer.ingest({
  sessionId: 'conv-001',
  agentId: 'main',
  messages: [
    { role: 'user', content: '我来说说新的 auth 做法...' },
    { role: 'assistant', content: '了解，所以计划是...' },
  ],
});
// 存储 session → 生成摘要 → 创建 turn embedding → 提取实体
```

### 查询

```javascript
const results = await aquifer.recall('auth middleware 决定', {
  agentId: 'main',
  limit: 5,
});
// 返回排序后的 session，使用三路 RRF 融合
```

---

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    createAquifer（入口）                      │
│         配置 · Migration · Ingest · Recall · Enrich          │
└────────┬──────────┬──────────┬──────────┬───────────────────┘
         │          │          │          │
    ┌────▼───┐ ┌────▼────┐ ┌──▼───┐ ┌───▼──────────┐
    │storage │ │hybrid-  │ │entity│ │   pipeline/   │
    │  .js   │ │rank.js  │ │ .js  │ │summarize.js   │
    └────────┘ └─────────┘ └──────┘ │embed.js       │
         │                     │    │extract-ent.js │
    ┌────▼───────────┐    ┌───▼──┐  └───────────────┘
    │  PostgreSQL     │    │ LLM  │
    │  + pgvector     │    │ API  │
    └────────────────┘    └──────┘

    ┌─────────────────────────────┐
    │         schema/             │
    │  001-base.sql（sessions、   │
    │    summaries、turns、FTS）   │
    │  002-entities.sql（KG）      │
    └─────────────────────────────┘
```

### 文件说明

| 文件 | 用途 |
|------|------|
| `index.js` | 入口——导出 `createAquifer`、`createEmbedder` |
| `core/aquifer.js` | 主 facade：`migrate()`、`ingest()`、`recall()`、`enrich()` |
| `core/storage.js` | Session/摘要/turn 的 CRUD、FTS 搜索、embedding 搜索 |
| `core/entity.js` | 实体 upsert、mention 追踪、关系图谱、名称规范化 |
| `core/hybrid-rank.js` | 三路 RRF 融合、时间衰减、实体加分 |
| `pipeline/summarize.js` | LLM 驱动的 session 摘要（结构化输出） |
| `pipeline/embed.js` | Embedding 客户端（任何 OpenAI 兼容 API） |
| `pipeline/extract-entities.js` | LLM 驱动的实体提取（12 种类型） |
| `schema/001-base.sql` | DDL：sessions、summaries、turn_embeddings、FTS 索引 |
| `schema/002-entities.sql` | DDL：entities、mentions、relations、entity_sessions |

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

我们用 [LongMemEval_S](https://github.com/xiaowu0162/LongMemEval) 测试 Aquifer 的检索管线——470 题、19,195 个 sessions（98,845 个 turn embeddings）。

**设置：** Per-question haystack scoping（与官方方法一致）、bge-m3 embedding via OpenRouter、turn 级 user-only embedding。

| 指标 | Aquifer (bge-m3) |
|------|-----------------|
| R@1 | 89.6% |
| R@3 | 96.6% |
| R@5 | 98.1% |
| R@10 | 98.9% |

**关键发现：** Turn 级 embedding 是主力——从 session 级（R@1=26.8%）到 turn 级（R@1=89.6%）提升 3 倍。

### 多租户

每张表都包含 `tenant_id`（默认：`'default'`）。隔离在查询层强制执行——不会有跨租户数据泄漏。

### Schema 隔离

传入 `schema: 'my_app'` 给 `createAquifer()`，所有表都建在该 PostgreSQL schema 下。同一个数据库可以运行多个 Aquifer 实例互不冲突。

---

## API 参考

### `createAquifer(config)`

返回一个 Aquifer 实例，包含以下方法：

#### `aquifer.migrate()`

执行 SQL migration（幂等）。创建表、索引和扩展。

#### `aquifer.ingest(options)`

写入 session：存储消息、生成摘要、创建 turn embedding、提取实体。

```javascript
await aquifer.ingest({
  sessionId: 'unique-id',
  agentId: 'main',
  source: 'api',                // 可选，默认 'api'
  messages: [{ role, content }],
  tenantId: 'default',          // 可选
  model: 'gpt-4o',             // 可选，metadata
  tokensIn: 1500,              // 可选
  tokensOut: 800,              // 可选
});
```

#### `aquifer.recall(query, options)`

跨 session 混合搜索。

```javascript
const results = await aquifer.recall('搜索关键字', {
  agentId: 'main',
  tenantId: 'default',
  limit: 10,                    // 最大返回数
  ftsLimit: 20,                 // FTS 候选池大小
  embLimit: 20,                 // embedding 候选池大小
  turnLimit: 20,                // turn embedding 候选池大小
  midpointDays: 45,             // 时间衰减中点
  entityBoostWeight: 0.18,      // 实体加分系数
});
// 返回：[{ session_id, score, title, overview, started_at, ... }]
```

#### `aquifer.enrich(sessionId, options)`

重新处理已有 session：重新生成摘要、embedding 和实体。

#### `aquifer.close()`

关闭 PostgreSQL 连接池。

---

## 配置

```javascript
createAquifer({
  // PostgreSQL schema 名称（所有表创建在此 schema 下）
  schema: 'aquifer',

  // PostgreSQL 连接
  pg: {
    connectionString: 'postgresql://...',
    // 或分开配置：host, port, database, user, password
    max: 10,  // 连接池大小
  },

  // Embedding 提供商（任何 OpenAI 兼容 API）
  embedder: {
    baseURL: 'http://localhost:11434/v1',
    model: 'bge-m3',
    apiKey: 'ollama',
    dimensions: 1024,           // 可选
    timeout: 30000,             // 毫秒，默认 30 秒
  },

  // LLM（用于摘要与实体提取）
  llm: {
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60000,             // 毫秒，默认 60 秒
  },

  // 租户隔离
  tenantId: 'default',
});
```

---

## 数据库 Schema

### 001-base.sql

| 表 | 用途 |
|----|------|
| `sessions` | 原始对话数据，含 messages（JSONB）、token 数、时间戳 |
| `session_summaries` | LLM 生成的结构化摘要，含 embedding |
| `turn_embeddings` | 逐 turn 的 user 消息 embedding，实现精确检索 |

关键索引：messages GIN、`tsvector` GiST、embedding ivfflat、tenant/agent/timestamp B-tree。

### 002-entities.sql

| 表 | 用途 |
|----|------|
| `entities` | 规范化命名实体，含类型、别名、频率、可选 embedding |
| `entity_mentions` | 实体 × session 关联，含 mention 次数与上下文 |
| `entity_relations` | 共现边（无向，`CHECK src < dst`） |
| `entity_sessions` | 实体-session 关联，用于加分计算 |

关键索引：实体名称 trigram、embedding GiST、tenant/agent 复合索引。

---

## 依赖

| 包 | 用途 |
|----|------|
| `pg` ≥ 8.13 | PostgreSQL 客户端 |

就这样。Aquifer 只有**一个运行时依赖**。

LLM 和 embedding 调用使用原生 HTTP——不需要任何 SDK。

---

## 许可证

MIT
