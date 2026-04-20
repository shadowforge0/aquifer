#!/usr/bin/env node
'use strict';

/**
 * Backfill canonical_key_v2 for legacy insights rows.
 *
 * Pre-1.5.3 rows (those predating the Phase 2 C1 canonical-identity
 * layer) carry `canonical_key_v2 IS NULL`, so they never match the
 * canonical lookup inside commitInsight and never participate in the
 * revision/supersede path. This script fills the key deterministically
 * from `title` using the same normalization and hashing functions the
 * writer uses, so backfilled rows behave identically to a freshly
 * written row whose LLM extractor happened to emit a canonicalClaim
 * equal to its title.
 *
 * Why JS not SQL: pgcrypto is NOT a default-installed extension in
 * our production PG (verified 2026-04-20). Even with pgcrypto, matching
 * JS's Unicode NFKC normalization in pure SQL is fragile. Single source
 * of truth lives in core/insights.js; this script reuses it.
 *
 * Idempotent: every UPDATE is guarded by WHERE canonical_key_v2 IS NULL,
 * so reruns and concurrent live writers converge cleanly.
 */

const { Pool } = require('pg');
const { defaultCanonicalKey } = require('../core/insights');

const BACKFILL_METADATA_PATCH = { canonicalBackfill: 'title_deterministic' };

function printUsageAndExit(code = 0) {
  const usage = [
    'Usage: node scripts/backfill-canonical-key.js --schema <name> [options]',
    '',
    'Required:',
    '  --schema <name>        Target schema (e.g. miranda, jenny)',
    '  --agent <id>           Limit to one agent (or use --all-agents)',
    '',
    'Optional:',
    '  --all-agents           Backfill across all agents in the tenant',
    '                         (mutually exclusive with --agent)',
    '  --tenant-id <id>       Default: $AQUIFER_TENANT_ID or "default"',
    '  --batch-size <N>       Rows per batch (1..1000, default 50)',
    '  --dry-run              Print would-updates, do not execute',
    '  -h, --help             Show this help',
    '',
    'Env:',
    '  DATABASE_URL           Postgres connection string (required)',
    '  AQUIFER_TENANT_ID      Fallback tenant id',
    '',
  ].join('\n');
  (code === 0 ? console.log : console.error)(usage);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    schema: null,
    agent: null,
    allAgents: false,
    tenantId: process.env.AQUIFER_TENANT_ID || 'default',
    batchSize: 50,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--schema') { args.schema = v; i++; }
    else if (a === '--agent') { args.agent = v; i++; }
    else if (a === '--all-agents') { args.allAgents = true; }
    else if (a === '--tenant-id') { args.tenantId = v; i++; }
    else if (a === '--batch-size') {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1) {
        console.error(`--batch-size must be an integer >= 1, got: ${v}`);
        process.exit(2);
      }
      args.batchSize = Math.min(n, 1000);
      i++;
    } else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '-h' || a === '--help') { args.help = true; }
    else {
      console.error(`Unknown argument: ${a}`);
      printUsageAndExit(2);
    }
  }
  return args;
}

function validate(args) {
  if (args.help) printUsageAndExit(0);
  if (!args.schema) {
    console.error('Missing required --schema');
    printUsageAndExit(2);
  }
  if (!args.agent && !args.allAgents) {
    console.error('Must specify --agent <id> or --all-agents');
    printUsageAndExit(2);
  }
  if (args.agent && args.allAgents) {
    console.error('--agent and --all-agents are mutually exclusive');
    printUsageAndExit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    printUsageAndExit(2);
  }
}

// Safe schema identifier quoting — same pattern as
// scripts/extract-insights-from-recent-sessions.js:218-219.
const qi = (s) => `"${String(s).replace(/"/g, '""')}"`;

function truncateForLog(s, n = 60) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  validate(args);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const schemaIdent = qi(args.schema);
  const agentLabel = args.allAgents ? '(all)' : args.agent;
  console.log(
    `[backfill] tenant=${args.tenantId} schema=${args.schema} `
    + `agent=${agentLabel} batch_size=${args.batchSize} dry_run=${args.dryRun}`
  );
  if (args.dryRun) {
    console.log('[backfill] DRY RUN — no updates will be executed.');
  }

  const whereClauses = [
    'canonical_key_v2 IS NULL',
    `status = 'active'`,
    'tenant_id = $1',
  ];
  const whereParams = [args.tenantId];
  if (!args.allAgents) {
    whereClauses.push(`agent_id = $${whereParams.length + 1}`);
    whereParams.push(args.agent);
  }

  let totalBackfilled = 0;
  let totalSkipped = 0;
  let totalAlreadySet = 0;
  let batchNum = 0;
  // Id watermark: prevents infinite loop when a batch yields no state
  // transitions (dry-run always, or when every row has empty title, or
  // when races cause 0 UPDATEs). WHERE id > $N advances the cursor even
  // if the current rows aren't removed from the candidate set.
  let lastId = 0;

  try {
    while (true) {
      batchNum += 1;

      const selectSql =
        `SELECT id, tenant_id, agent_id, insight_type, title
           FROM ${schemaIdent}.insights
          WHERE ${whereClauses.join(' AND ')}
            AND id > $${whereParams.length + 1}
          ORDER BY id ASC
          LIMIT $${whereParams.length + 2}`;
      const res = await pool.query(selectSql, [...whereParams, lastId, args.batchSize]);

      if (res.rowCount === 0) break;
      lastId = Number(res.rows[res.rows.length - 1].id);

      let batchBackfilled = 0;
      let batchSkipped = 0;
      let batchAlreadySet = 0;

      for (const row of res.rows) {
        const title = typeof row.title === 'string' ? row.title.trim() : '';
        if (!title) {
          console.warn(
            `[backfill] skip id=${row.id} empty or whitespace title`
          );
          batchSkipped += 1;
          continue;
        }

        const canonicalKey = defaultCanonicalKey({
          tenantId: row.tenant_id,
          agentId: row.agent_id,
          type: row.insight_type,
          canonicalClaim: title,
          entities: [],
        });

        if (args.dryRun) {
          console.log(
            `[backfill] would_update id=${row.id} agent=${row.agent_id} `
            + `type=${row.insight_type} title="${truncateForLog(title)}"`
          );
          batchBackfilled += 1;
          continue;
        }

        const updSql =
          `UPDATE ${schemaIdent}.insights
              SET canonical_key_v2 = $1,
                  metadata = metadata || $2::jsonb,
                  updated_at = now()
            WHERE id = $3 AND canonical_key_v2 IS NULL`;
        const upd = await pool.query(updSql, [
          canonicalKey,
          JSON.stringify(BACKFILL_METADATA_PATCH),
          row.id,
        ]);
        if (upd.rowCount === 0) {
          batchAlreadySet += 1;
        } else {
          batchBackfilled += 1;
        }
      }

      totalBackfilled += batchBackfilled;
      totalSkipped += batchSkipped;
      totalAlreadySet += batchAlreadySet;

      console.log(
        `[backfill] batch ${batchNum}: selected=${res.rowCount} `
        + `${args.dryRun ? 'would_backfill' : 'backfilled'}=${batchBackfilled} `
        + `skipped=${batchSkipped} already_set=${batchAlreadySet}`
      );

      // No all-skip-break guard needed: the `id > lastId` cursor
      // advances past skipped rows each iteration, so an empty-title
      // row in an otherwise healthy batch doesn't trap the loop.
    }

    const verb = args.dryRun ? 'would_backfill' : 'backfilled';
    console.log(
      `[backfill] DONE${args.dryRun ? ' dry_run' : ''} total: `
      + `${verb}=${totalBackfilled} skipped=${totalSkipped} `
      + `already_set=${totalAlreadySet}`
    );
  } catch (e) {
    console.error('[backfill] fatal:', e.stack || e.message);
    await pool.end().catch(() => {});
    process.exit(1);
  }

  await pool.end().catch(() => {});
}

main();
