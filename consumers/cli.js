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
 *   aquifer backend-info [--json]       Show selected backend capabilities
 *   aquifer export [options]            Export sessions
 *   aquifer operator ...                Run operator-safe consolidation jobs
 *   aquifer mcp                         Start MCP server
 */

const fs = require('fs');
const { createAquiferFromConfig } = require('./shared/factory');
const { loadConfig } = require('./shared/config');
const { formatRecallResults } = require('./shared/recall-format');
const { backendCapabilities } = require('../core/backends/capabilities');

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

function parseScopePath(value) {
  if (!value) return undefined;
  const parts = String(value).split(',').map(s => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function parseCsvList(value) {
  if (!value) return undefined;
  const parts = String(value).split(',').map(s => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function readJsonFlagValue(value, label) {
  if (!value || value === true) {
    throw new Error(`${label} requires a JSON value`);
  }
  try {
    return JSON.parse(String(value));
  } catch (err) {
    throw new Error(`${label} must be valid JSON: ${err.message}`);
  }
}

function readJsonFlagFile(filePath, label) {
  if (!filePath || filePath === true) {
    throw new Error(`${label} requires a file path`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`${label} must point to valid JSON: ${err.message}`);
  }
}

function readSynthesisSummaryFromFlags(flags = {}) {
  if (flags['synthesis-summary-file']) {
    return readJsonFlagFile(flags['synthesis-summary-file'], '--synthesis-summary-file');
  }
  if (flags['synthesis-summary']) {
    return readJsonFlagValue(flags['synthesis-summary'], '--synthesis-summary');
  }
  return undefined;
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
      hints.push('To inspect the degraded local starter profile without PostgreSQL, run `AQUIFER_BACKEND=local aquifer backend-info --json`.');
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
    hints.push('To inspect the degraded local starter profile without PostgreSQL, run `AQUIFER_BACKEND=local aquifer backend-info --json`.');
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
  const VALUE_FLAGS = new Set([
    'limit', 'agent-id', 'source', 'date-from', 'date-to', 'output', 'format', 'config', 'status',
    'concurrency', 'entities', 'entity-mode', 'mode', 'session-id', 'memory-id', 'canonical-key',
    'verdict', 'feedback-type', 'note', 'db', 'since', 'min-messages', 'lookback-days', 'max-chars',
    'out', 'active-scope-key', 'active-scope-path', 'cadence', 'period-start', 'period-end',
    'policy-version', 'worker-id', 'apply-token', 'claim-lease-seconds', 'snapshot-as-of',
    'scope-id', 'scope-key', 'scope-keys', 'scope-kind', 'context-key', 'topic-key', 'authority', 'input',
    'synthesis-summary', 'synthesis-summary-file', 'min-finalizations', 'checkpoint-key',
  ]);
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

  const recallOpts = { limit: parsePositiveInt(args.flags.limit, 5) };
  if (args.flags['agent-id']) recallOpts.agentId = args.flags['agent-id'];
  if (args.flags.source) recallOpts.source = args.flags.source;
  if (args.flags['date-from']) recallOpts.dateFrom = args.flags['date-from'];
  if (args.flags['date-to']) recallOpts.dateTo = args.flags['date-to'];
  if (args.flags['active-scope-key']) recallOpts.activeScopeKey = args.flags['active-scope-key'];
  if (args.flags['active-scope-path']) recallOpts.activeScopePath = parseScopePath(args.flags['active-scope-path']);
  if (args.flags.entities) {
    recallOpts.entities = args.flags.entities.split(',').map(s => s.trim()).filter(Boolean);
    recallOpts.entityMode = args.flags['entity-mode'] || 'any';
  }
  const results = await aquifer.recall(query, recallOpts);

  if (args.flags.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(formatRecallResults(results, {
    query,
    showScore: true,
    showExplain: !!args.flags.explain,
  }));
}

async function cmdFeedback(aquifer, args) {
  const sessionId = args.flags['session-id'] || args._[1];
  const verdict = args.flags.verdict;
  if (args.flags['memory-id'] || args.flags['canonical-key'] || args.flags['feedback-type']) {
    console.error('Use `aquifer memory-feedback` for curated memory feedback.');
    process.exit(1);
  }

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

async function cmdMemoryFeedback(aquifer, args) {
  const memoryId = args.flags['memory-id'];
  const canonicalKey = args.flags['canonical-key'];
  const feedbackType = args.flags['feedback-type'];

  if ((!memoryId && !canonicalKey) || !feedbackType) {
    console.error('Usage: aquifer memory-feedback (--memory-id ID | --canonical-key KEY) --feedback-type helpful|confirm|irrelevant|scope_mismatch|stale|incorrect [--note TEXT] [--agent-id ID]');
    process.exit(1);
  }

  const result = await aquifer.memoryFeedback({
    memoryId: memoryId || undefined,
    canonicalKey: canonicalKey || undefined,
  }, {
    feedbackType,
    agentId: args.flags['agent-id'] || undefined,
    note: args.flags.note || undefined,
  });

  if (args.flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const target = result.canonicalKey || result.memoryId;
    console.log(`Memory feedback: ${result.feedbackType} (${target})`);
  }
}

async function cmdEvidenceRecall(aquifer, args) {
  const query = args._.slice(1).join(' ');
  if (!query) {
    console.error('Usage: aquifer evidence-recall <query> [--limit N] [--agent-id ID] [--allow-unsafe-debug] [--json]');
    process.exit(1);
  }

  const recallOpts = { limit: parsePositiveInt(args.flags.limit, 5) };
  if (args.flags['agent-id']) recallOpts.agentId = args.flags['agent-id'];
  if (args.flags.source) recallOpts.source = args.flags.source;
  if (args.flags['date-from']) recallOpts.dateFrom = args.flags['date-from'];
  if (args.flags['date-to']) recallOpts.dateTo = args.flags['date-to'];
  if (args.flags.entities) {
    recallOpts.entities = args.flags.entities.split(',').map(s => s.trim()).filter(Boolean);
    recallOpts.entityMode = args.flags['entity-mode'] || 'any';
  }
  if (args.flags.mode) recallOpts.mode = args.flags.mode;
  if (args.flags['allow-unsafe-debug']) recallOpts.allowUnsafeDebug = true;

  const results = await aquifer.evidenceRecall(query, recallOpts);

  if (args.flags.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(formatRecallResults(results, {
    query,
    showScore: true,
    showExplain: !!args.flags.explain,
  }));
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
    console.log(`Backend: ${stats.backendKind || 'unknown'} (${stats.backendProfile || 'unknown'})`);
    console.log(`Serving mode: ${stats.serving?.mode || 'legacy'}`);
    console.log(`Active scope: ${stats.serving?.activeScopePath?.join(' > ') || stats.serving?.activeScopeKey || 'none'}`);
    console.log(`Sessions: ${stats.sessionTotal} (${Object.entries(stats.sessions).map(([k, v]) => `${k}: ${v}`).join(', ')})`);
    console.log(`Summaries: ${stats.summaries}`);
    console.log(`Turn embeddings: ${stats.turnEmbeddings}`);
    console.log(`Entities: ${stats.entities}`);
    if (stats.memoryRecords) {
      console.log(`Memory records: ${stats.memoryRecords.total} (${stats.memoryRecords.active} active, ${stats.memoryRecords.visibleInRecall} recall-visible, ${stats.memoryRecords.visibleInBootstrap} bootstrap-visible)`);
      if (stats.memoryRecords.latest) console.log(`Memory record range: ${formatDate(stats.memoryRecords.earliest, '?')} — ${formatDate(stats.memoryRecords.latest, '?')}`);
    }
    if (stats.sessionFinalizations?.available) {
      const statusText = Object.entries(stats.sessionFinalizations.statuses || {})
        .map(([status, count]) => `${status}: ${count}`)
        .join(', ') || 'none';
      console.log(`Session finalizations: ${stats.sessionFinalizations.total} (${statusText})`);
      if (stats.sessionFinalizations.latestFinalizedAt) console.log(`Latest finalization: ${formatDate(stats.sessionFinalizations.latestFinalizedAt, '?')}`);
    }
    if (stats.earliest) console.log(`Range: ${formatDate(stats.earliest, '?')} — ${formatDate(stats.latest, '?')}`);
    if ((stats.serving?.mode || 'legacy') !== 'curated') {
      console.log('Warning: legacy serving returns session/evidence material; configure curated serving with an active scope for current-memory answers.');
    }
  }
}

function selectedBackendInfo(opts = {}) {
  const config = loadConfig(opts);
  const backendKind = config.storage.backend;
  const capabilities = backendCapabilities(backendKind);
  return {
    backendKind,
    backendProfile: capabilities.profile,
    label: capabilities.label,
    summary: capabilities.summary,
    capabilities: capabilities.capabilities,
    storage: {
      localPath: config.storage.local.path,
      postgresUrlConfigured: Boolean(config.storage.postgres.url || config.db.url),
    },
    upgradeHint: capabilities.upgradeHint,
  };
}

async function cmdBackendInfo(args) {
  const info = selectedBackendInfo();
  if (args.flags.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  console.log(`Backend: ${info.label} (${info.backendKind}/${info.backendProfile})`);
  console.log(info.summary);
  console.log(`PostgreSQL URL configured: ${info.storage.postgresUrlConfigured ? 'yes' : 'no'}`);
  if (info.backendKind === 'local') {
    console.log(`Local path: ${info.storage.localPath}`);
  }
  if (info.upgradeHint) {
    console.log(`Upgrade: ${info.upgradeHint}`);
  }
  console.log('Capabilities:');
  for (const [name, status] of Object.entries(info.capabilities)) {
    console.log(`  ${name}: ${status}`);
  }
}

async function cmdLocalQuickstart(aquifer) {
  const cfg = aquifer.getConfig();
  console.log('Aquifer quickstart — verifying local starter backend.\n');

  console.log('1/5  Preparing local store...');
  await aquifer.init();
  console.log(`     OK — ${cfg.backendPath}\n`);

  const sessionId = `quickstart-local-${Date.now()}`;
  console.log('2/5  Committing test session...');
  await aquifer.commit(sessionId, [
    { role: 'user', content: 'Aquifer local starter can store a session without PostgreSQL.' },
    { role: 'assistant', content: 'Local starter uses JSON persistence and degraded lexical recall.' },
  ], { agentId: 'quickstart', source: 'quickstart' });
  console.log('     OK\n');

  console.log('3/5  Checking degraded enrich path...');
  const enrichResult = await aquifer.enrich(sessionId, {
    agentId: 'quickstart',
    skipSummary: true,
    skipEntities: true,
  });
  console.log(`     OK — ${enrichResult.turnsEmbedded} turns embedded (local starter is lexical only)\n`);

  console.log('4/5  Recalling "JSON persistence"...');
  const results = await aquifer.recall('JSON persistence', { agentId: 'quickstart', limit: 3 });
  if (results.length === 0) {
    printQuickstartFailure('local starter could not recall its own test session.', [
      'The write step succeeded, but lexical recall returned no matches.',
    ]);
    process.exitCode = 1;
    return;
  }
  console.log(`     OK — ${results.length} result(s), top score: ${results[0].score?.toFixed(3)}\n`);

  console.log('5/5  Cleaning up test data...');
  if (typeof aquifer.deleteSession === 'function') {
    await aquifer.deleteSession(sessionId, { agentId: 'quickstart' });
  }
  console.log('     OK\n');

  console.log('✓ Aquifer local starter is working.');
  console.log('  This backend is degraded: use PostgreSQL quickstart for semantic recall, migrations, curated memory, and operator workflows.');
}

async function cmdQuickstart(aquifer) {
  if (aquifer.getConfig().backendKind === 'local') {
    await cmdLocalQuickstart(aquifer);
    return;
  }

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
  const bootstrapOpts = {
    limit: parsePositiveInt(args.flags.limit, 5),
    maxChars: parsePositiveInt(args.flags['max-chars'], 4000),
    format: args.flags.json ? 'structured' : 'text',
  };
  if (args.flags['agent-id']) bootstrapOpts.agentId = args.flags['agent-id'];
  if (args.flags.source) bootstrapOpts.source = args.flags.source;
  if (args.flags['lookback-days']) bootstrapOpts.lookbackDays = parsePositiveInt(args.flags['lookback-days'], 14);
  if (args.flags['active-scope-key']) bootstrapOpts.activeScopeKey = args.flags['active-scope-key'];
  if (args.flags['active-scope-path']) bootstrapOpts.activeScopePath = parseScopePath(args.flags['active-scope-path']);
  const result = await aquifer.bootstrap(bootstrapOpts);

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

async function cmdOperator(aquifer, args) {
  const operatorVerb = args._[1] || 'compaction';
  const cadenceVerbs = new Set(['manual', 'daily', 'weekly', 'monthly']);

  if (operatorVerb === 'checkpoint') {
    const synthesisSummary = readSynthesisSummaryFromFlags(args.flags);
    const result = await aquifer.checkpoints.runProducer({
      scopeId: args.flags['scope-id'] || undefined,
      scopeKind: args.flags['scope-kind'] || undefined,
      scopeKey: args.flags['scope-key'] || undefined,
      source: args.flags.source || undefined,
      agentId: args.flags['agent-id'] || undefined,
      minFinalizations: args.flags['min-finalizations']
        ? parsePositiveInt(args.flags['min-finalizations'], 10)
        : undefined,
      limit: parsePositiveInt(args.flags.limit, 50),
      checkpointKey: args.flags['checkpoint-key'] || undefined,
      policyVersion: args.flags['policy-version'] || undefined,
      force: args.flags.force === true,
      apply: args.flags.apply === true,
      finalize: args.flags.finalize === true,
      includeSynthesisPrompt: args.flags['include-synthesis-prompt'] === true,
      synthesisSummary,
    });

    if (args.flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(result.due
      ? `Checkpoint due for ${result.scope.scopeKey}: ${result.sourceFinalizationCount} finalized source(s).`
      : `Checkpoint not ready for ${result.scope.scopeKey}: ${result.sourceFinalizationCount}/${result.minFinalizations} finalized source(s).`);
    if (result.range) {
      console.log(`Range: finalization ${result.range.fromFinalizationIdExclusive} -> ${result.range.toFinalizationIdInclusive}`);
    }
    if (result.synthesisPrompt) {
      console.log('\nCheckpoint synthesis prompt:\n');
      console.log(result.synthesisPrompt);
    }
    if (result.run) {
      console.log(`Run: #${result.run.id} status=${result.run.status}`);
    } else if (result.runInput) {
      console.log(`Run input prepared: status=${result.runInput.status}`);
      console.log('Mode: dry-run only. Re-run with --apply and an explicit synthesis summary to write checkpoint_runs.');
    }
    return;
  }

  if (operatorVerb === 'archive-distill') {
    const inputPath = args.flags.input || args._[2];
    if (!inputPath) {
      console.error('Usage: aquifer operator archive-distill --input /path/to/archive.json [--authority verified_summary] [--json]');
      process.exit(1);
    }
    const archiveSnapshot = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const result = await aquifer.memory.consolidation.runJob({
      job: 'archive-distill',
      archiveSnapshot,
      authority: args.flags.authority || undefined,
      scopeKind: args.flags['scope-kind'] || undefined,
      scopeKey: args.flags['scope-key'] || undefined,
      contextKey: args.flags['context-key'] || undefined,
      topicKey: args.flags['topic-key'] || undefined,
    });

    if (args.flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const sessionCount = Array.isArray(archiveSnapshot.sessions) ? archiveSnapshot.sessions.length : 0;
    console.log(`Archive distill planned from ${sessionCount} sessions.`);
    console.log(`Candidates: ${result.candidates.length}`);
    console.log('Visibility: recall/bootstrap hidden until a separate promotion step.');
    return;
  }

  if (operatorVerb !== 'compaction' && operatorVerb !== 'compact' && !cadenceVerbs.has(operatorVerb)) {
    console.error('Usage: aquifer operator <compaction|checkpoint|archive-distill> [...]');
    process.exit(1);
  }

  const cadence = args.flags.cadence
    || (cadenceVerbs.has(operatorVerb) ? operatorVerb : args._[2])
    || 'manual';
  const synthesisSummary = readSynthesisSummaryFromFlags(args.flags);
  const result = await aquifer.memory.consolidation.runJob({
    job: 'compaction',
    cadence,
    periodStart: args.flags['period-start'] || undefined,
    periodEnd: args.flags['period-end'] || undefined,
    policyVersion: args.flags['policy-version'] || undefined,
    workerId: args.flags['worker-id'] || undefined,
    applyToken: args.flags['apply-token'] || undefined,
    claimLeaseSeconds: args.flags['claim-lease-seconds']
      ? parsePositiveInt(args.flags['claim-lease-seconds'], undefined)
      : undefined,
    snapshotAsOf: args.flags['snapshot-as-of'] || undefined,
    scopeKeys: parseCsvList(args.flags['scope-keys'] || args.flags['scope-key']),
    scopeKind: args.flags['scope-kind'] || undefined,
    scopeKey: args.flags['scope-key'] || undefined,
    contextKey: args.flags['context-key'] || undefined,
    topicKey: args.flags['topic-key'] || undefined,
    activeScopeKey: args.flags['active-scope-key'] || undefined,
    activeScopePath: parseScopePath(args.flags['active-scope-path']),
    limit: parsePositiveInt(args.flags.limit, 1000),
    apply: args.flags.apply === true,
    promoteCandidates: args.flags['promote-candidates'] === true,
    includeSynthesisPrompt: args.flags['include-synthesis-prompt'] === true,
    synthesisSummary,
  });

  if (args.flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`${result.dryRun ? 'Planned' : 'Executed'} ${result.cadence} compaction window ${result.periodStart} -> ${result.periodEnd}`);
  console.log(`Snapshot: ${result.snapshotCount} active rows${result.snapshotTruncated ? ' (snapshot limit reached)' : ''}`);
  console.log(`Plan: ${result.plan.statusUpdates.length} lifecycle updates, ${result.plan.candidates.length} candidates`);
  if (result.synthesisPrompt) {
    console.log('\nSynthesis prompt:\n');
    console.log(result.synthesisPrompt);
  }
  if (result.promotionReview) {
    console.log(`\n${result.promotionReview}`);
  }
  if (result.dryRun) {
    console.log('Mode: dry-run only. Re-run with --apply to write compaction_runs and lifecycle changes.');
    return;
  }
  if (result.run) {
    console.log(`Run: #${result.run.id} status=${result.run.status}`);
  } else if (result.existingRun) {
    console.log(`Existing run: #${result.existingRun.id} status=${result.existingRun.status} reason=${result.skipReason || 'claim_not_acquired'}`);
  } else {
    console.log(`No run claimed: ${result.skipReason || 'claim_not_acquired'}`);
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

async function cmdCompact(aquifer, args) {
  return cmdOperator(aquifer, { ...args, _: ['operator', 'compaction', ...args._.slice(1)] });
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
  backend-info                Show selected backend capabilities without connecting to a database
  recall <query>              Search sessions (requires embed config)
  evidence-recall <query>     Search legacy session/evidence plane explicitly
  feedback                    Record trust feedback on a session
  memory-feedback             Record curated memory feedback
  feedback-stats              Show trust feedback statistics and coverage
  backfill                    Enrich pending sessions
  operator ...                Run operator-safe consolidation jobs
  compact                     Plan or apply curated memory compaction
  stats                       Show database statistics
  export                      Export sessions as JSONL
  bootstrap                   Show recent session context (for new session start)
  codex-recovery ...          Inspect or run Codex recovery/checkpoint flows
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
  --memory-id ID              Curated memory record ID (memory-feedback)
  --canonical-key KEY         Active curated memory canonical key (memory-feedback)
  --verdict helpful|unhelpful Feedback verdict (feedback)
  --feedback-type TYPE        Curated memory feedback type
  --note TEXT                 Feedback note (feedback)
  --explain                    Show score breakdown per result (recall)
  --allow-unsafe-debug        Allow broad evidence-recall without audit boundary
  --json                      JSON output
  --dry-run                   Preview only (backfill)
  --output PATH               Output file (export)
  --config PATH               Config file path
  --lookback-days N           How far back in days (bootstrap, default: 14)
  --max-chars N               Max output characters (bootstrap, default: 4000)
  --active-scope-key KEY      Active curated memory scope key
  --active-scope-path A,B     Ordered curated scope path
  --cadence manual|daily|weekly|monthly
  --period-start ISO          Compaction window start
  --period-end ISO            Compaction window end
  --apply                     Apply compaction; default is dry-run
  --promote-candidates        Promote compaction/synthesis candidates when applying
  --include-synthesis-prompt  Include timer synthesis prompt in operator output
  --synthesis-summary JSON    Timer synthesis summary JSON to attach to a compaction plan
  --synthesis-summary-file P  Read timer synthesis summary JSON from file
  --min-finalizations N       Min finalized session summaries before checkpoint proposal
  --checkpoint-key KEY        Explicit checkpoint key when applying checkpoint producer output
  --scope-key A,B             Limit compaction snapshot to specific scope keys
  --scope-id ID               Target scope row id for checkpoint producer
  --scope-kind KIND           Explicit synthesis target scope kind
  --snapshot-as-of ISO        Read active snapshot as of a specific instant
  --claim-lease-seconds N     Override compaction apply lease
  --input PATH                Archive distill input JSON path
  --db PATH                   OpenCode SQLite path (ingest-opencode)
  --since YYYY-MM-DD          Only ingest sessions after date (ingest-opencode)
  --min-messages N            Min user messages to ingest (ingest-opencode, default: 3)

Operator examples:
  aquifer operator compaction daily --json
  aquifer operator compaction daily --include-synthesis-prompt --json
  aquifer operator compaction manual --period-start 2026-04-27T00:00:00Z --period-end 2026-04-28T00:00:00Z --apply
  aquifer operator compaction daily --synthesis-summary-file /tmp/timer-summary.json --apply --promote-candidates --json
  aquifer operator checkpoint --scope-key project:aquifer --min-finalizations 10 --include-synthesis-prompt --json
  aquifer operator checkpoint --scope-id 7 --synthesis-summary-file /tmp/checkpoint-summary.json --apply --finalize --json
  AQUIFER_BACKEND=local aquifer backend-info --json
  aquifer codex-recovery checkpoint-heartbeat --hook-stdin --scope-key project:aquifer
  aquifer codex-recovery checkpoint-heartbeat-hook --scope-key project:aquifer --hooks-path "$CODEX_HOME/hooks.json" --json
  aquifer operator archive-distill --input /tmp/archive-snapshot.json --json`);
    process.exit(0);
  }

  const command = argv[0];
  const args = parseArgs(argv);
  let quickstartDetected = {};

  if (command === 'codex-recovery') {
    await require('../scripts/codex-recovery').main(argv.slice(1));
    return;
  }

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

  if (command === 'backend-info') {
    if (args.flags.config) {
      process.env.AQUIFER_CONFIG = args.flags.config;
    }
    await cmdBackendInfo(args);
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
    const selected = loadConfig({ overrides: configOverrides });
    if (selected.storage.backend !== 'local') {
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
      case 'evidence-recall':
        await cmdEvidenceRecall(aquifer, args);
        break;
      case 'feedback':
        await cmdFeedback(aquifer, args);
        break;
      case 'memory-feedback':
        await cmdMemoryFeedback(aquifer, args);
        break;
      case 'feedback-stats':
        await cmdFeedbackStats(aquifer, args);
        break;
      case 'backfill':
        await cmdBackfill(aquifer, args);
        break;
      case 'operator':
        await cmdOperator(aquifer, args);
        break;
      case 'compact':
        await cmdCompact(aquifer, args);
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
module.exports = {
  parseArgs,
  selectedBackendInfo,
  cmdBackendInfo,
  cmdLocalQuickstart,
  cmdOperator,
  readSynthesisSummaryFromFlags,
};

if (require.main === module) {
  main().catch(err => {
    console.error(`aquifer: ${err.message}`);
    process.exit(1);
  });
}
