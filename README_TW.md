<div align="center">

# 🌊 Aquifer

**基於 PostgreSQL 的 AI Agent 長期記憶系統**

*Turn 級 embedding、三路 RRF 混合排序、內建知識圖譜——全部跑在 PostgreSQL + pgvector 上。*

[![npm version](https://img.shields.io/npm/v/@shadowforge0/aquifer-memory)](https://www.npmjs.com/package/@shadowforge0/aquifer-memory)
[![PostgreSQL 15+](https://img.shields.io/badge/PostgreSQL-15%2B-336791)](https://www.postgresql.org/)
[![pgvector](https://img.shields.io/badge/pgvector-0.7%2B-blue)](https://github.com/pgvector/pgvector)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [繁體中文](README_TW.md) | [简体中文](README_CN.md)

</div>

---

## 為什麼選 Aquifer？

多數 AI 記憶系統會在旁邊掛一個向量資料庫。Aquifer 的做法不同：**PostgreSQL 就是記憶本體**。

Session、摘要、turn 級 embedding、實體圖譜——全部住在同一個資料庫裡，用同一個連線查詢。不需要同步層、沒有最終一致性問題、不用額外基礎設施。

### 跟典型做法的差異

| | Aquifer | 典型向量 DB 做法 |
|---|---|---|
| **儲存** | PostgreSQL + pgvector | 獨立向量 DB + 應用 DB |
| **粒度** | Turn 級 embedding（不只是 session 摘要） | Session 或文件切片 |
| **排序** | 三路 RRF：FTS + session embedding + turn embedding | 單一向量相似度 |
| **知識圖譜** | 內建實體擷取與共現關係 | 通常是獨立系統 |
| **多租戶** | 每張表都有 `tenant_id`，第一天就內建 | 通常是事後補做 |
| **依賴** | 只有 `pg` | 多個 SDK |

### 有和沒有的差別

**沒有 turn 級記憶——搜尋只能命中模糊的摘要：**

> 查詢：「我們對 auth middleware 做了什麼決定？」
> → 回傳一份 2000 字的 session 摘要，裡面某處提到了 auth

**有 Aquifer——搜尋直接命中精確的對話片段：**

> 查詢：「我們對 auth middleware 做了什麼決定？」
> → 回傳那句原話：「舊的 auth middleware 拆掉吧——法務說 session token 儲存方式不合規」

---

## 快速開始

### 前置需求

- Node.js >= 18
- PostgreSQL 15+，已安裝 [pgvector](https://github.com/pgvector/pgvector)
- Embedding API（OpenAI、Ollama 或任何 OpenAI 相容端點）

### 安裝

```bash
npm install @shadowforge0/aquifer-memory
```

### 初始化

```javascript
const { createAquifer } = require('@shadowforge0/aquifer-memory');

const aquifer = createAquifer({
  schema: 'memory',                    // PG schema 名稱（預設 'aquifer'）
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

// 執行 migration（可重複執行）
await aquifer.migrate();
```

### 寫入 session

```javascript
await aquifer.ingest({
  sessionId: 'conv-001',
  agentId: 'main',
  messages: [
    { role: 'user', content: '我來說說新的 auth 做法...' },
    { role: 'assistant', content: '了解，所以計畫是...' },
  ],
});
// 儲存 session → 生成摘要 → 建立 turn embedding → 擷取實體
```

### 查詢

```javascript
const results = await aquifer.recall('auth middleware 決定', {
  agentId: 'main',
  limit: 5,
});
// 回傳排序後的 session，使用三路 RRF 融合
```

---

## 架構

```
┌─────────────────────────────────────────────────────────────┐
│                    createAquifer（入口）                      │
│         設定 · Migration · Ingest · Recall · Enrich          │
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

### 檔案說明

| 檔案 | 用途 |
|------|------|
| `index.js` | 入口——匯出 `createAquifer`、`createEmbedder` |
| `core/aquifer.js` | 主 facade：`migrate()`、`ingest()`、`recall()`、`enrich()` |
| `core/storage.js` | Session/摘要/turn 的 CRUD、FTS 搜尋、embedding 搜尋 |
| `core/entity.js` | 實體 upsert、mention 追蹤、關係圖譜、名稱正規化 |
| `core/hybrid-rank.js` | 三路 RRF 融合、時間衰減、實體加分 |
| `pipeline/summarize.js` | LLM 驅動的 session 摘要（結構化輸出） |
| `pipeline/embed.js` | Embedding 客戶端（任何 OpenAI 相容 API） |
| `pipeline/extract-entities.js` | LLM 驅動的實體擷取（12 種類型） |
| `schema/001-base.sql` | DDL：sessions、summaries、turn_embeddings、FTS 索引 |
| `schema/002-entities.sql` | DDL：entities、mentions、relations、entity_sessions |

---

## 核心功能

### 三路混合檢索（RRF）

```
查詢 ──┬── FTS（BM25）              ──┐
       ├── Session embedding 搜尋   ──├── RRF 融合 → 時間衰減 → 實體加分 → 結果
       └── Turn embedding 搜尋     ──┘
```

- **全文搜尋** — PostgreSQL `tsvector`，支援多語言排序
- **Session embedding** — 對 session 摘要做 cosine 相似度
- **Turn embedding** — 對個別 user turn 做 cosine 相似度
- **Reciprocal Rank Fusion** — 合併三份排名清單（K=60）
- **時間衰減** — sigmoid 衰減，可設定中點與斜率
- **實體加分** — 包含查詢相關實體的 session 會獲得分數提升

### Turn 級 Embedding

不只是 session 摘要——Aquifer 對每一則有意義的 user turn 獨立 embedding。

- 過濾噪音：短訊息、斜線指令、確認語（「ok」「好」「收到」）
- 截斷 2000 字元，跳過 5 字元以下的 turn
- 儲存 turn 原文 + embedding + 位置，實現精確檢索

### 知識圖譜

內建實體擷取與關係追蹤：

- **12 種實體類型**：person、project、concept、tool、metric、org、place、event、doc、task、topic、other
- **實體正規化**：NFKC + 同形字映射 + 大小寫折疊
- **共現關係**：無向邊，帶頻率追蹤
- **實體-session 映射**：哪些實體出現在哪些 session
- **排序加分**：包含相關實體的 session 分數更高

---

## Benchmark：LongMemEval

我們用 [LongMemEval_S](https://github.com/xiaowu0162/LongMemEval) 測試 Aquifer 的檢索管線——470 題、19,195 個 sessions（98,845 個 turn embeddings）。

**設定：** Per-question haystack scoping（與官方方法一致）、bge-m3 embedding via OpenRouter、turn 級 user-only embedding。

| 指標 | Aquifer (bge-m3) |
|------|-----------------|
| R@1 | 89.6% |
| R@3 | 96.6% |
| R@5 | 98.1% |
| R@10 | 98.9% |

**重點發現：** Turn 級 embedding 是主力——從 session 級（R@1=26.8%）到 turn 級（R@1=89.6%）提升 3 倍。

### 多租戶

每張表都包含 `tenant_id`（預設：`'default'`）。隔離在查詢層強制執行——不會有跨租戶資料洩漏。

### Schema 隔離

傳入 `schema: 'my_app'` 給 `createAquifer()`，所有表都建在該 PostgreSQL schema 下。同一個資料庫可以跑多個 Aquifer 實例互不衝突。

---

## API 參考

### `createAquifer(config)`

回傳一個 Aquifer 實例，包含以下方法：

#### `aquifer.migrate()`

執行 SQL migration（冪等）。建立表、索引和擴充套件。

#### `aquifer.ingest(options)`

寫入 session：儲存訊息、生成摘要、建立 turn embedding、擷取實體。

```javascript
await aquifer.ingest({
  sessionId: 'unique-id',
  agentId: 'main',
  source: 'api',                // 選填，預設 'api'
  messages: [{ role, content }],
  tenantId: 'default',          // 選填
  model: 'gpt-4o',             // 選填，metadata
  tokensIn: 1500,              // 選填
  tokensOut: 800,              // 選填
});
```

#### `aquifer.recall(query, options)`

跨 session 混合搜尋。

```javascript
const results = await aquifer.recall('搜尋關鍵字', {
  agentId: 'main',
  tenantId: 'default',
  limit: 10,                    // 最大回傳數
  ftsLimit: 20,                 // FTS 候選池大小
  embLimit: 20,                 // embedding 候選池大小
  turnLimit: 20,                // turn embedding 候選池大小
  midpointDays: 45,             // 時間衰減中點
  entityBoostWeight: 0.18,      // 實體加分係數
});
// 回傳：[{ session_id, score, title, overview, started_at, ... }]
```

#### `aquifer.enrich(sessionId, options)`

重新處理既有 session：重新生成摘要、embedding 和實體。

#### `aquifer.close()`

關閉 PostgreSQL 連線池。

---

## 設定

```javascript
createAquifer({
  // PostgreSQL schema 名稱（所有表建在此 schema 下）
  schema: 'aquifer',

  // PostgreSQL 連線
  pg: {
    connectionString: 'postgresql://...',
    // 或分開設定：host, port, database, user, password
    max: 10,  // 連線池大小
  },

  // Embedding 供應商（任何 OpenAI 相容 API）
  embedder: {
    baseURL: 'http://localhost:11434/v1',
    model: 'bge-m3',
    apiKey: 'ollama',
    dimensions: 1024,           // 選填
    timeout: 30000,             // 毫秒，預設 30 秒
  },

  // LLM（用於摘要與實體擷取）
  llm: {
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60000,             // 毫秒，預設 60 秒
  },

  // 租戶隔離
  tenantId: 'default',
});
```

---

## 資料庫 Schema

### 001-base.sql

| 表 | 用途 |
|----|------|
| `sessions` | 原始對話資料，含 messages（JSONB）、token 數、時間戳記 |
| `session_summaries` | LLM 生成的結構化摘要，含 embedding |
| `turn_embeddings` | 逐 turn 的 user 訊息 embedding，實現精確檢索 |

重要索引：messages GIN、`tsvector` GiST、embedding ivfflat、tenant/agent/timestamp B-tree。

### 002-entities.sql

| 表 | 用途 |
|----|------|
| `entities` | 正規化命名實體，含類型、別名、頻率、選填 embedding |
| `entity_mentions` | 實體 × session 關聯，含 mention 次數與上下文 |
| `entity_relations` | 共現邊（無向，`CHECK src < dst`） |
| `entity_sessions` | 實體-session 關聯，用於加分計算 |

重要索引：實體名稱 trigram、embedding GiST、tenant/agent 複合索引。

---

## 依賴

| 套件 | 用途 |
|------|------|
| `pg` ≥ 8.13 | PostgreSQL 客戶端 |

就這樣。Aquifer 只有**一個執行時依賴**。

LLM 和 embedding 呼叫使用原生 HTTP——不需要任何 SDK。

---

## 授權

MIT
