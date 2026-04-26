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
    excludeNewest: flags['include-current'] === true ? false : true,
  };
  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined) delete opts[key];
  }
  return opts;
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
  if (candidate.updatedAt) {
    const updated = new Date(candidate.updatedAt);
    if (!Number.isNaN(updated.getTime())) counts.push(`updated ${updated.toISOString()}`);
  }
  return counts.length > 0 ? `${id} (${counts.join(', ')})` : id;
}

function renderHookContext(candidates = [], opts = {}) {
  const candidate = candidates[0];
  if (!candidate) return '';

  const promptCommand = scriptCommand('prompt', candidate, opts);
  const finalizeCommand = scriptCommand('finalize', candidate, opts, ['--summary-stdin', '--mode', 'session_start_recovery']);
  const deferCommand = scriptCommand('decision', candidate, opts, ['--verdict', 'deferred']);
  const declineCommand = scriptCommand('decision', candidate, opts, ['--verdict', 'declined']);

  return [
    '[AQUIFER RECOVERY]',
    `Aquifer found an unfinalized Codex session: ${renderCandidate(candidate)}.`,
    'This hook only scanned metadata and the finalization ledger. It has not read the full JSONL transcript.',
    'If MK agrees to recover it, run:',
    promptCommand,
    'Then summarize the sanitized transcript with the current Codex agent and write the JSON result with:',
    finalizeCommand,
    'If MK wants to decide later, run:',
    deferCommand,
    'If MK does not want to recover this session, run:',
    declineCommand,
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
    transcriptHash: candidate.transcriptHash || null,
    finalizationStatus: candidate.finalizationStatus || null,
    recoveryDecisionStatus: candidate.recoveryDecisionStatus || null,
    updatedAt: candidate.updatedAt || null,
  };
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
  const candidates = await listCandidates(aquifer, { ...opts, maxRecoveryCandidates: 1, includeJsonlPreviews: false });
  const context = renderHookContext(candidates, opts);
  if (flags.json) {
    console.log(JSON.stringify({ status: context ? 'needs_consent' : 'none', context, candidates: candidates.map(compactCandidate) }, null, 2));
    return;
  }
  if (context) console.log(context);
}

async function cmdPrompt(aquifer, flags, opts) {
  const candidates = await listCandidates(aquifer, opts);
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
  console.log(prepared.prompt);
}

async function cmdFinalize(aquifer, flags, opts) {
  const candidates = await listCandidates(aquifer, opts);
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
}

async function cmdDecision(aquifer, flags, opts) {
  const verdict = flags.verdict;
  if (!['declined', 'deferred'].includes(verdict)) {
    throw new Error('decision requires --verdict declined|deferred');
  }
  const candidates = await listCandidates(aquifer, opts);
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
  node scripts/codex-recovery.js decision --session-id ID --verdict declined|deferred [options]`);
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
  buildRecoveryOptions,
  loadCodexEnv,
  parseArgs,
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
