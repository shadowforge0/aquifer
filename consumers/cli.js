#!/usr/bin/env node
'use strict';

/**
 * Aquifer CLI
 *
 * Usage:
 *   aquifer migrate                     Run database migrations
 *   aquifer recall <query> [options]    Search sessions
 *   aquifer backfill [options]          Enrich pending sessions
 *   aquifer stats [options]             Show database statistics
 *   aquifer export [options]            Export sessions
 *   aquifer mcp                         Start MCP server
 */

const { createAquiferFromConfig } = require('./shared/factory');
const { loadConfig } = require('./shared/config');

// ---------------------------------------------------------------------------
// Argument parser (minimal, no deps)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  // Flags that take a value (not boolean)
  const VALUE_FLAGS = new Set(['limit', 'agent-id', 'source', 'date-from', 'date-to', 'output', 'format', 'config', 'status', 'concurrency']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') { args._.push(...argv.slice(i + 1)); break; }
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args.flags[key] = argv[++i];
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdMigrate(aquifer) {
  await aquifer.migrate();
  console.log('Migrations applied successfully.');
}

async function cmdRecall(aquifer, args) {
  const query = args._.slice(1).join(' ');
  if (!query) {
    console.error('Usage: aquifer recall <query> [--limit N] [--agent-id ID] [--json]');
    process.exit(1);
  }

  const results = await aquifer.recall(query, {
    limit: parseInt(args.flags.limit || '5', 10),
    agentId: args.flags['agent-id'] || undefined,
    source: args.flags.source || undefined,
    dateFrom: args.flags['date-from'] || undefined,
    dateTo: args.flags['date-to'] || undefined,
  });

  if (args.flags.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const ss = r.structuredSummary || {};
    const title = ss.title || r.summaryText?.slice(0, 60) || '(untitled)';
    const date = r.startedAt ? new Date(r.startedAt).toISOString().slice(0, 10) : '?';
    console.log(`${i + 1}. [${r.score?.toFixed(3)}] ${title} (${date}, ${r.agentId})`);
    if (ss.overview) console.log(`   ${ss.overview.slice(0, 200)}`);
    if (r.matchedTurnText) console.log(`   > ${r.matchedTurnText.slice(0, 150)}`);
    console.log();
  }
}

async function cmdBackfill(aquifer, args) {
  const limit = parseInt(args.flags.limit || '100', 10);
  const dryRun = !!args.flags['dry-run'];
  const skipSummary = !!args.flags['skip-summary'];
  const skipTurnEmbed = !!args.flags['skip-turn-embed'];
  const skipEntities = !!args.flags['skip-entities'];

  const config = aquifer._config || {};
  const schema = config.schema || 'aquifer';
  const tenantId = config.tenantId || 'default';
  const pool = aquifer._pool;

  if (!pool) {
    console.error('Backfill requires direct pool access.');
    process.exit(1);
  }

  const qi = (id) => `"${id}"`;
  const { rows } = await pool.query(`
    SELECT session_id, agent_id, processing_status
    FROM ${qi(schema)}.sessions
    WHERE tenant_id = $1
      AND processing_status IN ('pending', 'failed')
    ORDER BY started_at DESC
    LIMIT $2
  `, [tenantId, limit]);

  console.log(`Found ${rows.length} sessions to backfill${dryRun ? ' (dry-run)' : ''}`);

  let enriched = 0, failed = 0;
  for (const row of rows) {
    if (dryRun) {
      console.log(`  [dry-run] ${row.session_id} (${row.agent_id}) status=${row.processing_status}`);
      continue;
    }

    try {
      const result = await aquifer.enrich(row.session_id, {
        agentId: row.agent_id,
        skipSummary,
        skipTurnEmbed,
        skipEntities,
      });
      enriched++;
      console.log(`  [${enriched}] ${row.session_id}: ${result.turnsEmbedded} turns, ${result.entitiesFound} entities`);
    } catch (err) {
      failed++;
      console.error(`  [error] ${row.session_id}: ${err.message}`);
    }
  }

  console.log(`\nDone. enriched=${enriched} failed=${failed} total=${rows.length}`);
  if (failed > 0) process.exitCode = 2;
}

async function cmdStats(aquifer, args) {
  const config = aquifer._config || {};
  const schema = config.schema || 'aquifer';
  const tenantId = config.tenantId || 'default';
  const pool = aquifer._pool;

  if (!pool) {
    console.error('Stats requires direct pool access.');
    process.exit(1);
  }

  const qi = (id) => `"${id}"`;
  const [sessions, summaries, turns, entities] = await Promise.all([
    pool.query(`SELECT processing_status, COUNT(*)::int as count FROM ${qi(schema)}.sessions WHERE tenant_id = $1 GROUP BY processing_status`, [tenantId]),
    pool.query(`SELECT COUNT(*)::int as count FROM ${qi(schema)}.session_summaries WHERE tenant_id = $1`, [tenantId]),
    pool.query(`SELECT COUNT(*)::int as count FROM ${qi(schema)}.turn_embeddings WHERE tenant_id = $1`, [tenantId]),
    pool.query(`SELECT COUNT(*)::int as count FROM ${qi(schema)}.entities WHERE tenant_id = $1`, [tenantId]).catch(() => ({ rows: [{ count: 0 }] })),
  ]);

  const timeRange = await pool.query(`SELECT MIN(started_at) as earliest, MAX(started_at) as latest FROM ${qi(schema)}.sessions WHERE tenant_id = $1`, [tenantId]);

  const stats = {
    sessions: Object.fromEntries(sessions.rows.map(r => [r.processing_status, r.count])),
    sessionTotal: sessions.rows.reduce((s, r) => s + r.count, 0),
    summaries: summaries.rows[0]?.count || 0,
    turnEmbeddings: turns.rows[0]?.count || 0,
    entities: entities.rows[0]?.count || 0,
    earliest: timeRange.rows[0]?.earliest || null,
    latest: timeRange.rows[0]?.latest || null,
  };

  if (args.flags.json) {
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log(`Sessions: ${stats.sessionTotal} (${Object.entries(stats.sessions).map(([k, v]) => `${k}: ${v}`).join(', ')})`);
    console.log(`Summaries: ${stats.summaries}`);
    console.log(`Turn embeddings: ${stats.turnEmbeddings}`);
    console.log(`Entities: ${stats.entities}`);
    if (stats.earliest) console.log(`Range: ${new Date(stats.earliest).toISOString().slice(0, 10)} — ${new Date(stats.latest).toISOString().slice(0, 10)}`);
  }
}

async function cmdExport(aquifer, args) {
  const config = aquifer._config || {};
  const schema = config.schema || 'aquifer';
  const tenantId = config.tenantId || 'default';
  const pool = aquifer._pool;
  const output = args.flags.output || null;
  const limit = parseInt(args.flags.limit || '1000', 10);

  if (!pool) {
    console.error('Export requires direct pool access.');
    process.exit(1);
  }

  const qi = (id) => `"${id}"`;
  const where = [`s.tenant_id = $1`];
  const params = [tenantId];

  if (args.flags['agent-id']) { params.push(args.flags['agent-id']); where.push(`s.agent_id = $${params.length}`); }
  if (args.flags.source) { params.push(args.flags.source); where.push(`s.source = $${params.length}`); }
  params.push(limit);

  const { rows } = await pool.query(`
    SELECT s.*, ss.summary_text, ss.structured_summary
    FROM ${qi(schema)}.sessions s
    LEFT JOIN ${qi(schema)}.session_summaries ss ON ss.session_row_id = s.id
    WHERE ${where.join(' AND ')}
    ORDER BY s.started_at DESC
    LIMIT $${params.length}
  `, params);

  const stream = output ? require('fs').createWriteStream(output) : process.stdout;
  for (const row of rows) {
    stream.write(JSON.stringify({
      session_id: row.session_id,
      agent_id: row.agent_id,
      source: row.source,
      started_at: row.started_at,
      msg_count: row.msg_count,
      processing_status: row.processing_status,
      summary: row.structured_summary || row.summary_text || null,
    }) + '\n');
  }
  if (output) {
    stream.end();
    console.error(`Exported ${rows.length} sessions to ${output}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(`Usage: aquifer <command> [options]

Commands:
  migrate                     Run database migrations
  recall <query>              Search sessions (requires embed config)
  backfill                    Enrich pending sessions
  stats                       Show database statistics
  export                      Export sessions as JSONL
  mcp                         Start MCP server

Options:
  --limit N                   Limit results
  --agent-id ID               Filter by agent
  --source NAME               Filter by source
  --date-from YYYY-MM-DD      Start date
  --date-to YYYY-MM-DD        End date
  --json                      JSON output
  --dry-run                   Preview only (backfill)
  --output PATH               Output file (export)
  --config PATH               Config file path`);
    process.exit(0);
  }

  const command = argv[0];
  const args = parseArgs(argv);

  // MCP: delegate to mcp.js
  if (command === 'mcp') {
    require('./mcp').main().catch(err => {
      console.error(`aquifer mcp: ${err.message}`);
      process.exit(1);
    });
    return;
  }

  // All other commands need an Aquifer instance
  const configOverrides = {};
  if (args.flags.config) {
    // Will be picked up by loadConfig
    process.env.AQUIFER_CONFIG = args.flags.config;
  }

  const aquifer = createAquiferFromConfig(configOverrides);

  try {
    switch (command) {
      case 'migrate':
        await cmdMigrate(aquifer);
        break;
      case 'recall':
        await cmdRecall(aquifer, args);
        break;
      case 'backfill':
        await cmdBackfill(aquifer, args);
        break;
      case 'stats':
        await cmdStats(aquifer, args);
        break;
      case 'export':
        await cmdExport(aquifer, args);
        break;
      default:
        console.error(`Unknown command: ${command}. Run 'aquifer --help' for usage.`);
        process.exit(1);
    }
  } finally {
    if (aquifer._pool) await aquifer._pool.end();
  }
}

main().catch(err => {
  console.error(`aquifer: ${err.message}`);
  process.exit(1);
});
