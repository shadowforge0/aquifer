<div align="center">

# 🌊 Aquifer

**Long-term memory for AI agents, backed by PostgreSQL.**

*Store sessions, enrich them, and recall the exact turn where a decision happened — without adding a separate vector database.*

[![npm version](https://img.shields.io/npm/v/@shadowforge0/aquifer-memory)](https://www.npmjs.com/package/@shadowforge0/aquifer-memory)
[![PostgreSQL 15+](https://img.shields.io/badge/PostgreSQL-15%2B-336791)](https://www.postgresql.org/)
[![pgvector](https://img.shields.io/badge/pgvector-0.7%2B-blue)](https://github.com/pgvector/pgvector)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](README.md) | [繁體中文](README_TW.md) | [简体中文](README_CN.md)

</div>

---

## Start Here

Aquifer is designed to have a short default path: start PostgreSQL + embeddings, run `quickstart`, then point your MCP client at `aquifer mcp`.

For library API usage, skip to [API Reference](#api-reference). For a slightly more guided first run, see [docs/getting-started.md](docs/getting-started.md).

### 1. Start the local stack

```bash
docker compose up -d
# PostgreSQL 16 + pgvector and Ollama with bge-m3 (auto-pulled).
# First run pulls the model — `docker compose logs -f ollama-pull` to watch.
```

Already running PostgreSQL + pgvector and an embedding endpoint? Skip this step. `quickstart` picks up `DATABASE_URL` and embed settings from your environment if you already have them.

### 2. Verify end-to-end

```bash
npx --yes @shadowforge0/aquifer-memory quickstart
```

`quickstart` autodetects `localhost:5432` PostgreSQL and `localhost:11434` Ollama (from step 1 or your own), runs migrations, embeds a test session, recalls it, and cleans up. If it prints `✓ Aquifer is working`, you're done.

For ongoing use, install it into your project so you skip the `npx` resolution cost: `npm install @shadowforge0/aquifer-memory` then `npx aquifer quickstart`.

Using OpenAI instead of Ollama? `export EMBED_PROVIDER=openai` + `OPENAI_API_KEY=sk-...` before `quickstart` — model defaults to `text-embedding-3-small`.

### 3. Connect your MCP client

Claude Code, Claude Desktop, or any MCP-capable client — drop this into `.mcp.json` (project-level) or `claude_desktop_config.json`:

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

Or run it directly: `DATABASE_URL=... EMBED_PROVIDER=ollama npx aquifer mcp`. The MCP server itself stays strict about env; `quickstart` autodetect is the try-it path, not the production one.

### Common commands

| Goal | Command |
|---|---|
| Verify setup | `npx aquifer quickstart` |
| Start the MCP server | `npx aquifer mcp` |
| Search memory manually | `npx aquifer recall "auth middleware"` |
| Inspect storage health | `npx aquifer stats` |
| Enrich pending sessions | `npx aquifer backfill` |

Need LLM summarization, the knowledge graph, OpenAI embeddings, reranking, or operations details? See [docs/setup.md](docs/setup.md) and [Environment Variables](#environment-variables).

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
| **Dependencies** | `pg` + MCP SDK | Multiple SDKs |

### Before and after

**Without turn-level memory — search misses precise moments:**

> Query: "What did we decide about the auth middleware?"
> → Returns a 2000-word session summary that mentions auth somewhere

**With Aquifer — search finds the exact turn:**

> Query: "What did we decide about the auth middleware?"
> → Returns the specific user turn: "Let's rip out the old auth middleware — legal flagged it for session token compliance"

---

## Requirements

| Component | Required? | Purpose | Example |
|-----------|-----------|---------|---------|
| Node.js >= 18 | Yes | Runtime | — |
| PostgreSQL 15+ | Yes | Storage for sessions, summaries, entities | Local, Docker, or managed |
| pgvector extension | Yes | Vector similarity search | `CREATE EXTENSION vector;` (included in `pgvector/pgvector` Docker image) |
| Embedding endpoint | Yes (for recall) | Turn + session embedding | Ollama `bge-m3`, OpenAI `text-embedding-3-small`, any OpenAI-compatible API |
| LLM endpoint | Optional | Built-in summarization during `enrich` | Ollama, OpenRouter, OpenAI — or provide your own `summaryFn` |
| `@modelcontextprotocol/sdk` + `zod` | Yes (for MCP server) | MCP protocol runtime | Included in dependencies — installed automatically |

---

## Environment Variables

| Variable | Required? | Purpose | Example |
|----------|-----------|---------|---------|
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/mydb` |
| `AQUIFER_SCHEMA` | No | PG schema name (default: `aquifer`) | `memory` |
| `AQUIFER_TENANT_ID` | No | Multi-tenant key (default: `default`) | `my-app` |
| `AQUIFER_EMBED_BASE_URL` | Yes (for recall) | Embedding API base URL | `http://localhost:11434/v1` |
| `AQUIFER_EMBED_MODEL` | Yes (for recall) | Embedding model name | `bge-m3` |
| `AQUIFER_EMBED_API_KEY` | Provider-dependent | API key for hosted embedding providers | `sk-...` |
| `AQUIFER_EMBED_DIM` | No | Embedding dimension override (auto-detected) | `1024` |
| `AQUIFER_LLM_BASE_URL` | No | LLM API base URL (for built-in summarization) | `http://localhost:11434/v1` |
| `AQUIFER_LLM_MODEL` | No | LLM model name | `llama3.1` |
| `AQUIFER_LLM_API_KEY` | Provider-dependent | API key for hosted LLM providers | `sk-...` |
| `AQUIFER_ENTITIES_ENABLED` | No | Enable knowledge graph (default: `false`) | `true` |
| `AQUIFER_ENTITY_SCOPE` | No | Entity namespace (default: `default`) | `my-app` |
| `AQUIFER_RERANK_ENABLED` | No | Enable cross-encoder reranking | `true` |
| `AQUIFER_RERANK_PROVIDER` | No | Reranker provider: `tei`, `jina`, `openrouter` | `tei` |
| `AQUIFER_RERANK_BASE_URL` | No | Reranker endpoint | `http://localhost:8080` |
| `AQUIFER_AGENT_ID` | No | Default agent ID | `main` |
| `AQUIFER_MIGRATIONS_MODE` | No | Startup handshake mode: `apply` (default), `check`, `off` | `apply` |
| `AQUIFER_MIGRATION_LOCK_TIMEOUT_MS` | No | Advisory-lock wait before `AQ_MIGRATION_LOCK_TIMEOUT` (default 30000) | `30000` |
| `AQUIFER_INSIGHTS_DEDUP_MODE` | No | Insights semantic dedup mode: `off` (default), `shadow`, `enforce` — env wins over code for this field only, so operators can kill-switch without redeploy | `shadow` |
| `AQUIFER_INSIGHTS_DEDUP_COSINE` | No | Cosine threshold for semantic merge (default `0.88`; warn outside `[0.75, 0.95]`) | `0.90` |
| `AQUIFER_INSIGHTS_DEDUP_CLOSE_BAND_FROM` | No | Lower bound for close-band logging (`dedupNear`); must be below threshold (default `0.85`) | `0.82` |

Full env-to-config mapping is in [consumers/shared/config.js](consumers/shared/config.js).

### Insights semantic dedup (1.5.10)

When a cron extractor (`scripts/extract-insights-from-recent-sessions.js`) or any other caller writes insights via `commitInsight`, the canonical-key layer (1.5.3+) dedupes rows whose `canonicalClaim + entities` hash to the same value. But LLMs don't always produce the same `canonicalClaim` across runs, so 1.5.10 adds a second tier: `title + body` are embedded, matched against `(tenant, agent, type)`-scoped active rows, and a top cosine above `AQUIFER_INSIGHTS_DEDUP_COSINE` triggers supersede (enforce) or metadata-only would-merge logging (shadow). Close-band hits (`closeBandFrom ≤ cos < threshold`) write `metadata.dedupNear` without supersede so operators can tune thresholds without committing.

Recommended rollout: `shadow` for one weekly cycle, inspect `SELECT metadata->>'shadowMatch' FROM insights WHERE metadata ? 'shadowMatch'`, then flip to `enforce`. Kill-switch: `AQUIFER_INSIGHTS_DEDUP_MODE=off` and restart.

Pre-1.5.3 rows with `canonical_key_v2 IS NULL` are caught by the semantic tier but skip the canonical path; a startup warn points at the one-shot backfill:

```bash
DATABASE_URL=... \
  node scripts/backfill-canonical-key.js --schema <schema> --agent <id>
```

The script is idempotent (`WHERE canonical_key_v2 IS NULL` guard) and race-safe with live writers.

---

## Host Integration

MCP is the primary integration surface. Agent hosts connect to the Aquifer MCP server, which exposes six tools: `session_recall`, `session_feedback`, `feedback_stats`, `session_bootstrap`, `memory_stats`, `memory_pending`.

| Integration | Route | Status | When to use |
|-------------|-------|--------|-------------|
| MCP server | `consumers/mcp.js` | Primary | Claude Code, OpenClaw, Codex, any MCP-capable host |
| Library API | `createAquifer()` | Primary | Backend apps, custom pipelines, direct Node.js usage |
| CLI | `consumers/cli.js` | Secondary | Operations, debugging, manual recall/backfill (`aquifer bootstrap`, `aquifer ingest-opencode`, etc.) |
| OpenCode ingest | `consumers/opencode.js` | Secondary | Import sessions from OpenCode's SQLite DB |
| OpenClaw plugin | `consumers/openclaw-plugin.js` | Compatibility only | Session capture via `before_reset` — not for tool delivery |

### Claude Code

Add to your project's `.claude.json` or user-level MCP config:

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

Tools appear as `mcp__aquifer__session_recall`, `mcp__aquifer__session_feedback`, `mcp__aquifer__session_bootstrap`, etc.

### OpenClaw

Add to `openclaw.json` under `mcp.servers`:

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

Tools materialize as `aquifer__session_recall`, `aquifer__session_feedback`, `aquifer__feedback_stats`, `aquifer__session_bootstrap`, `aquifer__memory_stats`, `aquifer__memory_pending` (server name prefix added by the host).

The OpenClaw plugin (`consumers/openclaw-plugin.js`) is retained for session capture via `before_reset` but is **not** the recommended tool delivery path. Use MCP.

### Other MCP-capable hosts

Any host that supports MCP stdio can connect the same way — point it at `node consumers/mcp.js` with the required env vars. The MCP server is the canonical external contract.

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

### File Reference

| File | Purpose |
|------|---------|
| `index.js` | Entry point — exports `createAquifer`, `createEmbedder`, `createReranker` |
| `core/aquifer.js` | Main facade: `migrate()`, `ingest()`, `recall()`, `enrich()` |
| `core/storage.js` | Session/summary/turn CRUD, FTS search, embedding search |
| `core/entity.js` | Entity upsert, mention tracking, relation graph, normalization |
| `core/hybrid-rank.js` | 3-way RRF fusion, time decay, trust multiplier, entity boost, open-loop boost |
| `pipeline/summarize.js` | LLM-powered session summarization with structured output |
| `pipeline/embed.js` | Embedding client (any OpenAI-compatible API) |
| `pipeline/extract-entities.js` | LLM-powered entity extraction (12 types) |
| `pipeline/rerank.js` | Cross-encoder reranking (TEI, Jina, OpenRouter) |
| `pipeline/normalize/` | Session normalization for Claude Code / gateway noise |
| `consumers/opencode.js` | OpenCode SQLite ingest — reads sessions from OpenCode's local DB |
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

#### `aquifer.init()`

Startup handshake — resolves pending migrations and returns a StartupEnvelope. Hosts should `await` this before accepting traffic. In `apply` mode a `ready=false` envelope is the signal to abort startup.

```javascript
const envelope = await aquifer.init();
// {
//   ready:             true,
//   memoryMode:        'rw',        // 'rw' | 'ro' | 'off'
//   migrationMode:     'apply',     // 'apply' | 'check' | 'off'
//   pendingMigrations: [],          // migration ids still outstanding
//   appliedMigrations: ['001-base', '003-trust-feedback', '004-completion', '006-insights'],
//   error:             null,        // { code, message } on failure
//   durationMs:        1035,
// }
```

The MCP consumer (`consumers/mcp.js`) already wires `aquifer.init()` before `server.connect()` and exits non-zero if `ready=false` under `apply` mode.

#### `aquifer.listPendingMigrations()` / `aquifer.getMigrationStatus()`

Returns `{ required, applied, pending, lastRunAt }` via a `pg_tables` signature probe. No DDL runs. Use it from a health check or from a consumer that wants to surface drift before calling `init()`.

#### `aquifer.migrate()`

Runs SQL migrations (idempotent). Creates tables, indexes, triggers, and extensions. Uses `pg_try_advisory_lock` with a 250 ms poll and a `lockTimeoutMs` deadline (30 s default); on exhaustion throws with `code: 'AQ_MIGRATION_LOCK_TIMEOUT'`. On success returns `{ ok: true, durationMs, notices, ddlExecuted }`; on failure throws an error whose `err.notices` / `err.failedAt` describe the stage that blew up. Most callers should go through `aquifer.init()` instead.

#### `aquifer.ensureMigrated()`

Lazy idempotent wrapper — fires `migrate()` once on first call, no-ops afterwards. Honors `migrations.mode`: `check` only probes, `off` marks the instance migrated without touching the DB.

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

**postProcess hook**: runs after transaction commit, receives full context (session, summary, embedding, parsedEntities, etc.). Best-effort, at-most-once. If the hook throws, the error is captured and returned as `postProcessError` on the enrich result — the session itself remains committed and is not retried.

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

#### `aquifer.bootstrap(opts)`

Loads recent session context for a new conversation — summaries, open loops, and decisions. Time-based (no embedding search), designed for session-start injection.

```javascript
const result = await aquifer.bootstrap({
  agentId: 'main',
  limit: 5,              // max sessions (default: 5)
  lookbackDays: 14,      // how far back (default: 14)
  maxChars: 4000,        // max output chars (default: 4000)
  format: 'text',        // 'text', 'structured', or 'both'
});
// format='text': result.text contains XML block ready for injection
// format='structured': result.sessions, result.openLoops, result.recentDecisions
```

Cross-session dedup on open loops and decisions, sentinel filtering (removes 無/none/n/a), and maxChars truncation.

#### `aquifer.insights.commitInsight(opts)` / `recallInsights(query, opts)` / `markStale(id)` / `supersede(oldId, newId)`

Higher-order reflections distilled from session windows (preferences, patterns, frustrations, workflows). Split into two identities: a **canonical key** that describes what the insight is *about* (stable across rewordings), and an **idempotency key** that describes which revision of that claim was written.

```javascript
await aquifer.insights.commitInsight({
  agentId:        'main',
  type:           'preference',
  canonicalClaim: 'mk prefers checking context before coding',  // required — short declarative claim
  title:          'Context-first discipline',                    // best-effort display
  body:           '…',
  entities:       ['mk', 'claude code'],
  sourceSessionIds: ['sess-a', 'sess-b'],
  evidenceWindow:  { from: isoString, to: isoString },
  importance:     0.9,
});
```

Write rules: **duplicate** (same idempotency key → return existing), **revision** (same canonical key + newer evidence → INSERT + inline supersede of prior active), **back-fill revision** (same canonical key + older evidence → INSERT without supersede), **stale replay** (same canonical + same body → return existing). Old pre-1.5.6 rows are not retrofitted; their `canonical_key_v2` stays `NULL` and they age out naturally.

#### `aquifer.close()`

Closes the PostgreSQL connection pool (only if Aquifer created it).

---

## Configuration

Aquifer resolves config from three sources in priority order: config file → environment variables → programmatic overrides. See [consumers/shared/config.js](consumers/shared/config.js) for the full env-to-config mapping.

Config file is auto-discovered at `aquifer.config.json` in the working directory, or set `AQUIFER_CONFIG=/path/to/config.json`.

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
  migrations: {
    mode: 'apply',             // 'apply' | 'check' | 'off'
    lockTimeoutMs: 30000,      // abort init() if advisory lock held this long
    startupTimeoutMs: 60000,   // overall init() deadline (plan probe + DDL combined)
    onEvent: null,             // (e) => void — lifecycle hook, see below
  },
});
```

### Startup observability

Set `migrations.onEvent` to observe the lifecycle without parsing logs. Event names: `init_started`, `check_completed`, `apply_started`, `apply_succeeded`, `apply_failed`. Each payload carries `schema`, `mode`, the plan, `ddlExecuted`, `durationMs`, and on failure the `error` / `failedAt` / `notices`. No listener → zero cost.

### Entity Scope

`entities.scope` defines the namespace for entity identity. The unique constraint is `(tenant_id, normalized_name, entity_scope)` — the same entity name in different scopes creates separate entities. This decouples entity identity from `agentId`, allowing multiple agents to share an entity namespace.

Fallback chain: `config.entities.scope` → `'default'`.

---

## Database Schema

### 001-base.sql

| Table | Purpose |
|-------|---------|
| `sessions` | Raw conversation data with messages (JSONB), token counts, timestamps |
| `session_summaries` | LLM-generated structured summaries with embeddings |
| `turn_embeddings` | Per-turn user message embeddings for precise retrieval |

Key indexes: GIN on messages, GiST on `tsvector`, ivfflat on embeddings, B-tree on tenant/agent/timestamps.

Note: the schema uses basic ivfflat indexes suitable for development and moderate-scale use. For large deployments (100k+ embeddings), consider adding HNSW indexes — this is a future optimization area, not included out of the box.

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

### 005-entity-state-history.sql *(entities enabled)*

| Table | Purpose |
|-------|---------|
| `entity_state_history` | Temporal state-change log with partial `UNIQUE (tenant, agent, entity, attribute) WHERE valid_to IS NULL` to enforce at-most-one-current. Out-of-order backfill is supported via predecessor/successor overlap checks |

Opt-in pipeline (`createAquifer({stateChanges: {enabled, whitelist, confidenceThreshold, timeoutMs, ...}})`) extracts temporal state transitions from session text during `enrich()`; off by default to control LLM cost.

### 006-insights.sql

| Table | Purpose |
|-------|---------|
| `insights` | Higher-order reflections with TSTZRANGE evidence window, importance, GIN on source_session_ids, HNSW on 1024-dim embedding, and a non-unique partial index on `canonical_key_v2` for the canonical/revision dedup contract |

Key indexes: `idx_insights_canonical_v2_active` (partial on active rows with canonical key set), `idx_insights_idempotency_key` (unique on revision key).

---

## Troubleshooting

**`error: type "vector" does not exist`** — pgvector extension is not installed. Run `CREATE EXTENSION IF NOT EXISTS vector;` as a superuser, or use the `pgvector/pgvector` Docker image which includes it.

**`aquifer mcp requires @modelcontextprotocol/sdk and zod`** — These are now regular dependencies and should be installed automatically. If you see this error, run `npm install` again to ensure all deps are present.

**Recall returns no results** — Make sure you've run `enrich` after `commit`. Raw sessions are not searchable until enriched (summarized + embedded). Check `aquifer stats` to see if summaries and turn embeddings exist.

**OpenClaw tools not visible** — Use `mcp.servers.aquifer` in `openclaw.json`, not the plugin. Tools appear as `aquifer__session_recall` etc. The plugin (`consumers/openclaw-plugin.js`) is for session capture only.

**Embedding provider connection refused** — Verify your `AQUIFER_EMBED_BASE_URL` is reachable. For local Ollama, make sure the server is running and the model is pulled (`ollama pull bge-m3`).

**`AQ_MIGRATION_LOCK_TIMEOUT` on startup** — another process holds the migration advisory lock for `aquifer:<schema>`. Either it is a concurrent `aquifer.init()` racing yours (expected; one will win, the other re-runs and finds `pending=[]`) or a crashed worker left the lock held. Raise `migrations.lockTimeoutMs`, or drop the stale backend via `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory'` after you have confirmed which pid is dead.

**MCP process exits non-zero at startup** — expected when `migrations.mode=apply` and `aquifer.init()` returns `ready=false`. Read the `[aquifer-mcp] startup aborted` line on stderr for the `error.code` / `failedAt`. If you need the old lazy-migrate-on-first-tool-call behaviour instead, set `AQUIFER_MIGRATIONS_MODE=check` (and run `migrate()` out of band) or `=off`.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `pg` ≥ 8.13 | PostgreSQL client |
| `@modelcontextprotocol/sdk` ≥ 1.29 | MCP server protocol |
| `zod` ≥ 3.25 | Schema validation (MCP tools) |

LLM and embedding calls use raw HTTP — no additional SDK required.

---

## License

MIT
