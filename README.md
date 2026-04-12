<div align="center">

# 🌊 Aquifer

**PG-native long-term memory for AI agents**

*Turn-level embedding, hybrid RRF ranking, trust scoring, entity intersection, knowledge graph — all on PostgreSQL + pgvector.*

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
  schema: 'memory',                    // PG schema name (default: 'aquifer')
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

// Run migrations (safe to call multiple times)
await aquifer.migrate();
```

### Ingest a session

```javascript
await aquifer.ingest({
  sessionId: 'conv-001',
  agentId: 'main',
  messages: [
    { role: 'user', content: 'Let me tell you about our new auth approach...' },
    { role: 'assistant', content: 'Got it. So the plan is...' },
  ],
});
// Stores session → generates summary → creates turn embeddings → extracts entities
```

### Recall

```javascript
const results = await aquifer.recall('auth middleware decision', {
  agentId: 'main',
  limit: 5,
});
// Returns ranked sessions with scores, using 3-way RRF fusion
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    createAquifer (entry)                     │
│         Config · Migration · Ingest · Recall · Enrich       │
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

    ┌──────────────────────────────────┐
    │         schema/                  │
    │  001-base.sql (sessions,         │
    │    summaries, turns, FTS)        │
    │  002-entities.sql (KG)           │
    │  003-trust-feedback.sql (trust)  │
    └──────────────────────────────────┘
```

### File Reference

| File | Purpose |
|------|---------|
| `index.js` | Entry point — exports `createAquifer`, `createEmbedder` |
| `core/aquifer.js` | Main facade: `migrate()`, `ingest()`, `recall()`, `enrich()` |
| `core/storage.js` | Session/summary/turn CRUD, FTS search, embedding search |
| `core/entity.js` | Entity upsert, mention tracking, relation graph, normalization |
| `core/hybrid-rank.js` | 3-way RRF fusion, time decay, trust multiplier, entity boost, open-loop boost |
| `pipeline/summarize.js` | LLM-powered session summarization with structured output |
| `pipeline/embed.js` | Embedding client (any OpenAI-compatible API) |
| `pipeline/extract-entities.js` | LLM-powered entity extraction (12 types) |
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

Returns an Aquifer instance with the following methods:

#### `aquifer.migrate()`

Runs SQL migrations (idempotent). Creates tables, indexes, and extensions.

#### `aquifer.ingest(options)`

Ingests a session: stores messages, generates summary, creates turn embeddings, extracts entities.

```javascript
await aquifer.ingest({
  sessionId: 'unique-id',
  agentId: 'main',
  source: 'api',                // optional, default 'api'
  messages: [{ role, content }],
  tenantId: 'default',          // optional
  model: 'gpt-4o',             // optional metadata
  tokensIn: 1500,              // optional
  tokensOut: 800,              // optional
});
```

#### `aquifer.recall(query, options)`

Hybrid search across sessions.

```javascript
const results = await aquifer.recall('search query', {
  agentId: 'main',
  limit: 10,                    // max results
  entities: ['postgres', 'migration'],  // optional: explicit entity names
  entityMode: 'all',            // 'any' (default) or 'all'
  weights: {                    // optional: override ranking weights
    rrf: 0.65,
    timeDecay: 0.25,
    access: 0.10,
    entityBoost: 0.18,
    openLoop: 0.08,
  },
});
// Returns: [{ sessionId, score, trustScore, summaryText, matchedTurnText, _debug, ... }]
```

#### `aquifer.feedback(sessionId, options)`

Records explicit trust feedback on a session.

```javascript
await aquifer.feedback('session-id', {
  verdict: 'helpful',   // or 'unhelpful'
  agentId: 'main',      // optional
  note: 'reason',       // optional
});
// Returns: { trustBefore, trustAfter, verdict }
```

#### `aquifer.enrich(sessionId, options)`

Re-processes an existing session: regenerate summary, embeddings, and entities.

#### `aquifer.close()`

Closes the PostgreSQL connection pool.

---

## Configuration

```javascript
createAquifer({
  // PostgreSQL schema name (all tables created under this schema)
  schema: 'aquifer',

  // PostgreSQL connection
  pg: {
    connectionString: 'postgresql://...',
    // or individual: host, port, database, user, password
    max: 10,  // pool size
  },

  // Embedding provider (any OpenAI-compatible API)
  embedder: {
    baseURL: 'http://localhost:11434/v1',
    model: 'bge-m3',
    apiKey: 'ollama',
    dimensions: 1024,           // optional
    timeout: 30000,             // ms, default 30s
  },

  // LLM for summarization & entity extraction
  llm: {
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60000,             // ms, default 60s
  },

  // Tenant isolation
  tenantId: 'default',
});
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
| `entities` | Normalized named entities with type, aliases, frequency, optional embedding |
| `entity_mentions` | Entity × session join with mention count and context |
| `entity_relations` | Co-occurrence edges (undirected, `CHECK src < dst`) |
| `entity_sessions` | Entity-session association for boost scoring |

Key indexes: trigram on entity names, GiST on embeddings, composite on tenant/agent.

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
