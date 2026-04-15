<div align="center">

# 🌊 Aquifer

**PG-native long-term memory for AI agents**

*Turn-level embedding, hybrid RRF ranking, trust scoring, entity intersection, knowledge graph, entity scoping — all on PostgreSQL + pgvector.*

[![npm version](https://img.shields.io/npm/v/@shadowforge0/aquifer-memory)](https://www.npmjs.com/package/@shadowforge0/aquifer-memory)
[![PostgreSQL 15+](https://img.shields.io/badge/PostgreSQL-15%2B-336791)](https://www.postgresql.org/)
[![pgvector](https://img.shields.io/badge/pgvector-0.7%2B-blue)](https://github.com/pgvector/pgvector)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [繁體中文](README_TW.md) | [简体中文](README_CN.md)

</div>

---

## Why Aquifer?

Most AI memory systems bolt a vector DB on the side. Aquifer takes a different approach: **PostgreSQL is the memory**.

Sessions, summaries, turn-level embeddings, entity graph — all live in one database, queried with one connection. No sync layer, no eventual consistency, no extra infrastructure.

### What makes it different

| | Aquifer | Typical vector-DB approach |
|---|---|---|
| **Storage** | PostgreSQL + pgvector | Separate vector DB + app DB |
| **Granularity** | Turn-level embeddings (not just session summaries) | Session or document chunks |
| **Ranking** | 3-way RRF: FTS + session embedding + turn embedding | Single vector similarity |
| **Knowledge graph** | Built-in entity extraction & co-occurrence | Usually separate system |
| **Multi-tenant** | `tenant_id` on every table, day-1 | Often an afterthought |
| **Dependencies** | Just `pg` | Multiple SDKs |

### Before and after

**Without turn-level memory — search misses precise moments:**

> Query: "What did we decide about the auth middleware?"
> → Returns a 2000-word session summary that mentions auth somewhere

**With Aquifer — search finds the exact turn:**

> Query: "What did we decide about the auth middleware?"
> → Returns the specific user turn: "Let's rip out the old auth middleware — legal flagged it for session token compliance"

---

## Quick Start

### Prerequisites

- Node.js >= 18
- PostgreSQL 15+ with [pgvector](https://github.com/pgvector/pgvector) extension
- An embedding API (OpenAI, Ollama, or any OpenAI-compatible endpoint)

### Install

```bash
npm install @shadowforge0/aquifer-memory
```

### Initialize

```javascript
const { createAquifer } = require('@shadowforge0/aquifer-memory');

const aquifer = createAquifer({
  db: 'postgresql://user:pass@localhost:5432/mydb',  // connection string or pg.Pool
  schema: 'memory',                    // PG schema name (default: 'aquifer')
  tenantId: 'default',                 // multi-tenant isolation
  embed: {
    fn: async (texts) => embeddings,   // your embedding function
    dim: 1024,                         // optional dimension hint
  },
  llm: {
    fn: async (prompt) => text,        // your LLM function (for built-in summarize)
  },
  entities: {
    enabled: true,
    scope: 'my-app',                   // entity namespace (default: 'default')
  },
});

// Run migrations (safe to call multiple times)
await aquifer.migrate();
```

### Write path: commit + enrich

```javascript
// 1. Store the session
await aquifer.commit('conv-001', [
  { role: 'user', content: 'Let me tell you about our new auth approach...' },
  { role: 'assistant', content: 'Got it. So the plan is...' },
], { agentId: 'main' });

// 2. Enrich: summarize + embed turns + extract entities
const result = await aquifer.enrich('conv-001', {
  agentId: 'main',
  // Optional: bring your own summarize pipeline
  summaryFn: async (msgs) => ({ summaryText, structuredSummary, entityRaw }),
  entityParseFn: (text) => [{ name, normalizedName, type, aliases }],
  // Optional: post-commit hook for downstream processing
  postProcess: async (ctx) => {
    // ctx contains session, summary, embedding, parsedEntities, etc.
  },
});
```

### Read path: recall

```javascript
const results = await aquifer.recall('auth middleware decision', {
  agentId: 'main',
  limit: 5,
  entities: ['auth-middleware'],       // optional: entity-aware search
  entityMode: 'all',                   // 'any' (boost) or 'all' (hard filter)
});
// Returns ranked sessions with scores, using 3-way RRF fusion
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Agent Hosts                              │
│   Claude Code · OpenClaw · Codex · OpenCode · ...            │
└──────────────────────┬───────────────────────────────────────┘
                       │ MCP (stdio or HTTP)
┌──────────────────────▼───────────────────────────────────────┐
│              Aquifer MCP Server (canonical API)               │
│   session_recall · session_feedback · memory_stats · ...     │
└──────────────────────┬───────────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────────┐
│                    createAquifer (engine)                     │
│         Config · Migration · Ingest · Recall · Enrich        │
└────────┬──────────┬──────────┬──────────┬────────────────────┘
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

    ┌──────────────────────────────────┐
    │         schema/                  │
    │  001-base.sql (sessions,         │
    │    summaries, turns, FTS)        │
    │  002-entities.sql (KG)           │
    │  003-trust-feedback.sql (trust)  │
    └──────────────────────────────────┘
```

**Integration model:** MCP is the primary integration surface. Agent hosts connect to Aquifer through the MCP server (`consumers/mcp.js`), which exposes `session_recall`, `session_feedback`, `memory_stats`, and `memory_pending`. The CLI wraps the same engine for command-line use. The OpenClaw plugin (`consumers/openclaw-plugin.js`) is retained as a compatibility adapter for session capture but is not the primary tool delivery path.

### File Reference

| File | Purpose |
|------|---------|
| `index.js` | Entry point — exports `createAquifer`, `createEmbedder`, `createReranker`, `normalizeSession` |
| `core/aquifer.js` | Main facade: `migrate()`, `ingest()`, `recall()`, `enrich()` |
| `core/storage.js` | Session/summary/turn CRUD, FTS search, embedding search |
| `core/entity.js` | Entity upsert, mention tracking, relation graph, normalization |
| `core/hybrid-rank.js` | 3-way RRF fusion, time decay, trust multiplier, entity boost, open-loop boost |
| `pipeline/summarize.js` | LLM-powered session summarization with structured output |
| `pipeline/embed.js` | Embedding client (any OpenAI-compatible API) |
| `pipeline/extract-entities.js` | LLM-powered entity extraction (12 types) |
| `pipeline/rerank.js` | Cross-encoder reranking (TEI, Jina, OpenRouter) |
| `pipeline/normalize/` | Session normalization for Claude Code / gateway noise |
| `schema/001-base.sql` | DDL: sessions, summaries, turn_embeddings, FTS indexes |
| `schema/002-entities.sql` | DDL: entities, mentions, relations, entity_sessions |
| `schema/003-trust-feedback.sql` | DDL: trust_score column, session_feedback audit trail |

---

## Core Features

### 3-Way Hybrid Retrieval (RRF)

```
Query ──┬── FTS (BM25)              ──┐
        ├── Session embedding search ──├── RRF Fusion → Time Decay → Entity Boost → Results
        └── Turn embedding search   ──┘
```

- **Full-text search** — PostgreSQL `tsvector` with language-aware ranking
- **Session embedding** — cosine similarity on session summaries
- **Turn embedding** — cosine similarity on individual user turns
- **Reciprocal Rank Fusion** — merges all three ranked lists (K=60)
- **Time decay** — sigmoid decay with configurable midpoint and steepness
- **Entity boost** — sessions mentioning query-relevant entities get a score boost
- **Trust scoring** — multiplicative trust multiplier from explicit feedback (helpful/unhelpful)
- **Open-loop boost** — sessions with unresolved items get a mild recency boost

### Entity Intersection

When you know which entities you're looking for, pass them explicitly:

```javascript
const results = await aquifer.recall('auth decision', {
  entities: ['auth-middleware', 'legal-compliance'],
  entityMode: 'all',  // only sessions containing BOTH entities
});
```

- `entityMode: 'any'` (default) — boost sessions matching any queried entity
- `entityMode: 'all'` — hard filter: only return sessions containing every specified entity

### Trust Scoring & Feedback

Sessions accumulate trust through explicit feedback. Low-trust memories are suppressed in rankings regardless of relevance.

```javascript
// After a recall result was useful
await aquifer.feedback('session-id', { verdict: 'helpful' });

// After a recall result was irrelevant
await aquifer.feedback('session-id', { verdict: 'unhelpful' });
```

- Asymmetric: helpful +0.05, unhelpful −0.10 (bad memories sink faster)
- Multiplicative in ranking: trust=0.5 is neutral, trust=0 halves the score, trust=1.0 gives 50% boost
- Full audit trail in `session_feedback` table

### Turn-Level Embeddings

Not just session summaries — Aquifer embeds each meaningful user turn individually.

- Filters noise: short messages, slash commands, confirmations ("ok", "got it")
- Truncates at 2000 chars, skips turns under 5 chars
- Stores turn text + embedding + position for precise retrieval

### Knowledge Graph

Built-in entity extraction and relationship tracking:

- **12 entity types**: person, project, concept, tool, metric, org, place, event, doc, task, topic, other
- **Entity normalization**: NFKC + homoglyph mapping + case folding
- **Co-occurrence relations**: undirected edges with frequency tracking
- **Entity-session mapping**: which entities appear in which sessions
- **Entity boost in ranking**: sessions with relevant entities score higher

---

## Benchmark: LongMemEval

We tested Aquifer's retrieval pipeline on [LongMemEval_S](https://github.com/xiaowu0162/LongMemEval) — 470 questions across 19,195 sessions (98,845 turn embeddings).

**Setup:** Per-question haystack scoping (matching official methodology), bge-m3 embeddings via OpenRouter, turn-level user-only embedding.

| Metric | Aquifer (bge-m3) |
|--------|-----------------|
| R@1 | 89.6% |
| R@3 | 96.6% |
| R@5 | 98.1% |
| R@10 | 98.9% |

**Key finding:** Turn-level embedding is the main driver — going from session-level (R@1=26.8%) to turn-level (R@1=89.6%) is a 3x improvement.

### Multi-Tenant

Every table includes `tenant_id` (default: `'default'`). Isolation is enforced at the query level — no cross-tenant data leakage by design.

### Schema-per-deployment

Pass `schema: 'my_app'` to `createAquifer()` and all tables live under that PostgreSQL schema. Run multiple Aquifer instances in the same database without conflicts.

---

## API Reference

### `createAquifer(config)`

Returns an Aquifer instance. Config:

```javascript
{
  db,          // pg connection string or Pool instance (required)
  schema,      // PG schema name (default: 'aquifer')
  tenantId,    // multi-tenant key (default: 'default')
  embed: { fn, dim },      // embedding function (required for recall)
  llm: { fn },             // LLM function (required for built-in summarize)
  entities: {
    enabled,               // enable KG (default: false)
    scope,                 // entity namespace (default: 'default')
    mergeCall,             // merge entity extraction into summary LLM call (default: true)
  },
  rank: { rrf, timeDecay, access, entityBoost },  // weight overrides
}
```

#### `aquifer.migrate()`

Runs SQL migrations (idempotent). Creates tables, indexes, triggers, and extensions.

#### `aquifer.commit(sessionId, messages, opts)`

Stores a session. Returns `{ id, sessionId, isNew }`.

```javascript
await aquifer.commit('session-001', messages, {
  agentId: 'main',
  source: 'api',
  sessionKey: 'optional-key',
  model: 'gpt-4o',
  tokensIn: 1500,
  tokensOut: 800,
  startedAt: isoString,
  lastMessageAt: isoString,
});
```

#### `aquifer.enrich(sessionId, opts)`

Enriches a committed session: summarize, embed turns, extract entities. Uses optimistic locking with stale-reclaim (sessions stuck processing > 10 min are reclaimable).

```javascript
const result = await aquifer.enrich('session-001', {
  agentId: 'main',
  summaryFn,          // custom summarize pipeline (bypasses built-in LLM)
  entityParseFn,      // custom entity parser
  postProcess,        // async callback after tx commit
  model: 'override',  // model metadata override
  skipSummary: false,
  skipTurnEmbed: false,
  skipEntities: false,
});
// Returns: { summary, turnsEmbedded, entitiesFound, warnings, effectiveModel, postProcessError }
```

**postProcess hook**: runs after transaction commit, receives full context (session, summary, embedding, parsedEntities, etc.). Best-effort, at-most-once.

#### `aquifer.recall(query, opts)`

Hybrid search across sessions using 3-way RRF.

```javascript
const results = await aquifer.recall('search query', {
  agentId: 'main',
  limit: 10,
  entities: ['postgres', 'migration'],
  entityMode: 'all',            // 'any' (default) or 'all'
  weights: { rrf, timeDecay, access, entityBoost },
});
// Returns: [{ sessionId, score, trustScore, summaryText, matchedTurnText, _debug, ... }]
```

#### `aquifer.feedback(sessionId, opts)`

Records trust feedback. Returns `{ trustBefore, trustAfter, verdict }`.

```javascript
await aquifer.feedback('session-id', {
  verdict: 'helpful',   // or 'unhelpful'
  agentId: 'main',
  note: 'reason',
});
```

#### `aquifer.close()`

Closes the PostgreSQL connection pool (only if Aquifer created it).

---

## Configuration

Aquifer takes a `db` connection (string or `pg.Pool`), plus optional `embed` and `llm` functions:

```javascript
createAquifer({
  db: 'postgresql://user:pass@localhost/mydb',  // or an existing pg.Pool
  schema: 'aquifer',           // PG schema (default: 'aquifer')
  tenantId: 'default',         // multi-tenant key
  embed: {
    fn: myEmbedFn,             // async (texts: string[]) => number[][]
    dim: 1024,                 // optional dimension hint
  },
  llm: {
    fn: myLlmFn,               // async (prompt: string) => string
  },
  entities: {
    enabled: true,             // enable KG (default: false)
    scope: 'my-app',           // entity namespace — decoupled from agentId
    mergeCall: true,           // merge entity extraction into summary prompt
  },
  rank: {
    rrf: 0.65,                 // FTS + embedding fusion weight
    timeDecay: 0.25,           // recency weight
    access: 0.10,              // access frequency weight
    entityBoost: 0.18,         // entity match boost
  },
});
```

### Entity Scope

`entities.scope` defines the namespace for entity identity. The unique constraint is `(tenant_id, normalized_name, entity_scope)` — the same entity name in different scopes creates separate entities. This decouples entity identity from `agentId`, allowing multiple agents to share an entity namespace.

Fallback chain: `config.entities.scope` → `'default'`.

### MCP Server (primary integration)

Agent hosts should connect through the Aquifer MCP server. For OpenClaw, add to `openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "aquifer": {
        "command": "node",
        "args": ["/path/to/aquifer/consumers/mcp.js"],
        "env": {
          "DATABASE_URL": "postgresql://...",
          "AQUIFER_SCHEMA": "aquifer",
          "AQUIFER_EMBED_BASE_URL": "http://localhost:11434/v1",
          "AQUIFER_EMBED_MODEL": "bge-m3"
        }
      }
    }
  }
}
```

Tools are exposed as `aquifer__session_recall`, `aquifer__session_feedback`, `aquifer__memory_stats`, `aquifer__memory_pending` (server name prefix is added by the host).

For Claude Code, add to `.claude.json`:

```json
{
  "mcpServers": {
    "aquifer": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/aquifer/consumers/mcp.js"]
    }
  }
}
```

### CLI (secondary)

For command-line use with environment variables:

```bash
export DATABASE_URL="postgresql://..."
export AQUIFER_EMBED_BASE_URL="http://localhost:11434/v1"
export AQUIFER_EMBED_MODEL="bge-m3"
export AQUIFER_ENTITIES_ENABLED=true

aquifer migrate
aquifer recall "search query" --limit 5
aquifer backfill --concurrency 3
aquifer stats --json
```

---

## Database Schema

### 001-base.sql

| Table | Purpose |
|-------|---------|
| `sessions` | Raw conversation data with messages (JSONB), token counts, timestamps |
| `session_summaries` | LLM-generated structured summaries with embeddings |
| `turn_embeddings` | Per-turn user message embeddings for precise retrieval |

Key indexes: GIN on messages, GiST on `tsvector`, ivfflat on embeddings, B-tree on tenant/agent/timestamps.

### 002-entities.sql

| Table | Purpose |
|-------|---------|
| `entities` | Normalized named entities with type, aliases, frequency, entity_scope, optional embedding |
| `entity_mentions` | Entity × session join with mention count and context |
| `entity_relations` | Co-occurrence edges (undirected, `CHECK src < dst`) |
| `entity_sessions` | Entity-session association for boost scoring |

Key indexes: trigram on entity names, GiST on embeddings, unique on `(tenant_id, normalized_name, entity_scope)`.

### 003-trust-feedback.sql

| Table | Purpose |
|-------|---------|
| `session_feedback` | Explicit feedback audit trail (helpful/unhelpful verdicts, trust deltas) |

Also adds `trust_score` column to `session_summaries` (default 0.5, range 0–1).

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `pg` ≥ 8.13 | PostgreSQL client |

That's it. Aquifer has **one runtime dependency**.

LLM and embedding calls use raw HTTP — no SDK required.

---

## License

MIT
