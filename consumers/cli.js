#!/usr/bin/env node
'use strict';

/**
 * Aquifer CLI
 *
 * Usage:
 *   aquifer quickstart                  Verify end-to-end setup
 *   aquifer migrate                     Run database migrations
 *   aquifer recall <query> [options]    Search sessions
 *   aquifer backfill [options]          Enrich pending sessions
 *   aquifer stats [options]             Show database statistics
 *   aquifer export [options]            Export sessions
 *   aquifer mcp                         Start MCP server
 */

const { createAquiferFromConfig } = require('./shared/factory');

function formatDate(value, fallback) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? fallback : parsed.toISOString().slice(0, 10);
}

function quoteIdentifier(identifier) {
  if (!/^[a-zA-Z_]\w{0,62}$/.test(identifier)) {
    throw new Error(`Invalid schema name: "${identifier}"`);
  }
  return `"${identifier}"`;
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === true) return fallback;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, parsed);
}

function hasQuickstartEmbedConfig(env) {
  return !!(
    env.EMBED_PROVIDER
    || (env.AQUIFER_EMBED_BASE_URL && env.AQUIFER_EMBED_MODEL)
  );
}

function printQuickstartFailure(title, detailLines = []) {
  console.error(`     FAIL — ${title}`);
  for (const line of detailLines) {
    if (line) console.error(`     ${line}`);
  }
}

function buildQuickstartSetupHints(env, detected, err) {
  const hints = [];
  const message = err && err.message ? err.message : String(err || 'Unknown error');
  const hasDb = !!(env.DATABASE_URL || env.AQUIFER_DB_URL || detected.DATABASE_URL);
  const hasEmbed = hasQuickstartEmbedConfig(env)
    || !!detected.EMBED_PROVIDER;

  if (/Database URL is required/i.test(message)) {
    hints.push('Quickstart could not find a PostgreSQL connection.');
    if (!hasDb) {
      hints.push('If you expect local defaults, make sure PostgreSQL is running on localhost:5432.');
      hints.push('Otherwise set DATABASE_URL or AQUIFER_DB_URL explicitly and run quickstart again.');
    }
    return hints;
  }

  if (/OPENAI_API_KEY/i.test(message)) {
    hints.push('OpenAI embeddings were selected, but OPENAI_API_KEY is not set.');
    hints.push('Export OPENAI_API_KEY or switch EMBED_PROVIDER back to ollama for local quickstart.');
    return hints;
  }

  if (!hasDb || !hasEmbed) {
    hints.push('Quickstart is missing part of the local setup.');
    if (!hasDb) hints.push('PostgreSQL was not autodetected and no DATABASE_URL is set.');
    if (!hasEmbed) hints.push('No embedding provider was autodetected and no embed env is set.');
    hints.push('Try `docker compose up -d`, then run `npx aquifer quickstart` again.');
  }

  hints.push(`Raw error: ${message}`);
  return hints;
}

function buildQuickstartRecallHints(err) {
  const message = err && err.message ? err.message : String(err || 'Unknown error');

  if (/requires config\.embed\.fn|EMBED_PROVIDER/i.test(message)) {
    return [
      'Quickstart reached recall, but embeddings are not configured.',
      'Set EMBED_PROVIDER=ollama for local Ollama, or EMBED_PROVIDER=openai with OPENAI_API_KEY.',
      `Raw error: ${message}`,
    ];
  }

  if (/OPENAI_API_KEY/i.test(message)) {
    return [
      'Recall is configured to use OpenAI embeddings, but OPENAI_API_KEY is missing.',
      'Export OPENAI_API_KEY and rerun quickstart.',
      `Raw error: ${message}`,
    ];
  }

  if (/ECONNREFUSED|ENOTFOUND|fetch failed|connect/i.test(message)) {
    return [
      'Aquifer could not reach the embedding service during recall.',
      'If you expect local Ollama, make sure it is running and the model is available.',
      `Raw error: ${message}`,
    ];
  }

  return [
    'Aquifer could not recall the quickstart test session.',
    `Raw error: ${message}`,
  ];
}

// ---------------------------------------------------------------------------
// Argument parser (minimal, no deps)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  // Flags that take a value (not boolean)
  const VALUE_FLAGS = new Set(['limit', 'agent-id', 'source', 'date-from', 'date-to', 'output', 'format', 'config', 'status', 'concurrency', 'entities', 'entity-mode', 'session-id', 'verdict', 'note', 'db', 'since', 'min-messages', 'lookback-days', 'max-chars', 'out']);
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
    limit: parsePositiveInt(args.flags.limit, 5),
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

  const showExplain = !!args.flags.explain;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const ss = r.structuredSummary || {};
    const title = ss.title || r.summaryText?.slice(0, 60) || '(untitled)';
    const date = formatDate(r.startedAt, '?');
    console.log(`${i + 1}. [${r.score?.toFixed(3)}] ${title} (${date}, ${r.agentId})`);
    if (ss.overview) console.log(`   ${ss.overview.slice(0, 200)}`);
    if (r.matchedTurnText) console.log(`   > ${r.matchedTurnText.slice(0, 150)}`);
    if (showExplain && r._debug) {
      const d = r._debug;
      const f = (v) => typeof v === 'number' ? v.toFixed(3) : '?';
      const parts = [
        `rrf=${f(d.rrf)}`, `td=${f(d.timeDecay)}`, `access=${f(d.access)}`,
        `entity=${f(d.entityScore)}`, `trust=${f(d.trustScore)}(\u00d7${f(d.trustMultiplier)})`,
        `ol=${f(d.openLoopBoost)}`, `\u2192 hybrid=${f(d.hybridScore)}`,
      ];
      if (d.rerankApplied) parts.push(`rerank=${f(d.rerankScore)}(${d.rerankReason || '?'})`);
      else parts.push(`[rerank: off (${d.rerankReason || '?'})]`);
      console.log(`   ${parts.join(' ')}`);
    }
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

async function cmdFeedbackStats(aquifer, args) {
  const stats = await aquifer.feedbackStats({
    agentId: args.flags['agent-id'] || undefined,
    dateFrom: args.flags['date-from'] || undefined,
    dateTo: args.flags['date-to'] || undefined,
  });

  if (args.flags.json) {
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log(`Feedback: ${stats.totalFeedback} total (${stats.helpfulCount} helpful, ${stats.unhelpfulCount} unhelpful)`);
    console.log(`Coverage: ${stats.feedbackSessions}/${stats.totalSessions} sessions rated`);
    console.log(`Trust score: avg=${stats.trustScoreAvg} min=${stats.trustScoreMin} max=${stats.trustScoreMax}`);
  }
}

async function cmdBackfill(aquifer, args) {
  const limit = parsePositiveInt(args.flags.limit, 100);
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
    if (stats.earliest) console.log(`Range: ${formatDate(stats.earliest, '?')} — ${formatDate(stats.latest, '?')}`);
  }
}

async function cmdQuickstart(aquifer) {
  console.log('Aquifer quickstart — verifying end-to-end setup.\n');

  // 1. Migrate
  console.log('1/5  Running migrations...');
  await aquifer.migrate();
  console.log('     OK\n');

  // 2. Commit
  const sessionId = `quickstart-${Date.now()}`;
  console.log('2/5  Committing test session...');
  await aquifer.commit(sessionId, [
    { role: 'user', content: 'We decided to use PostgreSQL with pgvector for the AI memory store instead of a separate vector database.' },
    { role: 'assistant', content: 'Good choice. PG gives us ACID transactions, full-text search, and vector similarity all in one place.' },
    { role: 'user', content: 'The main advantage is turn-level embedding — we can find the exact moment a decision was made.' },
  ], { agentId: 'quickstart', source: 'quickstart' });
  console.log('     OK\n');

  // 3. Enrich (skip summary — LLM may not be configured)
  console.log('3/5  Enriching (turn embeddings)...');
  const enrichResult = await aquifer.enrich(sessionId, {
    agentId: 'quickstart',
    skipSummary: true,
    skipEntities: true,
  });
  if (Array.isArray(enrichResult.warnings) && enrichResult.warnings.length > 0) {
    printQuickstartFailure('embedding step returned warnings.', [
      'Quickstart expects turn embeddings to succeed cleanly.',
      ...enrichResult.warnings.map(w => `Warning: ${w}`),
    ]);
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(enrichResult.turnsEmbedded) || enrichResult.turnsEmbedded <= 0) {
    printQuickstartFailure('0 turns were embedded.', [
      'The quickstart test session contains user turns, so this usually means the embedding setup is not working.',
      'Check EMBED_PROVIDER / AQUIFER_EMBED_* settings, or make sure Ollama/OpenAI is reachable.',
    ]);
    process.exitCode = 1;
    return;
  }
  console.log(`     OK — ${enrichResult.turnsEmbedded} turns embedded\n`);

  // 4. Recall
  console.log('4/5  Recalling "PostgreSQL memory store"...');
  let results;
  try {
    results = await aquifer.recall('PostgreSQL memory store', { limit: 3 });
  } catch (err) {
    printQuickstartFailure('recall step failed.', buildQuickstartRecallHints(err));
    process.exitCode = 1;
    return;
  }
  if (results.length === 0) {
    printQuickstartFailure('quickstart could not recall its own test session.', [
      'The write step succeeded, but the test query returned no matches.',
      'This usually means the embedding path is misconfigured or the embed service is not reachable.',
    ]);
    process.exitCode = 1;
    return;
  }
  console.log(`     OK — ${results.length} result(s), top score: ${results[0].score?.toFixed(3)}`);
  if (results[0].matchedTurnText) {
    console.log(`     Matched: "${results[0].matchedTurnText.slice(0, 100)}..."`);
  }
  console.log();

  // 5. Cleanup
  console.log('5/5  Cleaning up test data...');
  const { Pool } = require('pg');
  const { loadConfig } = require('./shared/config');
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.db.url });
  const schema = quoteIdentifier(config.schema || 'aquifer');
  const tenantId = config.tenantId || 'default';
  try {
    await pool.query('BEGIN');
    await pool.query(
      `DELETE FROM ${schema}.sessions WHERE tenant_id = $1 AND agent_id = $2 AND session_id = $3`,
      [tenantId, 'quickstart', sessionId]
    );
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await pool.end();
  }
  console.log('     OK\n');

  console.log('✓ Aquifer is working. You can now start the MCP server:');
  console.log('  npx aquifer mcp');
}

async function cmdBootstrap(aquifer, args) {
  const result = await aquifer.bootstrap({
    agentId: args.flags['agent-id'] || undefined,
    source: args.flags.source || undefined,
    limit: parsePositiveInt(args.flags.limit, 5),
    lookbackDays: parsePositiveInt(args.flags['lookback-days'], 14),
    maxChars: parsePositiveInt(args.flags['max-chars'], 4000),
    format: args.flags.json ? 'structured' : 'text',
  });

  if (args.flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.text) {
      console.log(result.text);
    } else {
      // structured without text — format it
      const { formatBootstrapText } = require('../core/aquifer');
      const { text } = formatBootstrapText(result, result.meta?.maxChars || 4000);
      console.log(text);
    }
  }
}

async function cmdExport(aquifer, args) {
  const output = args.flags.output || null;
  const limit = parsePositiveInt(args.flags.limit, 1000);

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
   quickstart                  Verify end-to-end setup (migrate → commit → enrich → recall)
   migrate                     Run database migrations
  recall <query>              Search sessions (requires embed config)
  feedback                    Record trust feedback on a session
  feedback-stats              Show trust feedback statistics and coverage
  backfill                    Enrich pending sessions
  stats                       Show database statistics
  export                      Export sessions as JSONL
  bootstrap                   Show recent session context (for new session start)
   ingest-opencode             Import sessions from OpenCode's local SQLite DB
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
  --explain                    Show score breakdown per result (recall)
  --json                      JSON output
  --dry-run                   Preview only (backfill)
  --output PATH               Output file (export)
  --config PATH               Config file path
  --lookback-days N           How far back in days (bootstrap, default: 14)
  --max-chars N               Max output characters (bootstrap, default: 4000)
  --db PATH                   OpenCode SQLite path (ingest-opencode)
  --since YYYY-MM-DD          Only ingest sessions after date (ingest-opencode)
  --min-messages N            Min user messages to ingest (ingest-opencode, default: 3)`);
    process.exit(0);
  }

  const command = argv[0];
  const args = parseArgs(argv);
  let quickstartDetected = {};

  // MCP: delegate to mcp.js
  if (command === 'mcp') {
    require('./mcp').main().catch(err => {
      console.error(`aquifer mcp: ${err.message}`);
      process.exit(1);
    });
    return;
  }

  // mcp-contract: write canonical MCP tool manifest to disk. No Aquifer
  // instance needed — manifest is static. Default path /tmp/aquifer-mcp-contract.json.
  if (command === 'mcp-contract') {
    const { writeMcpManifestFile } = require('../index');
    const outPath = args.flags.out || '/tmp/aquifer-mcp-contract.json';
    const written = writeMcpManifestFile(outPath);
    console.log(`Wrote MCP manifest to ${written}`);
    return;
  }

  // All other commands need an Aquifer instance
  const configOverrides = {};
  if (args.flags.config) {
    // Will be picked up by loadConfig
    process.env.AQUIFER_CONFIG = args.flags.config;
  }

  // quickstart is the try-it path: autodetect docker-compose defaults so a
  // fresh `docker compose up -d && npx aquifer quickstart` works with zero env.
  // Production commands (migrate, mcp, recall, ...) stay strict — they expect
  // the operator to have set env explicitly.
  if (command === 'quickstart') {
    const { autodetectForQuickstart } = require('./shared/autodetect');
    quickstartDetected = await autodetectForQuickstart(process.env);
    if (Object.keys(quickstartDetected).length > 0) {
      console.log('Autodetected localhost services (env not set):');
      for (const [k, v] of Object.entries(quickstartDetected)) {
        console.log(`  ${k}=${v}`);
        process.env[k] = v;
      }
      console.log('  Export these in your shell (or MCP client env) to make them permanent.\n');
    }
  }

  let aquifer;
  try {
    aquifer = createAquiferFromConfig(configOverrides);
  } catch (err) {
    if (command === 'quickstart') {
      printQuickstartFailure('setup check failed before quickstart could start.', buildQuickstartSetupHints(process.env, quickstartDetected, err));
      process.exit(1);
      return;
    }
    throw err;
  }

  try {
    switch (command) {
      case 'quickstart':
        await cmdQuickstart(aquifer);
        break;
      case 'migrate':
        await cmdMigrate(aquifer);
        break;
      case 'recall':
        await cmdRecall(aquifer, args);
        break;
      case 'feedback':
        await cmdFeedback(aquifer, args);
        break;
      case 'feedback-stats':
        await cmdFeedbackStats(aquifer, args);
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
      case 'bootstrap':
        await cmdBootstrap(aquifer, args);
        break;
      case 'ingest-opencode': {
        const { ingestOpenCode } = require('./opencode');
        await ingestOpenCode(aquifer, args);
        break;
      }
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
