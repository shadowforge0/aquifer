# Aquifer Getting Started

This guide is the shortest path from zero to a working Aquifer memory backend.

By the end, you will have verified a full write -> enrich -> recall cycle and connected Aquifer to an MCP client.

## What you need

- Node.js 18+
- PostgreSQL 15+ with `pgvector`
- An embedding endpoint such as Ollama or OpenAI

If you just want the default local path, the repo already includes a Docker stack for PostgreSQL + pgvector and Ollama.

## Fast path: local Docker stack

From the repo root:

```bash
docker compose up -d
npx --yes @shadowforge0/aquifer-memory quickstart
```

`quickstart` runs migrations, writes a test session, embeds it, recalls it, and removes the test data.

If you see `✓ Aquifer is working`, the backend is ready.

## If you already have PostgreSQL and embeddings

Set the minimum environment variables and run the same verification command:

```bash
export DATABASE_URL="postgresql://aquifer:aquifer@localhost:5432/aquifer"
export AQUIFER_EMBED_BASE_URL="http://localhost:11434/v1"
export AQUIFER_EMBED_MODEL="bge-m3"

npx --yes @shadowforge0/aquifer-memory quickstart
```

If you prefer OpenAI embeddings:

```bash
export DATABASE_URL="postgresql://aquifer:aquifer@localhost:5432/aquifer"
export EMBED_PROVIDER="openai"
export OPENAI_API_KEY="sk-..."

npx --yes @shadowforge0/aquifer-memory quickstart
```

## Connect an MCP client

Once `quickstart` passes, point your MCP client at Aquifer:

```json
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

Or run the server directly:

```bash
DATABASE_URL=... EMBED_PROVIDER=ollama npx aquifer mcp
```

## Most common commands

| Goal | Command |
|---|---|
| Verify setup | `npx aquifer quickstart` |
| Start MCP server | `npx aquifer mcp` |
| Search memory | `npx aquifer recall "auth middleware"` |
| Show stats | `npx aquifer stats` |
| Enrich pending sessions | `npx aquifer backfill` |

## If something fails

If `quickstart` cannot connect to PostgreSQL, make sure the database is running and `DATABASE_URL` is correct.

If you see `type "vector" does not exist`, `pgvector` is not installed.

If recall returns no results, the embedding endpoint is usually unreachable or misconfigured.

If you want the full setup matrix, host-specific examples, and advanced configuration for summarization, entities, reranking, or operations, continue to [docs/setup.md](setup.md).
