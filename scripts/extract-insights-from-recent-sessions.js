#!/usr/bin/env node
'use strict';

/**
 * Extract insights from recent sessions and commit them via aquifer.insights.
 *
 * Designed for cron: pulls the last N days of session_summaries for one
 * agent, sends a single LLM call to distil higher-order insights, writes
 * them to the insights table.
 *
 * This is "Route B" from spec.md Q4 — bypasses the cron prompt JSON-parse
 * fragility and lets us own the LLM call + write atomically.
 *
 * Usage:
 *   node scripts/extract-insights-from-recent-sessions.js \
 *     --agent main \
 *     [--days 14] \
 *     [--max-sessions 50] \
 *     [--types preference,pattern,frustration,workflow] \
 *     [--schema miranda] \
 *     [--tenant-id default] \
 *     [--dry-run]
 *
 * env:
 *   DATABASE_URL          required
 *   EMBED_PROVIDER        recommended (vector recall otherwise won't work)
 *   AQUIFER_LLM_PROVIDER  required (extraction LLM)
 */

const { Pool } = require('pg');
const { spawn } = require('node:child_process');
const aquiferIndex = require('..');
const { createEmbedder } = require('..');
const { resolveLlmFn } = require('../consumers/shared/llm-autodetect');

// Optional adapter: spawn the `claude` CLI (Claude Code) for extraction.
// Toggled by AQUIFER_INSIGHTS_CLI=claude. Uses OAuth from the user's
// keychain (do NOT set --bare, which disables OAuth). Returns a function
// with the same contract as resolveLlmFn's output: (prompt) => text.
function createClaudeCliFn(env) {
  const model = env.AQUIFER_INSIGHTS_CLI_MODEL || 'opus';
  const bin = env.AQUIFER_INSIGHTS_CLI_BIN || 'claude';
  const timeoutMs = parseInt(env.AQUIFER_INSIGHTS_CLI_TIMEOUT_MS || '600000', 10);
  return function llmFn(prompt) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, ['-p', '--model', model, '--output-format', 'text'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`[extract-insights] claude cli timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on('data', d => { stdout += d.toString('utf8'); });
      child.stderr.on('data', d => { stderr += d.toString('utf8'); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('exit', code => {
        clearTimeout(timer);
        if (code === 0) return resolve(stdout);
        reject(new Error(`[extract-insights] claude cli exit ${code}: ${stderr.slice(0, 800)}`));
      });
      child.stdin.end(prompt);
    });
  };
}

function parseArgs(argv) {
  const args = {
    agent: null,
    days: 14,
    maxSessions: 50,
    types: ['preference', 'pattern', 'frustration', 'workflow'],
    schema: process.env.AQUIFER_SCHEMA || 'miranda',
    tenantId: process.env.AQUIFER_TENANT_ID || 'default',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--agent') { args.agent = v; i++; }
    else if (a === '--days') { args.days = parseInt(v, 10); i++; }
    else if (a === '--max-sessions') { args.maxSessions = parseInt(v, 10); i++; }
    else if (a === '--types') { args.types = v.split(',').map(s => s.trim()); i++; }
    else if (a === '--schema') { args.schema = v; i++; }
    else if (a === '--tenant-id') { args.tenantId = v; i++; }
    else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '-h' || a === '--help') { args.help = true; }
  }
  return args;
}

function buildExtractionPrompt(sessions, types) {
  const sessionsBlock = sessions.map(s => {
    const summary = typeof s.structured_summary === 'object' ? s.structured_summary : {};
    const title = summary.title || s.summary_text?.slice(0, 80) || '(untitled)';
    const overview = summary.overview || s.summary_text || '';
    return `### Session ${s.session_id} (${s.started_at})\n${title}\n${overview}`;
  }).join('\n\n');

  const typesList = types.join(' | ');

  return `You distill HIGHER-ORDER INSIGHTS from a window of past sessions.
NOT individual facts (those go to entity_state_history). NOT raw recap.
Insights are stable observations about how the user works, what they prefer,
where they get stuck, and which workflows succeed.

Aim for 6-12 insights when the window has >50 sessions and >=3 distinct
themes. Returning only 2-3 on a rich window means you're under-extracting.
Returning 0 is only correct when the window is genuinely sparse.

## Insight types
- preference: stable user preference (e.g. "MK prefers terse responses with no trailing summaries")
- pattern: recurring behaviour or decision (e.g. "MK runs /develop before any non-trivial schema change")
- frustration: repeated pain point (e.g. "Cron jobs.json prompt parse keeps breaking on minor LLM output drift")
- workflow: reusable procedure that worked (e.g. "Aquifer release: pack tarball -> bump gateway pkg -> migrate -> restart")

## What to look for — don't just describe incidents

Technical bug patterns (timeouts, drift, regressions) are easy to spot but
shallow. The *high-value* insights are META-LEVEL signals about how the user
operates that you'd only see by reading MULTIPLE sessions back-to-back:

- **Behavioural preferences the user re-states or re-enforces.** If the user
  corrects the agent's tone, format, or process more than once across
  sessions (e.g. "stop using bullet lists", "查歷史再動手", "不要客套"),
  that's a preference worth recording. These directly shape how the agent
  should behave next time — importance 0.85-0.95.
- **Discipline gaps the user flags repeatedly.** Things like "未驗證就回答",
  "未查 context 就動手", "重複早上做過的事" are frustration insights about
  the agent's own behaviour, not about external systems. These are the
  highest-leverage insights because they prevent future trust erosion.
- **Decision-style signatures.** How the user makes calls under ambiguity:
  "prefer direct over indirect routing", "拔掉不再用的 infra 不留以後可能用",
  "選穩定版不追最新". These are rarely stated once but emerge as a shape
  across many sessions.
- **Workflows that succeeded AND the scaffolding that made them succeed.**
  Not just "user did X", but "user's X works because of Y precondition".

If you only surface technical bug frustrations and miss the meta-level
behavioural signal, you've failed at this task — a shallow extractor would
do the same.

## Strict rules
1. Insights must be TRUE ACROSS MULTIPLE SESSIONS (>=2). One-off events don't count.
2. title: <= 80 chars, declarative. The display surface — can be colourful.
3. canonicalClaim: <= 80 chars, DECLARATIVE AND STABLE. The *identity* of this
   insight. No rhetoric, no examples, no time words, no emphasis. If the same
   underlying claim shows up under a different title next run, canonicalClaim
   should be identical. Example: canonicalClaim="mk prefers prose over bullet
   lists", while title could be "散文段落，禁 bullet" or "prose-only formatting".
4. entities: array of proper-noun subjects the claim is ABOUT. Tool names,
   project names, persona names, components. Empty array [] is valid when the
   claim is generic. Example: ["Aquifer", "insights-cron"] or ["Claude Code"].
5. body: 2-4 sentences. Cite the pattern AND the root cause or user motivation,
   not just restate facts.
6. importance: 0..1.
   - 0.85-0.95: meta-level preferences + discipline gaps that directly change
     how the agent should behave (highest leverage — these go here, not lower).
   - 0.65-0.80: stable technical patterns / workflows.
   - 0.45-0.60: useful but lower-leverage observations.
   Don't bunch everything in 0.70-0.85 out of caution — spread the scale.
7. sourceSessionIds: list every session_id that contributes evidence.
   >=2 required; >=3 strongly preferred for meta-level insights.
8. type must be one of: ${typesList}.
9. Do NOT output {"insights":[]} just because you're uncertain on individual
   items. Extract what has clear evidence; omit only what lacks it.

## Output
Single JSON object, no prose, no fence:
{
  "insights": [
    {
      "type": "preference|pattern|frustration|workflow",
      "title": "...",
      "canonicalClaim": "...",
      "entities": ["..."],
      "body": "...",
      "importance": 0.7,
      "sourceSessionIds": ["sess_a", "sess_b"]
    }
  ]
}

## Sessions in window
${sessionsBlock}
`;
}

function extractJsonBlock(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first < 0 || last < first) return null;
  try { return JSON.parse(s.slice(first, last + 1)); } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.agent) {
    console.error('Usage: --agent <id> [--days 14] [--max-sessions 50] [--types ...] [--dry-run]');
    process.exit(args.help ? 0 : 2);
  }

  const dbUrl = process.env.DATABASE_URL || process.env.AQUIFER_DB_URL;
  if (!dbUrl) { console.error('DATABASE_URL is required'); process.exit(2); }

  const pool = new Pool({ connectionString: dbUrl });

  const useCli = (process.env.AQUIFER_INSIGHTS_CLI || '').toLowerCase() === 'claude';
  const llmFn = useCli
    ? createClaudeCliFn(process.env)
    : resolveLlmFn(null, process.env);
  if (!llmFn) { console.error('AQUIFER_LLM_PROVIDER + key required (or set AQUIFER_INSIGHTS_CLI=claude)'); process.exit(2); }
  console.log('[extract-insights] llm backend:', useCli ? `claude cli (${process.env.AQUIFER_INSIGHTS_CLI_MODEL || 'opus'})` : 'api provider');

  const qi = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const sessionsRes = await pool.query(
    `SELECT s.session_id, s.started_at, ss.summary_text, ss.structured_summary
     FROM ${qi(args.schema)}.sessions s
     JOIN ${qi(args.schema)}.session_summaries ss ON ss.session_row_id = s.id
     WHERE s.tenant_id = $1
       AND s.agent_id = $2
       AND s.started_at >= now() - ($3 || ' days')::interval
       AND ss.summary_text IS NOT NULL
     ORDER BY s.started_at DESC
     LIMIT $4`,
    [args.tenantId, args.agent, String(args.days), args.maxSessions]
  );

  const sessions = sessionsRes.rows;
  console.log(`[extract-insights] ${sessions.length} sessions in last ${args.days}d for agent=${args.agent}`);
  if (sessions.length === 0) {
    console.log('[extract-insights] nothing to do, exiting clean');
    await pool.end();
    return;
  }

  const prompt = buildExtractionPrompt(sessions, args.types);
  console.log('[extract-insights] sending to LLM...');
  let raw;
  try {
    raw = await llmFn(prompt);
  } catch (e) {
    console.error('[extract-insights] llm call failed:', e.message);
    await pool.end();
    process.exit(1);
  }

  const parsed = extractJsonBlock(raw);
  if (!parsed || !Array.isArray(parsed.insights)) {
    console.error('[extract-insights] malformed LLM output, dumping raw:\n', raw);
    await pool.end();
    process.exit(1);
  }
  console.log(`[extract-insights] ${parsed.insights.length} insights returned`);

  if (args.dryRun) {
    console.log(JSON.stringify(parsed.insights, null, 2));
    await pool.end();
    return;
  }

  // Build embedFn (optional — without it insights still write but recall via
  // semantic query won't work).
  let embedFn = null;
  try {
    const e = createEmbedder({});
    embedFn = (texts) => e.embedBatch(texts);
  } catch {
    console.warn('[extract-insights] embed unavailable, insights will save without vector index entries');
  }

  const aquifer = aquiferIndex.createAquifer({
    db: pool,
    schema: args.schema,
    tenantId: args.tenantId,
    embed: embedFn ? { fn: embedFn } : undefined,
  });

  // Window = oldest..newest source session timestamp (fallback to now).
  const sortedTimes = sessions.map(s => new Date(s.started_at)).sort((a, b) => a - b);
  const windowFrom = sortedTimes[0]?.toISOString() || new Date().toISOString();
  const windowTo = sortedTimes[sortedTimes.length - 1]?.toISOString() || new Date().toISOString();

  let written = 0, duplicates = 0, failed = 0;
  for (const ins of parsed.insights) {
    if (!ins || !ins.type || !args.types.includes(ins.type)) { failed++; continue; }
    const r = await aquifer.insights.commitInsight({
      agentId: args.agent,
      type: ins.type,
      title: ins.title,
      canonicalClaim: typeof ins.canonicalClaim === 'string' ? ins.canonicalClaim : undefined,
      entities: Array.isArray(ins.entities) ? ins.entities : [],
      body: ins.body,
      sourceSessionIds: Array.isArray(ins.sourceSessionIds) ? ins.sourceSessionIds : [],
      evidenceWindow: { from: windowFrom, to: windowTo },
      importance: ins.importance,
      metadata: { extractor: 'extract-insights-from-recent-sessions', windowDays: args.days },
    });
    if (!r.ok) { failed++; console.warn(`  fail ${ins.type}: ${r.error.code} ${r.error.message}`); }
    else if (r.data.duplicate) { duplicates++; console.log(`  dup  ${ins.type}: ${ins.title}`); }
    else { written++; console.log(`  ok   ${ins.type} (id=${r.data.insight.id}): ${ins.title}`); }
  }
  console.log(`[extract-insights] written=${written} dup=${duplicates} failed=${failed}`);

  await aquifer.close?.().catch(() => {});
  await pool.end().catch(() => {});
}

main().catch(err => {
  console.error('[extract-insights] fatal:', err.stack || err.message);
  process.exit(1);
});
