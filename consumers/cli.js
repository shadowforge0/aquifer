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

// ---------------------------------------------------------------------------
// Argument parser (minimal, no deps)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  // Flags that take a value (not boolean)
  const VALUE_FLAGS = new Set(['limit', 'agent-id', 'source', 'date-from', 'date-to', 'output', 'format', 'config', 'status', 'concurrency', 'entities', 'entity-mode', 'session-id', 'verdict', 'note']);
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

  const recallOpts = {
    limit: parseInt(args.flags.limit || '5', 10),
    agentId: args.flags['agent-id'] || undefined,
    source: args.flags.source || undefined,
    dateFrom: args.flags['date-from'] || undefined,
    dateTo: args.flags['date-to'] || undefined,
  };
  if (args.flags.entities) {
    recallOpts.entities = args.flags.entities.split(',').map(s => s.trim()).filter(Boolean);
    recallOpts.entityMode = args.flags['entity-mode'] || 'any';
  }
  const results = await aquifer.recall(query, recallOpts);

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

async function cmdFeedback(aquifer, args) {
  const sessionId = args.flags['session-id'] || args._[1];
  const verdict = args.flags.verdict;

  if (!sessionId || !verdict) {
    console.error('Usage: aquifer feedback --session-id ID --verdict helpful|unhelpful [--note TEXT] [--agent-id ID]');
    process.exit(1);
  }

  const result = await aquifer.feedback(sessionId, {
    verdict,
    agentId: args.flags['agent-id'] || undefined,
    note: args.flags.note || undefined,
  });

  if (args.flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Feedback: ${result.verdict} (trust ${result.trustBefore.toFixed(2)} → ${result.trustAfter.toFixed(2)})`);
  }
}

async function cmdBackfill(aquifer, args) {
  const limit = parseInt(args.flags.limit || '100', 10);
  const dryRun = !!args.flags['dry-run'];
  const skipSummary = !!args.flags['skip-summary'];
  const skipTurnEmbed = !!args.flags['skip-turn-embed'];
  const skipEntities = !!args.flags['skip-entities'];

  const pending = await aquifer.getPendingSessions({ limit });

  console.log(`Found ${pending.length} sessions to backfill${dryRun ? ' (dry-run)' : ''}`);

  let enriched = 0, failed = 0;
  for (const row of pending) {
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

  console.log(`\nDone. enriched=${enriched} failed=${failed} total=${pending.length}`);
  if (failed > 0) process.exitCode = 2;
}

async function cmdStats(aquifer, args) {
  const stats = await aquifer.getStats();

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
  const output = args.flags.output || null;
  const limit = parseInt(args.flags.limit || '1000', 10);

  const rows = await aquifer.exportSessions({
    agentId: args.flags['agent-id'],
    source: args.flags.source,
    limit,
  });

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
  feedback                    Record trust feedback on a session
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
  --entities A,B,C            Entity names (comma-separated, recall)
  --entity-mode any|all       Entity match mode (recall, default: any)
  --session-id ID             Session ID (feedback)
  --verdict helpful|unhelpful Feedback verdict (feedback)
  --note TEXT                 Feedback note (feedback)
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
      case 'feedback':
        await cmdFeedback(aquifer, args);
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
    await aquifer.close();
  }
}

// Export for testing; execute only when run directly
module.exports = { parseArgs };

if (require.main === module) {
  main().catch(err => {
    console.error(`aquifer: ${err.message}`);
    process.exit(1);
  });
}
