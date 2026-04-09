#!/usr/bin/env node
'use strict';

/**
 * Aquifer MCP Server — session_recall tool via Model Context Protocol.
 *
 * Usage:
 *   npx aquifer mcp
 *   node consumers/mcp.js
 *
 * Config via environment variables (see consumers/shared/config.js).
 * Requires: DATABASE_URL + AQUIFER_EMBED_BASE_URL + AQUIFER_EMBED_MODEL
 */

const { createAquiferFromConfig } = require('./shared/factory');

let _aquifer = null;

function getAquifer() {
  if (!_aquifer) _aquifer = createAquiferFromConfig();
  return _aquifer;
}

// ---------------------------------------------------------------------------
// Format recall results as readable text
// ---------------------------------------------------------------------------

function formatResults(results, query) {
  if (results.length === 0) return `No results found for "${query}".`;

  const lines = [`Found ${results.length} result(s) for "${query}":\n`];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const ss = r.structuredSummary || {};
    const title = ss.title || r.summaryText?.slice(0, 60) || '(untitled)';
    const date = r.startedAt
      ? new Date(r.startedAt).toISOString().slice(0, 10)
      : 'unknown';

    lines.push(`### ${i + 1}. ${title} (${date}, ${r.agentId || 'default'})`);
    if (ss.overview || r.summaryText) {
      lines.push((ss.overview || r.summaryText).slice(0, 300));
    }
    if (r.matchedTurnText) {
      lines.push(`Matched turn: ${r.matchedTurnText.slice(0, 200)}`);
    }
    lines.push(`Score: ${r.score?.toFixed(3) || '?'}\n`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Start MCP server
// ---------------------------------------------------------------------------

async function main() {
  let McpServer, StdioServerTransport, z;
  try {
    ({ McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js'));
    ({ StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js'));
    ({ z } = require('zod'));
  } catch (e) {
    process.stderr.write(
      'aquifer mcp requires @modelcontextprotocol/sdk and zod.\n' +
      'Install: npm install @modelcontextprotocol/sdk zod\n'
    );
    process.exit(1);
  }

  const server = new McpServer({
    name: 'aquifer-memory',
    version: '0.2.0',
  });

  server.tool(
    'session_recall',
    'Search stored sessions by keyword, returning ranked summaries and matched conversation turns.',
    {
      query: z.string().min(1).describe('Search query (keyword or natural language)'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
      agentId: z.string().optional().describe('Filter by agent ID'),
      source: z.string().optional().describe('Filter by source (e.g., gateway, cc)'),
      dateFrom: z.string().optional().describe('Start date YYYY-MM-DD'),
      dateTo: z.string().optional().describe('End date YYYY-MM-DD'),
    },
    async (params) => {
      try {
        const aquifer = getAquifer();
        const limit = params.limit || 5;

        const results = await aquifer.recall(params.query, {
          limit,
          agentId: params.agentId || undefined,
          source: params.source || undefined,
          dateFrom: params.dateFrom || undefined,
          dateTo: params.dateTo || undefined,
        });

        const text = formatResults(results, params.query);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `session_recall error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Graceful shutdown
  const cleanup = async () => {
    if (_aquifer?._pool) await _aquifer._pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Clean up pool when transport closes (stdin EOF)
  transport.onclose = async () => {
    if (_aquifer?._pool) await _aquifer._pool.end().catch(() => {});
  };
}

// Only execute when run directly, not when required as a module
if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`aquifer-mcp error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { main };
