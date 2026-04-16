<div align="center">

# 🌊 Aquifer

**基於 PostgreSQL 的 AI Agent 長期記憶系統**

*Turn 級 embedding、三路 RRF 混合排序、信任評分、實體交叉查詢、知識圖譜、實體作用域——全部跑在 PostgreSQL + pgvector 上。*

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
| **依賴** | `pg` + MCP SDK | 多個 SDK |

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
  db: 'postgresql://user:pass@localhost:5432/mydb',  // 連線字串或 pg.Pool
  schema: 'memory',                    // PG schema 名稱（預設 'aquifer'）
  tenantId: 'default',                 // 多租戶隔離
  embed: {
    fn: async (texts) => embeddings,   // 你的 embedding 函式
    dim: 1024,                         // 選填，維度提示
  },
  llm: {
    fn: async (prompt) => text,        // 你的 LLM 函式（內建摘要用）
  },
  entities: {
    enabled: true,
    scope: 'my-app',                   // 實體命名空間（預設 'default'）
  },
});

// 執行 migration（可重複執行）
await aquifer.migrate();
```

### 寫入路徑：commit + enrich

```javascript
// 1. 儲存 session
await aquifer.commit('conv-001', [
  { role: 'user', content: '我來說說新的 auth 做法...' },
  { role: 'assistant', content: '了解，所以計畫是...' },
], { agentId: 'main' });

// 2. 豐富化：摘要 + turn embedding + 實體擷取
const result = await aquifer.enrich('conv-001', {
  agentId: 'main',
  summaryFn: async (msgs) => ({ summaryText, structuredSummary, entityRaw }),
  entityParseFn: (text) => [{ name, normalizedName, type, aliases }],
  postProcess: async (ctx) => { /* 後處理 hook */ },
});
```

### 查詢路徑：recall

```javascript
const results = await aquifer.recall('auth middleware 決定', {
  agentId: 'main',
  limit: 5,
  entities: ['auth-middleware'],       // 選填：實體感知搜尋
  entityMode: 'all',                   // 'any'（加分）或 'all'（硬篩）
});
// 回傳排序後的 session，使用三路 RRF 融合
```

---

## 主機整合（Host Integration）

MCP 是主要的整合介面。Agent 主機連接 Aquifer MCP 伺服器，伺服器提供五個工具：`session_recall`、`session_feedback`、`session_bootstrap`、`memory_stats`、`memory_pending`。

| 整合方式 | 路由 | 狀態 | 使用時機 |
|----------|------|------|----------|
| MCP 伺服器 | `consumers/mcp.js` | 主要 | Claude Code、OpenClaw、Codex、任何支援 MCP 的主機 |
| Library API | `createAquifer()` | 主要 | 後端應用、自訂 pipeline、直接 Node.js 使用 |
| CLI | `consumers/cli.js` | 次要 | 維運、除錯、手動 recall/backfill |
| OpenCode 匯入 | `consumers/opencode.js` | 次要 | 從 OpenCode 的 SQLite DB 匯入 session |
| OpenClaw plugin | `consumers/openclaw-plugin.js` | 相容性 | 透過 `before_reset` 擷取 session——不用於工具傳遞 |

### Claude Code

加入你的專案 `.claude.json` 或使用者層級 MCP 設定：

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

工具會以 `mcp__aquifer__session_recall`、`mcp__aquifer__session_feedback` 等名稱出現。

### OpenClaw

加入 `openclaw.json` 的 `mcp.servers` 區段：

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

工具會以 `aquifer__session_recall`、`aquifer__session_feedback`、`aquifer__memory_stats`、`aquifer__memory_pending` 等名稱出現（主機自動加上伺服器名稱前綴）。

OpenClaw plugin（`consumers/openclaw-plugin.js`）保留用於 `before_reset` session 擷取，但**不是**建議的工具傳遞方式。請用 MCP。

### 其他支援 MCP 的主機

任何支援 MCP stdio 的主機都能以同樣方式連接——指向 `node consumers/mcp.js` 並設定必要的環境變數。MCP 伺服器是對外的標準介面。

---

## 環境變數

| 變數 | 必填？ | 用途 | 範例 |
|------|--------|------|------|
| `DATABASE_URL` | 是 | PostgreSQL 連線字串 | `postgresql://user:pass@localhost:5432/mydb` |
| `AQUIFER_SCHEMA` | 否 | PG schema 名稱（預設：`aquifer`） | `memory` |
| `AQUIFER_TENANT_ID` | 否 | 多租戶 key（預設：`default`） | `my-app` |
| `AQUIFER_EMBED_BASE_URL` | 是（recall 必需） | Embedding API base URL | `http://localhost:11434/v1` |
| `AQUIFER_EMBED_MODEL` | 是（recall 必需） | Embedding 模型名稱 | `bge-m3` |
| `AQUIFER_EMBED_API_KEY` | 視供應商 | 託管 embedding 供應商的 API key | `sk-...` |
| `AQUIFER_EMBED_DIM` | 否 | Embedding 維度覆寫（自動偵測） | `1024` |
| `AQUIFER_LLM_BASE_URL` | 否 | LLM API base URL（內建摘要用） | `http://localhost:11434/v1` |
| `AQUIFER_LLM_MODEL` | 否 | LLM 模型名稱 | `llama3.1` |
| `AQUIFER_LLM_API_KEY` | 視供應商 | 託管 LLM 供應商的 API key | `sk-...` |
| `AQUIFER_ENTITIES_ENABLED` | 否 | 啟用知識圖譜（預設：`false`） | `true` |
| `AQUIFER_ENTITY_SCOPE` | 否 | 實體命名空間（預設：`default`） | `my-app` |
| `AQUIFER_RERANK_ENABLED` | 否 | 啟用 cross-encoder reranking | `true` |
| `AQUIFER_RERANK_PROVIDER` | 否 | Reranker 供應商：`tei`、`jina`、`openrouter` | `tei` |
| `AQUIFER_RERANK_BASE_URL` | 否 | Reranker 端點 | `http://localhost:8080` |
| `AQUIFER_AGENT_ID` | 否 | 預設 agent ID | `main` |

完整的環境變數對應設定在 [consumers/shared/config.js](consumers/shared/config.js)。

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
    ┌────▼───────────┐    ┌───▼──┐  │rerank.js      │
    │  PostgreSQL     │    │ LLM  │  └───────────────┘
    │  + pgvector     │    │ API  │
    └────────────────┘    └──────┘

    ┌───────────────────────────────────┐
    │         schema/                   │
    │  001-base.sql（sessions、          │
    │    summaries、turns、FTS）          │
    │  002-entities.sql（KG）             │
    │  003-trust-feedback.sql（信任評分） │
    └───────────────────────────────────┘
```

### 檔案說明

| 檔案 | 用途 |
|------|------|
| `index.js` | 入口——匯出 `createAquifer`、`createEmbedder`、`createReranker`、`normalizeSession` |
| `core/aquifer.js` | 主 facade：`migrate()`、`ingest()`、`recall()`、`enrich()` |
| `core/storage.js` | Session/摘要/turn 的 CRUD、FTS 搜尋、embedding 搜尋 |
| `core/entity.js` | 實體 upsert、mention 追蹤、關係圖譜、名稱正規化 |
| `core/hybrid-rank.js` | 三路 RRF 融合、時間衰減、信任乘數、實體加分、open-loop 加分 |
| `pipeline/summarize.js` | LLM 驅動的 session 摘要（結構化輸出） |
| `pipeline/embed.js` | Embedding 客戶端（任何 OpenAI 相容 API） |
| `pipeline/extract-entities.js` | LLM 驅動的實體擷取（12 種類型） |
| `pipeline/rerank.js` | Cross-encoder reranking（TEI、Jina、OpenRouter） |
| `pipeline/normalize/` | Session 正規化，處理 Claude Code / gateway 噪音 |
| `consumers/opencode.js` | OpenCode SQLite 匯入消費者 |
| `schema/001-base.sql` | DDL：sessions、summaries、turn_embeddings、FTS 索引 |
| `schema/002-entities.sql` | DDL：entities、mentions、relations、entity_sessions |
| `schema/003-trust-feedback.sql` | DDL：trust_score 欄位、session_feedback 稽核表 |

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
- **信任評分** — 根據明確回饋（helpful/unhelpful）的乘法信任係數
- **Open-loop 加分** — 有未解決項目的 session 獲得輕微提升
- **選填 cross-encoder reranking** — 支援 TEI、Jina、OpenRouter，在 RRF 融合後對候選結果做二次精排

### 實體交叉查詢

明確指定要搜尋的實體時，可以做 AND 語意篩選：

```javascript
const results = await aquifer.recall('auth 決定', {
  entities: ['auth-middleware', 'legal-compliance'],
  entityMode: 'all',  // 只回傳同時包含兩個實體的 session
});
```

- `entityMode: 'any'`（預設）— 提升匹配任一實體的 session
- `entityMode: 'all'` — 硬篩：只回傳包含所有指定實體的 session

### 信任評分與回饋

Session 透過明確回饋累積信任分數。低信任的記憶在排序中會被壓制，無論相關性多高。

```javascript
// 回傳結果有用
await aquifer.feedback('session-id', { verdict: 'helpful' });

// 回傳結果無關
await aquifer.feedback('session-id', { verdict: 'unhelpful' });
```

- 非對稱：helpful +0.05，unhelpful −0.10（低品質記憶下沉更快）
- 排序中用乘法：trust=0.5 中性、trust=0 分數減半、trust=1.0 提升 50%
- 完整稽核記錄在 `session_feedback` 表

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

回傳一個 Aquifer 實例。設定：

```javascript
{
  db,          // PG 連線字串或 Pool 實例（必填）
  schema,      // PG schema 名稱（預設 'aquifer'）
  tenantId,    // 多租戶 key（預設 'default'）
  embed: { fn, dim },      // embedding 函式（recall 必需）
  llm: { fn },             // LLM 函式（內建摘要必需）
  entities: {
    enabled,               // 啟用知識圖譜（預設 false）
    scope,                 // 實體命名空間（預設 'default'）
    mergeCall,             // 合併實體擷取到摘要 LLM 呼叫（預設 true）
  },
  rank: { rrf, timeDecay, access, entityBoost },  // 權重覆寫
}
```

#### `aquifer.migrate()`

執行 SQL migration（冪等）。建立表、索引、trigger 和擴充套件。

#### `aquifer.commit(sessionId, messages, opts)`

儲存 session。回傳 `{ id, sessionId, isNew }`。

#### `aquifer.enrich(sessionId, opts)`

豐富化已 commit 的 session：摘要、turn embedding、實體擷取。支援自訂 pipeline（`summaryFn`、`entityParseFn`）和 `postProcess` 後處理 hook。使用 optimistic locking，卡住超過 10 分鐘的 processing session 可被回收。

#### `aquifer.recall(query, opts)`

三路混合搜尋。支援 `entities` + `entityMode` 做實體感知查詢。

```javascript
const results = await aquifer.recall('搜尋關鍵字', {
  agentId: 'main',
  limit: 10,
  entities: ['postgres', 'migration'],
  entityMode: 'all',
  weights: { rrf, timeDecay, access, entityBoost },
});
```

#### `aquifer.feedback(sessionId, opts)`

記錄信任回饋。回傳 `{ trustBefore, trustAfter, verdict }`。

#### `aquifer.bootstrap(opts)`

基於時間的 session 上下文載入器，用於新對話啟動時取得近期記憶摘要。跨 session 去重、sentinel 過濾、maxChars 截斷。

```javascript
const context = await aquifer.bootstrap({
  agentId: 'main',
  limit: 5,              // 回傳筆數（預設 5）
  lookbackDays: 14,      // 回溯天數（預設 14）
  maxChars: 4000,        // 最大字元數截斷（預設 4000）
  format: 'text',        // 'text' | 'structured' | 'both'
});
```

參數說明：

| 參數 | 預設值 | 說明 |
|------|--------|------|
| `agentId` | — | Agent ID |
| `limit` | 5 | 回傳的 session 數量上限 |
| `lookbackDays` | 14 | 往前查詢的天數 |
| `maxChars` | 4000 | 輸出最大字元數，超過自動截斷 |
| `format` | `'text'` | 輸出格式：`'text'`（純文字）、`'structured'`（結構化）、`'both'`（兩者） |

此方法對應 MCP 工具 `session_bootstrap`。

#### `aquifer.close()`

關閉 PostgreSQL 連線池（僅限 Aquifer 自行建立的 pool）。

---

## 設定

Aquifer 接受 `db` 連線（字串或 `pg.Pool`），加上選填的 `embed` 和 `llm` 函式：

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
    scope: 'my-app',           // 實體命名空間——與 agentId 解耦
    mergeCall: true,
  },
  rank: { rrf: 0.65, timeDecay: 0.25, access: 0.10, entityBoost: 0.18 },
});
```

### 實體作用域（Entity Scope）

`entities.scope` 定義實體身份的命名空間。唯一約束是 `(tenant_id, normalized_name, entity_scope)`——不同 scope 中的同名實體會建立獨立的實體。這讓實體身份與 `agentId` 解耦，允許多個 agent 共享同一個實體命名空間。

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
| `entities` | 正規化命名實體，含類型、別名、頻率、entity_scope、選填 embedding |
| `entity_mentions` | 實體 × session 關聯，含 mention 次數與上下文 |
| `entity_relations` | 共現邊（無向，`CHECK src < dst`） |
| `entity_sessions` | 實體-session 關聯，用於加分計算 |

重要索引：實體名稱 trigram、embedding GiST、`(tenant_id, normalized_name, entity_scope)` 唯一索引。

### 003-trust-feedback.sql

| 表 | 用途 |
|----|------|
| `session_feedback` | 明確回饋稽核記錄（helpful/unhelpful 判決、信任分數變動） |

另在 `session_summaries` 新增 `trust_score` 欄位（預設 0.5，範圍 0–1）。

---

## 疑難排解

**`error: type "vector" does not exist`** — pgvector 擴充套件未安裝。以 superuser 執行 `CREATE EXTENSION IF NOT EXISTS vector;`，或使用已內建 pgvector 的 `pgvector/pgvector` Docker image。

**`aquifer mcp requires @modelcontextprotocol/sdk and zod`** — 這些現在是正式依賴，應該會自動安裝。若看到此錯誤，重新執行 `npm install` 確保所有依賴已就位。

**Recall 沒有回傳結果** — 確認你在 `commit` 之後有執行 `enrich`。未豐富化的 session 無法被搜尋（需要摘要 + embedding）。用 `aquifer stats` 檢查摘要和 turn embedding 是否存在。

**OpenClaw 看不到工具** — 請在 `openclaw.json` 使用 `mcp.servers.aquifer`，不要用 plugin。工具會以 `aquifer__session_recall` 等名稱出現。Plugin（`consumers/openclaw-plugin.js`）僅用於 session 擷取。

**Embedding 供應商連線被拒** — 確認 `AQUIFER_EMBED_BASE_URL` 可以連通。若使用本地 Ollama，確保伺服器正在執行且模型已下載（`ollama pull bge-m3`）。

---

## 依賴

| 套件 | 用途 |
|------|------|
| `pg` ≥ 8.13 | PostgreSQL 客戶端 |
| `@modelcontextprotocol/sdk` ≥ 1.29 | MCP 伺服器協定 |
| `zod` ≥ 3.25 | Schema 驗證（MCP 工具） |

LLM 和 embedding 呼叫使用原生 HTTP——不需要額外 SDK。

---

## 授權

MIT
