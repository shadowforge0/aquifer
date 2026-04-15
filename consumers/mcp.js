#!/usr/bin/env node
'use strict';

/**
 * Aquifer MCP Server — canonical external contract for agent host integration.
 *
 * This is the primary integration surface for Aquifer. Agent hosts (Claude Code,
 * Codex, OpenCode, etc.) should integrate through this MCP server.
 *
 * Tools: session_recall, session_feedback, memory_stats, memory_pending
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
      'These should be installed automatically. Try: npm install\n'
    );
    process.exit(1);
  }

  const server = new McpServer({
    name: 'aquifer-memory',
    version: '0.8.0',
  });

  server.tool(
    'session_recall',
    'Search stored sessions by keyword. Supports entity intersection for precise multi-entity queries.',
    {
      query: z.string().min(1).describe('Search query (keyword or natural language)'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5)'),
      agentId: z.string().optional().describe('Filter by agent ID'),
      source: z.string().optional().describe('Filter by source (e.g., gateway, cc)'),
      dateFrom: z.string().optional().describe('Start date YYYY-MM-DD'),
      dateTo: z.string().optional().describe('End date YYYY-MM-DD'),
      entities: z.array(z.string()).optional().describe('Entity names to match'),
      entityMode: z.enum(['any', 'all']).optional().describe('"any" (default, boost) or "all" (only sessions with every entity)'),
      mode: z.enum(['fts', 'hybrid', 'vector']).optional().describe('Recall mode: "fts" (keyword only, no embed needed), "hybrid" (default, FTS + vector), "vector" (vector only)'),
    },
    async (params) => {
      try {
        const aquifer = getAquifer();
        const limit = params.limit || 5;
        const recallOpts = {
          limit,
          agentId: params.agentId || undefined,
          source: params.source || undefined,
          dateFrom: params.dateFrom || undefined,
          dateTo: params.dateTo || undefined,
        };
        if (params.entities && params.entities.length > 0) {
          recallOpts.entities = params.entities;
          recallOpts.entityMode = params.entityMode || 'any';
        }
        if (params.mode) recallOpts.mode = params.mode;

        const results = await aquifer.recall(params.query, recallOpts);
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

  server.tool(
    'session_feedback',
    'Record trust feedback on a recalled session. Helpful sessions rank higher in future recalls.',
    {
      sessionId: z.string().min(1).describe('Session ID to give feedback on'),
      verdict: z.enum(['helpful', 'unhelpful']).describe('Was the recalled session useful?'),
      note: z.string().optional().describe('Optional reason'),
      agentId: z.string().optional().describe('Agent ID the session was stored under (e.g. "main"). Defaults to "agent" if omitted.'),
    },
    async (params) => {
      try {
        const aquifer = getAquifer();
        const result = await aquifer.feedback(params.sessionId, {
          verdict: params.verdict,
          note: params.note || undefined,
          agentId: params.agentId || undefined,
        });
        return {
          content: [{ type: 'text', text: `Feedback: ${result.verdict} (trust ${result.trustBefore.toFixed(2)} → ${result.trustAfter.toFixed(2)})` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `session_feedback error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'memory_stats',
    'Return storage statistics for the Aquifer memory store (session counts by status, summaries, turn embeddings, entities, date range).',
    {},
    async () => {
      try {
        const aquifer = getAquifer();
        const stats = await aquifer.getStats();
        const lines = [
          `Sessions: ${stats.sessionTotal} total`,
        ];
        for (const [status, count] of Object.entries(stats.sessions)) {
          lines.push(`  ${status}: ${count}`);
        }
        lines.push(`Summaries: ${stats.summaries}`);
        lines.push(`Turn embeddings: ${stats.turnEmbeddings}`);
        lines.push(`Entities: ${stats.entities}`);
        if (stats.earliest) lines.push(`Date range: ${new Date(stats.earliest).toISOString().slice(0, 10)} → ${new Date(stats.latest).toISOString().slice(0, 10)}`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `memory_stats error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'memory_pending',
    'List sessions with pending or failed processing status.',
    {
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default 20)'),
    },
    async (params) => {
      try {
        const aquifer = getAquifer();
        const rows = await aquifer.getPendingSessions({ limit: params.limit ?? 20 });
        if (rows.length === 0) {
          return { content: [{ type: 'text', text: 'No pending or failed sessions.' }] };
        }
        const lines = [`${rows.length} pending/failed session(s):\n`];
        for (const row of rows) {
          lines.push(`${row.session_id}  [${row.processing_status}]  agent=${row.agent_id}`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `memory_pending error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Graceful shutdown
  const cleanup = async () => {
    if (_aquifer) await _aquifer.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Clean up pool when transport closes (stdin EOF)
  transport.onclose = async () => {
    if (_aquifer) await _aquifer.close().catch(() => {});
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
