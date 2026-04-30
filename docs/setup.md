# Aquifer Setup Guide

This guide walks you through installing Aquifer and verifying a complete write → enrich → recall cycle. By the end, you will have a working MCP memory server that an agent host can connect to.

## Prerequisites

You need three things running before Aquifer can work:

1. **PostgreSQL 15+** with the **pgvector** extension installed
2. **Node.js 18+**
3. **An embedding endpoint** — Ollama (local), OpenAI, or any OpenAI-compatible API

## Step 1: Database

### Option A: Docker (recommended for local dev)

The repo includes a `docker-compose.yml` that starts PostgreSQL 16 with pgvector and Ollama with bge-m3 auto-pulled:

```bash
cd /path/to/aquifer
docker compose up -d
```

This gives you a database at `postgresql://aquifer:aquifer@localhost:5432/aquifer` with pgvector ready, plus an Ollama server with bge-m3 for embeddings. First run takes a few minutes while the model downloads.

### Option B: Existing PostgreSQL

Make sure pgvector is installed. Connect as a superuser and run:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

If your PostgreSQL was installed from a package manager, you may need to install the pgvector package separately. See [pgvector installation](https://github.com/pgvector/pgvector#installation).

## Step 2: Install Aquifer

```bash
npm install @shadowforge0/aquifer-memory
```

All dependencies including MCP SDK and zod are installed automatically.

## Step 3: Configure

Aquifer reads configuration from three sources (in priority order):

1. Config file: `aquifer.config.json` in the working directory, or set `AQUIFER_CONFIG=/path/to/config.json`
2. Environment variables (see below)
3. Programmatic overrides via `createAquifer()`

Default public serving mode is `legacy`. Opt into `curated` only when you want `session_recall` and `session_bootstrap` to read active curated memory. `evidence_recall` remains the explicit audit/debug lane in both modes, and rollback is just setting env or config back to `legacy`.

Backend profiles are explicit. `postgres` is the full backend and remains required for semantic recall, migrations, curated memory, and operator workflows. `local` is a zero-config starter profile with JSON-file persistence, raw session writes, lexical recall, bootstrap, stats, and export. It is intentionally degraded and does not create embeddings or run operator workflows:

```bash
AQUIFER_BACKEND=local npx aquifer backend-info --json
```

### Example config file

```json
{
  "storage": {
    "backend": "postgres",
    "postgres": {
      "url": "postgresql://aquifer:aquifer@localhost:5432/aquifer"
    },
    "local": {
      "path": ".aquifer/aquifer.local.json"
    }
  },
  "db": {
    "url": "postgresql://aquifer:aquifer@localhost:5432/aquifer"
  },
  "memory": {
    "servingMode": "legacy",
    "activeScopeKey": "project:aquifer",
    "activeScopePath": ["global", "project:aquifer"]
  },
  "embed": {
    "baseUrl": "http://localhost:11434/v1",
    "model": "bge-m3"
  }
}
```

### Minimum env vars for MCP recall

```bash
export DATABASE_URL="postgresql://aquifer:aquifer@localhost:5432/aquifer"
export AQUIFER_BACKEND="postgres"
export AQUIFER_EMBED_BASE_URL="http://localhost:11434/v1"
export AQUIFER_EMBED_MODEL="bge-m3"
export AQUIFER_MEMORY_SERVING_MODE="legacy"
```

### Optional but common

```bash
# PG schema (default: aquifer) — useful for running multiple instances in one database
export AQUIFER_SCHEMA="aquifer"

# LLM for built-in summarization — without this, enrich requires a custom summaryFn
export AQUIFER_LLM_BASE_URL="http://localhost:11434/v1"
export AQUIFER_LLM_MODEL="llama3.1"

# Knowledge graph
export AQUIFER_ENTITIES_ENABLED="true"

# Optional curated serving rollout. Default remains legacy.
export AQUIFER_MEMORY_SERVING_MODE="legacy"
# export AQUIFER_MEMORY_SERVING_MODE="curated"
# export AQUIFER_MEMORY_ACTIVE_SCOPE_KEY="project:aquifer"
# export AQUIFER_MEMORY_ACTIVE_SCOPE_PATH="global,project:aquifer"

# Optional Codex active-session checkpoint heartbeat policy.
# Command flags still take precedence over these env vars.
# export AQUIFER_CODEX_CHECKPOINT_CHECK_INTERVAL_MINUTES="10"
# export AQUIFER_CODEX_CHECKPOINT_EVERY_MESSAGES="20"
# export AQUIFER_CODEX_CHECKPOINT_QUIET_MS="3000"
```

Copy `.env.example` from the repo root for a full annotated list.

## Step 4: Verify everything works

```bash
npx aquifer quickstart
```

This single command runs migrations, commits a test session, embeds it, recalls it, and cleans up. If it prints `✓ Aquifer is working`, your setup is correct.

You can also run individual steps manually: `npx aquifer migrate`, `npx aquifer stats`, etc.

## Step 5: Start the MCP server

```bash
npx aquifer mcp
```

The server starts on stdio and waits for MCP client connections. There is no visible output on success — the server is ready when the process stays running without error.

### Verify with the library API (optional)

If you want to test the library directly instead of the CLI:

```javascript
const { createAquifer, createEmbedder } = require('@shadowforge0/aquifer-memory');

const embedder = createEmbedder({
  provider: 'ollama',
  ollamaUrl: 'http://localhost:11434',
  model: 'bge-m3',
});

const aquifer = createAquifer({
  db: process.env.DATABASE_URL,
  schema: 'aquifer',
  embed: { fn: (texts) => embedder.embedBatch(texts) },
});

await aquifer.migrate();

// Commit a test session
await aquifer.commit('test-001', [
  { role: 'user', content: 'We decided to use PostgreSQL for the memory store.' },
  { role: 'assistant', content: 'Good choice — PG gives us ACID, FTS, and pgvector in one place.' },
], { agentId: 'test' });

// Enrich (embed turns — summarization needs LLM config)
await aquifer.enrich('test-001', { agentId: 'test', skipSummary: true });

// Recall
const results = await aquifer.recall('PostgreSQL memory', { limit: 3 });
console.log('Results:', results.length); // Should be >= 1

await aquifer.close();
```

## Connecting a host

Once the MCP server is verified, connect your agent host:

### Claude Code

Add to `.claude.json` (project-level) or user-level MCP config:

```json
{
  "mcpServers": {
    "aquifer": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/aquifer/consumers/mcp.js"],
      "env": {
        "DATABASE_URL": "postgresql://aquifer:aquifer@localhost:5432/aquifer",
        "AQUIFER_EMBED_BASE_URL": "http://localhost:11434/v1",
        "AQUIFER_EMBED_MODEL": "bge-m3"
      }
    }
  }
}
```

Tools appear as `mcp__aquifer__session_recall`, `mcp__aquifer__evidence_recall`, `mcp__aquifer__session_bootstrap`, `mcp__aquifer__session_feedback`, `mcp__aquifer__memory_feedback`, `mcp__aquifer__feedback_stats`, `mcp__aquifer__memory_stats`, `mcp__aquifer__memory_pending`.

`evidence_recall` is an explicit audit/debug tool. Use `session_recall` for normal memory lookup; broad evidence searches require an audit boundary filter such as `agentId`, `source`, or `dateFrom/dateTo`, unless the caller explicitly opts into unsafe debug mode.

### OpenClaw

Add to `openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "aquifer": {
        "command": "node",
        "args": ["/absolute/path/to/aquifer/consumers/mcp.js"],
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

Tools materialize as `aquifer__session_recall`, `aquifer__evidence_recall`, `aquifer__session_bootstrap`, `aquifer__session_feedback`, `aquifer__memory_feedback`, `aquifer__feedback_stats`, `aquifer__memory_stats`, `aquifer__memory_pending`.

Do **not** use the OpenClaw plugin (`consumers/openclaw-plugin.js`) for tool delivery. The plugin is retained for session capture via `before_reset` only.

Curated serving rollback is config-only: set `AQUIFER_MEMORY_SERVING_MODE=legacy` and restart the MCP/CLI process. No destructive database rollback is required.

## Operator compaction and timer synthesis

Compaction jobs are operator-safe by default. A dry-run plans lifecycle updates
and candidate output without writing active memory:

```bash
npx aquifer operator compaction daily --include-synthesis-prompt --json
```

If an operator or external model reviews that prompt and returns timer synthesis
JSON, attach it back to the plan with:

```bash
npx aquifer operator compaction daily \
  --synthesis-summary-file /tmp/timer-summary.json \
  --apply \
  --promote-candidates \
  --json
```

The summary file must match the normal structured summary shape, for example:

```json
{
  "summaryText": "Reviewed timer synthesis.",
  "structuredSummary": {
    "states": [
      { "state": "The reviewed state that should continue into current memory." }
    ],
    "decisions": [],
    "open_loops": []
  }
}
```

Without `--promote-candidates`, synthesis output is recorded as candidate
ledger material only. The prompt and summary file are producer material; active
curated memory still requires the explicit promotion gate.

## Release verification gates

For the publish-surface checks:

```bash
node --test test/package-surface.test.js test/mcp-manifest.test.js
npm pack --dry-run --json
```

For the real DB-backed release gate:

```bash
AQUIFER_TEST_DB_URL="postgresql://..." npm run test:release:db
```

That DB-backed test is the release proof that the stdio MCP server, CLI
consumer, Codex finalization serving path, current MCP manifest, and PostgreSQL
path still line up on a live database.

## Troubleshooting

**`error: type "vector" does not exist`** — pgvector is not installed. Use the `pgvector/pgvector` Docker image, or install the extension manually: `CREATE EXTENSION IF NOT EXISTS vector;` (requires superuser).

**`aquifer mcp requires @modelcontextprotocol/sdk and zod`** — These are regular dependencies and should be installed automatically. Run `npm install` again to ensure all deps are present.

**Recall returns empty results** — Sessions must be enriched before they are searchable. Run `npx aquifer stats` and check that summaries and/or turn embeddings exist. If not, run `npx aquifer backfill` to enrich pending sessions.

**`ECONNREFUSED` on embed calls** — Your embedding endpoint is not reachable. For Ollama: make sure it is running (`ollama serve`) and the model is pulled (`ollama pull bge-m3`).

**Enrich fails with "no LLM configured"** — The built-in summarizer needs `AQUIFER_LLM_BASE_URL` + `AQUIFER_LLM_MODEL`. Alternatively, pass `skipSummary: true` to enrich without summarization (turn embeddings still work), or provide your own `summaryFn`.
