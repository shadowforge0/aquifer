#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAquiferFromConfig } = require('../consumers/shared/factory');
const codex = require('../consumers/codex');
const DB_ENV_KEYS = new Set(['DATABASE_URL', 'AQUIFER_DB_URL', 'AQUIFER_SCHEMA', 'AQUIFER_TENANT_ID']);

const VALUE_FLAGS = new Set([
  'agent-id',
  'codex-home',
  'config',
  'except-session-id',
  'file-path',
  'finalizer-model',
  'idle-ms',
  'max-candidates',
  'max-recovery-bytes',
  'max-recovery-chars',
  'max-recovery-messages',
  'max-recovery-prompt-tokens',
  'min-session-bytes',
  'mode',
  'reason',
  'scope-kind',
  'scope-key',
  'session-id',
  'session-key',
  'sessions-dir',
  'source',
  'state-dir',
  'structured-summary-json',
  'summary-json',
  'summary-text',
  'verdict',
  'workspace',
  'workspace-path',
  'project',
  'project-key',
  'repo-path',
]);

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (current === '--') {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (current.startsWith('--')) {
      const key = current.slice(2);
      if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args.flags[key] = argv[++i];
      } else {
        args.flags[key] = true;
      }
      continue;
    }
    args._.push(current);
  }
  return args;
}

function parseIntFlag(value, fallback) {
  if (value === undefined || value === null || value === true || value === '') return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envDefault(env, ...keys) {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== '') return value;
  }
  return null;
}

function loadEnvFile(filePath, env = process.env, opts = {}) {
  if (!filePath) return;
  const overrideKeys = opts.overrideKeys || null;
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    if (env[match[1]] && !(overrideKeys && overrideKeys.has(match[1]))) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
}

function loadCodexEnv(env = process.env, opts = {}) {
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const fileOpts = opts.overrideDb ? { overrideKeys: DB_ENV_KEYS } : {};
  loadEnvFile(env.CODEX_ENV_PATH, env, fileOpts);
  loadEnvFile(path.join(codexHome, '.env'), env, fileOpts);
}

function buildRecoveryOptions(flags = {}, env = process.env) {
  const opts = {
    agentId: flags['agent-id'] || envDefault(env, 'CODEX_AQUIFER_AGENT_ID', 'AQUIFER_AGENT_ID') || 'main',
    source: flags.source || envDefault(env, 'CODEX_AQUIFER_SOURCE', 'AQUIFER_SOURCE') || 'codex',
    sessionKey: flags['session-key'] || envDefault(env, 'CODEX_AQUIFER_SESSION_KEY') || 'codex:cli',
    workspace: flags.workspace || flags['workspace-path'] || envDefault(env, 'CODEX_AQUIFER_WORKSPACE', 'CODEX_WORKSPACE') || undefined,
    project: flags.project || flags['project-key'] || envDefault(env, 'CODEX_AQUIFER_PROJECT', 'CODEX_PROJECT') || undefined,
    repoPath: flags['repo-path'] || envDefault(env, 'CODEX_AQUIFER_REPO_PATH', 'CODEX_REPO_PATH') || undefined,
    codexHome: flags['codex-home'] || envDefault(env, 'CODEX_HOME') || undefined,
    stateDir: flags['state-dir'] || undefined,
    sessionsDir: flags['sessions-dir'] || undefined,
    maxRecoveryCandidates: parseIntFlag(flags['max-candidates'], 1),
    minSessionBytes: parseIntFlag(flags['min-session-bytes'], undefined),
    idleMs: parseIntFlag(flags['idle-ms'], undefined),
    maxRecoveryBytes: parseIntFlag(flags['max-recovery-bytes'], undefined),
    maxRecoveryMessages: parseIntFlag(flags['max-recovery-messages'], undefined),
    maxRecoveryChars: parseIntFlag(flags['max-recovery-chars'], undefined),
    maxRecoveryPromptTokens: parseIntFlag(flags['max-recovery-prompt-tokens'], undefined),
    includeJsonlPreviews: flags['include-jsonl-previews'] === true,
    includeDeferredRecovery: flags['include-deferred'] === true,
    excludeNewest: flags['include-current'] === true ? false : true,
    strictWrapperEnv: flags['strict-wrapper-env'] === true,
  };
  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined) delete opts[key];
  }
  return opts;
}

function addDoctorCheck(checks, name, status, detail, extra = {}) {
  checks.push({ name, status, detail, ...extra });
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function scriptCommand(subcommand, candidate = {}, opts = {}, extra = []) {
  const scriptPath = path.resolve(__filename);
  const parts = [process.execPath, scriptPath, subcommand];
  if (candidate.sessionId) parts.push('--session-id', candidate.sessionId);
  if (opts.agentId) parts.push('--agent-id', opts.agentId);
  if (opts.source) parts.push('--source', opts.source);
  if (opts.sessionKey) parts.push('--session-key', opts.sessionKey);
  if (opts.maxRecoveryCandidates) parts.push('--max-candidates', String(opts.maxRecoveryCandidates));
  parts.push(...extra);
  return parts.map(shellQuote).join(' ');
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function renderCandidate(candidate = {}) {
  const id = candidate.sessionId || candidate.fileSessionId || '(unknown)';
  const counts = [];
  if (candidate.userCount !== null && candidate.userCount !== undefined) counts.push(`${candidate.userCount} user turns`);
  if (candidate.messageCount !== null && candidate.messageCount !== undefined) counts.push(`${candidate.messageCount} messages`);
  if (candidate.approxPromptTokens !== null && candidate.approxPromptTokens !== undefined) counts.push(`~${candidate.approxPromptTokens} prompt tokens`);
  if (candidate.updatedAt) {
    const updated = new Date(candidate.updatedAt);
    if (!Number.isNaN(updated.getTime())) counts.push(`updated ${updated.toISOString()}`);
  }
  return counts.length > 0 ? `${id} (${counts.join(', ')})` : id;
}

function renderFinalizeCommand(candidate = {}, opts = {}, extra = []) {
  return scriptCommand('finalize', candidate, opts, [
    ...recoveryArgsForCandidate(candidate),
    '--summary-stdin',
    '--mode',
    'session_start_recovery',
    ...extra,
  ]);
}

function recoveryArgsForCandidate(candidate = {}) {
  return candidate.origin === 'jsonl_preview' ? ['--include-jsonl-previews'] : [];
}

function renderHookContext(candidates = [], opts = {}) {
  if (!candidates.length) return '';

  const sharedArgs = candidates.some(candidate => candidate.origin === 'jsonl_preview')
    ? ['--include-jsonl-previews']
    : [];
  const deferUnselectedCommand = scriptCommand('decision', {}, opts, [
    ...sharedArgs,
    '--all',
    '--except-session-id',
    'SELECTED_IDS_COMMA_SEPARATED',
    '--verdict',
    'deferred',
    '--reason',
    'not_selected_at_session_start',
  ]);
  const deferAllCommand = scriptCommand('decision', {}, opts, [
    ...sharedArgs,
    '--all',
    '--verdict',
    'deferred',
    '--reason',
    'deferred_by_user_at_session_start',
  ]);
  const declineAllCommand = scriptCommand('decision', {}, opts, [
    ...sharedArgs,
    '--all',
    '--verdict',
    'declined',
    '--reason',
    'declined_by_user_at_session_start',
  ]);
  const candidateLines = [];
  candidates.forEach((candidate, index) => {
    const previewArgs = recoveryArgsForCandidate(candidate);
    const promptCommand = scriptCommand('prompt', candidate, opts, previewArgs);
    const finalizeCommand = renderFinalizeCommand(candidate, opts);
    candidateLines.push(`${index + 1}. ${renderCandidate(candidate)}`);
    candidateLines.push(`   prompt: ${promptCommand}`);
    candidateLines.push(`   finalize: ${finalizeCommand}`);
  });

  return [
    '[AQUIFER RECOVERY]',
    `Aquifer found ${candidates.length} Codex JSONL session(s) eligible for DB recovery.`,
    'This hook scanned local JSONL only to compute eligibility, counts, hashes, and prompt budget. It did not inject transcript text.',
    'Recover all: process every candidate below one at a time with its prompt command, summarize with the current Codex agent, then write the JSON result with its finalize command.',
    'Recover selected: process only selected candidates, then mark the rest for manual recovery later with:',
    deferUnselectedCommand,
    'Recover none now but keep manual recovery available:',
    deferAllCommand,
    'Decline all recovery candidates:',
    declineAllCommand,
    'Manual later: rerun preview or prompt with --include-deferred.',
    '',
    ...candidateLines,
  ].join('\n');
}

function selectCandidate(candidates = [], flags = {}) {
  const wanted = flags['session-id'] ? String(flags['session-id']) : '';
  if (!wanted) return candidates[0] || null;
  return candidates.find((candidate) => {
    return candidate.sessionId === wanted
      || candidate.fileSessionId === wanted
      || candidate.transcriptHash === wanted;
  }) || null;
}

function compactCandidate(candidate = {}) {
  return {
    sessionId: candidate.sessionId || null,
    fileSessionId: candidate.fileSessionId || null,
    origin: candidate.origin || null,
    source: candidate.source || null,
    agentId: candidate.agentId || null,
    sessionKey: candidate.sessionKey || null,
    userCount: candidate.userCount || null,
    messageCount: candidate.messageCount || null,
    safeMessageCount: candidate.safeMessageCount || null,
    charCount: candidate.charCount || null,
    approxPromptTokens: candidate.approxPromptTokens || null,
    transcriptHash: candidate.transcriptHash || null,
    eligibilityStatus: candidate.eligibilityStatus || null,
    finalizationStatus: candidate.finalizationStatus || null,
    recoveryDecisionStatus: candidate.recoveryDecisionStatus || null,
    updatedAt: candidate.updatedAt || null,
  };
}

function compactDoctorOptions(opts = {}) {
  return {
    agentId: opts.agentId || 'main',
    source: opts.source || 'codex',
    sessionKey: opts.sessionKey || 'codex:cli',
    workspace: opts.workspace || null,
    project: opts.project || null,
    repoPath: opts.repoPath || null,
    codexHome: opts.codexHome || null,
    sessionsDir: opts.sessionsDir || null,
    stateDir: opts.stateDir || null,
    excludeNewest: opts.excludeNewest !== false,
    includeDeferredRecovery: opts.includeDeferredRecovery === true,
    maxRecoveryCandidates: opts.maxRecoveryCandidates || null,
  };
}

async function buildDoctorReport(aquifer, opts = {}, env = process.env) {
  const checks = [];
  const hasWrapperEnv = Boolean(
    env.CODEX_AQUIFER_AGENT_ID
      || env.CODEX_AQUIFER_SOURCE
      || env.CODEX_AQUIFER_SESSION_KEY
      || env.CODEX_HOME
      || env.CODEX_ENV_PATH,
  );
  if (hasWrapperEnv) {
    addDoctorCheck(checks, 'wrapper_env', 'ok', 'Codex wrapper env is present.');
  } else if (opts.strictWrapperEnv) {
    addDoctorCheck(checks, 'wrapper_env', 'fail', 'Strict wrapper env requested, but no CODEX_AQUIFER_* or CODEX_HOME env was found.');
  } else {
    addDoctorCheck(checks, 'wrapper_env', 'warn', 'Using CLI defaults; pass --strict-wrapper-env for live wrapper deployment checks.');
  }

  if (opts.excludeNewest === false) {
    addDoctorCheck(checks, 'current_transcript_guard', 'fail', 'Current/newest transcript exclusion is disabled.');
  } else {
    addDoctorCheck(checks, 'current_transcript_guard', 'ok', 'Newest transcript exclusion is enabled.');
  }

  let candidates = [];
  try {
    candidates = await listDbEligibleCandidates(aquifer, {
      ...opts,
      idleMs: opts.idleMs ?? 0,
      includeJsonlPreviews: true,
      maxRecoveryCandidates: opts.maxRecoveryCandidates || 1,
    });
    addDoctorCheck(
      checks,
      'sessionstart_preflight',
      'ok',
      `Metadata-only recovery scan completed; eligibleCandidates=${candidates.length}.`,
      { eligibleCandidates: candidates.length },
    );
  } catch (err) {
    addDoctorCheck(
      checks,
      'sessionstart_preflight',
      'fail',
      err && err.message ? err.message : String(err),
    );
  }

  const status = checks.some(check => check.status === 'fail')
    ? 'fail'
    : checks.some(check => check.status === 'warn') ? 'warn' : 'ok';
  return {
    status,
    checks,
    options: compactDoctorOptions(opts),
    candidates: candidates.map(compactCandidate),
  };
}

function parseIdList(value) {
  if (!value || value === true) return new Set();
  return new Set(String(value).split(',').map(part => part.trim()).filter(Boolean));
}

function readSummaryJson(flags = {}) {
  if (flags['summary-stdin']) {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) throw new Error('summary JSON stdin is empty');
    return JSON.parse(raw);
  }
  if (flags['summary-json']) {
    const raw = fs.readFileSync(flags['summary-json'], 'utf8');
    return JSON.parse(raw);
  }
  const summaryText = oneLine(flags['summary-text']);
  const structuredRaw = flags['structured-summary-json'];
  const structuredSummary = structuredRaw ? JSON.parse(structuredRaw) : {};
  if (!summaryText && Object.keys(structuredSummary).length === 0) {
    throw new Error('finalize requires --summary-stdin, --summary-json, or --summary-text');
  }
  return { summaryText, structuredSummary };
}

function finalizationReviewText(result = {}) {
  return result.humanReviewText
    || result.human_review_text
    || result.finalization?.humanReviewText
    || result.finalization?.human_review_text
    || result.finalization?.finalization?.humanReviewText
    || result.finalization?.finalization?.human_review_text
    || '';
}

async function withAquifer(fn) {
  let aquifer;
  try {
    loadCodexEnv(process.env, { overrideDb: true });
    aquifer = createAquiferFromConfig({});
    return await fn(aquifer);
  } finally {
    if (aquifer && typeof aquifer.close === 'function') {
      await aquifer.close().catch(() => {});
    }
  }
}

async function listCandidates(aquifer, opts) {
  return codex.findRecoveryCandidates(aquifer, opts);
}

async function listDbEligibleCandidates(aquifer, opts) {
  return codex.findDbEligibleRecoveryCandidates(aquifer, opts);
}

async function listOperationalCandidates(aquifer, opts) {
  if (opts && opts.includeJsonlPreviews) {
    return listDbEligibleCandidates(aquifer, opts);
  }
  return listCandidates(aquifer, opts);
}

async function cmdPreview(aquifer, flags, opts) {
  const candidates = await listCandidates(aquifer, opts);
  if (flags.json) {
    console.log(JSON.stringify({ status: candidates.length ? 'needs_consent' : 'none', candidates: candidates.map(compactCandidate) }, null, 2));
    return;
  }
  if (candidates.length === 0) {
    console.log('No Codex recovery candidates.');
    return;
  }
  for (const candidate of candidates) console.log(renderCandidate(candidate));
}

async function cmdHookContext(aquifer, flags, opts) {
  const maxRecoveryCandidates = Number.isFinite(opts.maxRecoveryCandidates)
    ? Math.max(1, opts.maxRecoveryCandidates)
    : 1;
  const candidates = await listDbEligibleCandidates(aquifer, {
    ...opts,
    idleMs: opts.idleMs ?? 0,
    maxRecoveryCandidates,
    includeJsonlPreviews: true,
  });
  const context = renderHookContext(candidates, opts);
  if (flags.json) {
    console.log(JSON.stringify({ status: context ? 'needs_consent' : 'none', context, candidates: candidates.map(compactCandidate) }, null, 2));
    return;
  }
  if (context) console.log(context);
}

async function cmdPrompt(aquifer, flags, opts) {
  const candidates = await listOperationalCandidates(aquifer, opts);
  const candidate = selectCandidate(candidates, flags);
  if (!candidate) throw new Error(`No matching Codex recovery candidate: ${flags['session-id'] || '(first)'}`);
  const prepared = await codex.prepareSessionStartRecovery(aquifer, {
    ...opts,
    consent: true,
    candidate,
  });
  if (flags.json) {
    console.log(JSON.stringify({
      status: prepared.status,
      candidate: compactCandidate(candidate),
      view: prepared.view ? {
        status: prepared.view.status,
        sessionId: prepared.view.sessionId,
        transcriptHash: prepared.view.transcriptHash,
        charCount: prepared.view.charCount,
        approxPromptTokens: prepared.view.approxPromptTokens,
        counts: prepared.view.counts,
      } : null,
      prompt: prepared.prompt || null,
    }, null, 2));
    return;
  }
  if (prepared.status !== 'needs_agent_summary') {
    console.log(`Recovery prompt unavailable: ${prepared.status}`);
    return;
  }
  console.log([
    prepared.prompt,
    '',
    '[AQUIFER FINALIZE]',
    'After returning the JSON summary, pipe it into:',
    renderFinalizeCommand(candidate, opts),
  ].join('\n'));
}

async function cmdFinalize(aquifer, flags, opts) {
  const candidates = await listOperationalCandidates(aquifer, opts);
  const candidate = selectCandidate(candidates, flags);
  if (!candidate && !flags['file-path']) {
    throw new Error(`No matching Codex recovery candidate: ${flags['session-id'] || '(first)'}`);
  }
  const summary = readSummaryJson(flags);
  const result = await codex.finalizeCodexSession(aquifer, {
    candidate: candidate || null,
    filePath: flags['file-path'] || undefined,
    sessionId: flags['session-id'] || candidate?.sessionId || undefined,
    summary,
    mode: flags.mode || 'handoff',
    agentId: opts.agentId,
    source: opts.source,
    sessionKey: opts.sessionKey,
    finalizerModel: flags['finalizer-model'] || undefined,
    scopeKind: flags['scope-kind'] || undefined,
    scopeKey: flags['scope-key'] || undefined,
  }, opts);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Finalization ${result.status}: ${result.sessionId || flags['session-id'] || '(unknown)'}`);
  const review = finalizationReviewText(result);
  if (review) console.log(review);
}

async function cmdDecision(aquifer, flags, opts) {
  const verdict = flags.verdict;
  if (!['declined', 'deferred'].includes(verdict)) {
    throw new Error('decision requires --verdict declined|deferred');
  }
  const candidates = await listOperationalCandidates(aquifer, opts);
  if (flags.all === true) {
    const exceptIds = parseIdList(flags['except-session-id']);
    const selected = candidates.filter(candidate => {
      const ids = [candidate.sessionId, candidate.fileSessionId, candidate.transcriptHash].filter(Boolean);
      return !ids.some(id => exceptIds.has(id));
    });
    const results = [];
    for (const candidate of selected) {
      results.push(await codex.recordRecoveryDecision(aquifer, candidate, verdict, {
        ...opts,
        reason: flags.reason || null,
        mode: 'session_start_recovery',
      }));
    }
    if (flags.json) {
      console.log(JSON.stringify({ status: verdict, count: results.length, results }, null, 2));
      return;
    }
    console.log(`Recovery ${verdict}: ${results.length} candidate(s)`);
    return;
  }
  const candidate = selectCandidate(candidates, flags);
  if (!candidate) throw new Error(`No matching Codex recovery candidate: ${flags['session-id'] || '(first)'}`);
  const result = await codex.recordRecoveryDecision(aquifer, candidate, verdict, {
    ...opts,
    reason: flags.reason || null,
    mode: 'session_start_recovery',
  });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Recovery ${verdict}: ${candidate.sessionId}`);
}

async function cmdDoctor(aquifer, flags, opts, env = process.env) {
  const report = await buildDoctorReport(aquifer, opts, env);
  printDoctorReport(report, flags);
  return report;
}

function printDoctorReport(report = {}, flags = {}) {
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Codex recovery doctor: ${report.status}`);
    for (const check of report.checks || []) {
      console.log(`- ${check.status} ${check.name}: ${check.detail}`);
    }
  }
  if (report.status === 'fail') process.exitCode = 1;
}

async function cmdDoctorInitFailure(flags, opts, err, env = process.env) {
  let report = await buildDoctorReport(null, opts, env);
  report = {
    ...report,
    status: 'fail',
    checks: [
      {
        name: 'aquifer_init',
        status: 'fail',
        detail: err && err.message ? err.message : String(err),
      },
      ...(report.checks || []),
    ],
  };
  printDoctorReport(report, flags);
  return report;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'help';
  if (args.flags.config) process.env.AQUIFER_CONFIG = args.flags.config;
  const opts = buildRecoveryOptions(args.flags);

  if (command === 'help' || args.flags.help || args.flags.h) {
    console.log(`Usage:
  node scripts/codex-recovery.js hook-context [options]
  node scripts/codex-recovery.js preview [options]
  node scripts/codex-recovery.js prompt --session-id ID [options]
  node scripts/codex-recovery.js finalize --session-id ID --summary-stdin [options]
  node scripts/codex-recovery.js decision --session-id ID --verdict declined|deferred [options]
  node scripts/codex-recovery.js decision --all --verdict declined|deferred [options]
  node scripts/codex-recovery.js doctor [--strict-wrapper-env] [--json]`);
    return;
  }

  if (command === 'doctor') {
    try {
      await withAquifer(async (aquifer) => {
        await cmdDoctor(aquifer, args.flags, opts);
      });
    } catch (err) {
      await cmdDoctorInitFailure(args.flags, opts, err);
    }
    return;
  }

  await withAquifer(async (aquifer) => {
    switch (command) {
      case 'preview':
        await cmdPreview(aquifer, args.flags, opts);
        break;
      case 'hook-context':
        await cmdHookContext(aquifer, args.flags, opts);
        break;
      case 'prompt':
        await cmdPrompt(aquifer, args.flags, opts);
        break;
      case 'finalize':
        await cmdFinalize(aquifer, args.flags, opts);
        break;
      case 'decision':
        await cmdDecision(aquifer, args.flags, opts);
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  });
}

module.exports = {
  buildDoctorReport,
  buildRecoveryOptions,
  cmdDecision,
  cmdDoctor,
  cmdDoctorInitFailure,
  cmdFinalize,
  cmdHookContext,
  cmdPrompt,
  loadCodexEnv,
  main,
  parseArgs,
  renderFinalizeCommand,
  renderHookContext,
  selectCandidate,
};

if (require.main === module) {
  main().catch((err) => {
    if (process.argv[2] !== 'hook-context') {
      console.error(`codex-recovery: ${err.message}`);
      process.exit(1);
      return;
    }
    process.exit(0);
  });
}
