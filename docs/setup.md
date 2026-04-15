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

### Minimum env vars for MCP recall

```bash
export DATABASE_URL="postgresql://aquifer:aquifer@localhost:5432/aquifer"
export AQUIFER_EMBED_BASE_URL="http://localhost:11434/v1"
export AQUIFER_EMBED_MODEL="bge-m3"
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

Tools appear as `mcp__aquifer__session_recall`, `mcp__aquifer__session_feedback`, `mcp__aquifer__memory_stats`, `mcp__aquifer__memory_pending`.

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

Tools materialize as `aquifer__session_recall`, `aquifer__session_feedback`, `aquifer__memory_stats`, `aquifer__memory_pending`.

Do **not** use the OpenClaw plugin (`consumers/openclaw-plugin.js`) for tool delivery. The plugin is retained for session capture via `before_reset` only.

## Troubleshooting

**`error: type "vector" does not exist`** — pgvector is not installed. Use the `pgvector/pgvector` Docker image, or install the extension manually: `CREATE EXTENSION IF NOT EXISTS vector;` (requires superuser).

**`aquifer mcp requires @modelcontextprotocol/sdk and zod`** — These are regular dependencies and should be installed automatically. Run `npm install` again to ensure all deps are present.

**Recall returns empty results** — Sessions must be enriched before they are searchable. Run `npx aquifer stats` and check that summaries and/or turn embeddings exist. If not, run `npx aquifer backfill` to enrich pending sessions.

**`ECONNREFUSED` on embed calls** — Your embedding endpoint is not reachable. For Ollama: make sure it is running (`ollama serve`) and the model is pulled (`ollama pull bge-m3`).

**Enrich fails with "no LLM configured"** — The built-in summarizer needs `AQUIFER_LLM_BASE_URL` + `AQUIFER_LLM_MODEL`. Alternatively, pass `skipSummary: true` to enrich without summarization (turn embeddings still work), or provide your own `summaryFn`.
