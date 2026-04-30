'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../consumers/shared/config');
const codex = require('../consumers/codex');

function parseIntFlag(value, fallback) {
  if (value === undefined || value === null || value === true || value === '') return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function checkpointMarkerDir(flags = {}, opts = {}) {
  if (flags['checkpoint-marker-dir']) return flags['checkpoint-marker-dir'];
  const paths = codex.defaultPaths(opts);
  return path.join(path.dirname(paths.importedDir), 'codex-active-checkpoints');
}

function checkpointSchedulerDir(flags = {}, opts = {}) {
  if (flags['checkpoint-scheduler-dir']) return flags['checkpoint-scheduler-dir'];
  const paths = codex.defaultPaths(opts);
  return path.join(path.dirname(paths.importedDir), 'codex-active-checkpoint-scheduler');
}

function checkpointClaimDir(flags = {}, opts = {}) {
  if (flags['checkpoint-claim-dir']) return flags['checkpoint-claim-dir'];
  const paths = codex.defaultPaths(opts);
  return path.join(path.dirname(paths.importedDir), 'codex-active-checkpoint-claims');
}

function checkpointSpoolDir(flags = {}, opts = {}) {
  if (flags['checkpoint-spool-dir']) return flags['checkpoint-spool-dir'];
  const paths = codex.defaultPaths(opts);
  return path.join(path.dirname(paths.importedDir), 'codex-active-checkpoint-spool');
}

function viewMessageCount(view = {}) {
  return Number.isFinite(Number(view.counts?.safeMessageCount))
    ? Number(view.counts.safeMessageCount)
    : (Array.isArray(view.messages) ? view.messages.length : 0);
}

function viewUserCount(view = {}) {
  return Number.isFinite(Number(view.counts?.userCount))
    ? Number(view.counts.userCount)
    : (Array.isArray(view.messages) ? view.messages.filter(message => message.role === 'user').length : 0);
}

function positiveThreshold(value, fallback) {
  const parsed = parseIntFlag(value, fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadRuntimeConfig(flags = {}, opts = {}) {
  return loadConfig({
    env: opts.env || process.env,
    configPath: flags.config || (opts.env || process.env).AQUIFER_CONFIG || null,
    cwd: opts.cwd || process.cwd(),
  });
}

function checkpointPolicy(config = {}) {
  return config.codex?.checkpoint || {};
}

function configuredNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function checkpointCheckIntervalMs(flags = {}, config = {}) {
  const policy = checkpointPolicy(config);
  if (flags['checkpoint-check-interval-ms'] !== undefined) {
    return Math.max(0, parseIntFlag(flags['checkpoint-check-interval-ms'], 600000));
  }
  if (flags['checkpoint-check-interval-minutes'] !== undefined) {
    return Math.max(0, parseIntFlag(flags['checkpoint-check-interval-minutes'], 10) * 60 * 1000);
  }
  if (policy.checkIntervalMs !== undefined && policy.checkIntervalMs !== null) {
    return Math.max(0, configuredNumber(policy.checkIntervalMs, 600000));
  }
  return Math.max(0, configuredNumber(policy.checkIntervalMinutes, 10) * 60 * 1000);
}

function checkpointQuietMs(flags = {}, config = {}) {
  return Math.max(0, parseIntFlag(
    flags['checkpoint-quiet-ms'],
    configuredNumber(checkpointPolicy(config).quietMs, 3000),
  ));
}

function checkpointClaimTtlMs(flags = {}, config = {}) {
  return Math.max(1000, parseIntFlag(
    flags['checkpoint-claim-ttl-ms'],
    configuredNumber(checkpointPolicy(config).claimTtlMs, 60000),
  ));
}

function checkpointEveryMessages(flags = {}, config = {}) {
  return positiveThreshold(
    flags['checkpoint-every-messages'],
    configuredNumber(checkpointPolicy(config).everyMessages, 20),
  );
}

function checkpointEveryUserMessages(flags = {}, config = {}) {
  if (flags['checkpoint-every-user-messages']) {
    return positiveThreshold(flags['checkpoint-every-user-messages'], 10);
  }
  const configured = checkpointPolicy(config).everyUserMessages;
  return configured === undefined || configured === null
    ? null
    : positiveThreshold(configured, 10);
}

function checkpointProposalWindow(marker = null, intervalMs = 0, nowMs = Date.now()) {
  const lastProposalMs = marker?.lastProposalAt ? Date.parse(marker.lastProposalAt) : NaN;
  if (!Number.isFinite(lastProposalMs)) return { due: true, lastProposalAt: null, nextProposalAt: null };
  const nextMs = lastProposalMs + Math.max(0, intervalMs);
  return {
    due: nowMs >= nextMs,
    lastProposalAt: marker.lastProposalAt,
    nextProposalAt: isoAt(nextMs),
  };
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function readJsonFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readSchedulerMarker(dir, sessionId) {
  if (!dir || !sessionId) return null;
  const filePath = codex.markerPath(dir, sessionId);
  const parsed = readJsonFile(filePath);
  return parsed ? { ...parsed, markerPath: filePath } : null;
}

function writeSchedulerMarker(dir, sessionId, patch = {}) {
  if (!dir || !sessionId) return null;
  fs.mkdirSync(dir, { recursive: true });
  const filePath = codex.markerPath(dir, sessionId);
  const existing = readSchedulerMarker(dir, sessionId) || {};
  const marker = {
    kind: 'codex_active_checkpoint_scheduler_v1',
    ...existing,
    ...patch,
    sessionId,
    updatedAt: new Date().toISOString(),
  };
  delete marker.markerPath;
  fs.writeFileSync(filePath, `${JSON.stringify(marker)}\n`, 'utf8');
  return { ...marker, markerPath: filePath };
}

function readCheckpointMarker(dir, sessionId) {
  if (!dir || !sessionId) return null;
  const filePath = codex.markerPath(dir, sessionId);
  const parsed = readJsonFile(filePath);
  return parsed ? { ...parsed, markerPath: filePath } : null;
}

function writeCheckpointMarker(dir, prepared = {}) {
  const sessionId = prepared.view?.sessionId || prepared.checkpointInput?.transcript?.sessionId;
  if (!dir || !sessionId) return null;
  fs.mkdirSync(dir, { recursive: true });
  const filePath = codex.markerPath(dir, sessionId);
  const marker = {
    kind: 'codex_active_checkpoint_marker_v1',
    sessionId,
    filePath: prepared.view?.filePath || null,
    writtenAt: new Date().toISOString(),
    transcriptHash: prepared.view?.transcriptHash || null,
    inputHash: prepared.checkpointInput?.inputHash || null,
    messageCount: viewMessageCount(prepared.view),
    userCount: viewUserCount(prepared.view),
    coverage: prepared.checkpointInput?.coverage || null,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(marker)}\n`, 'utf8');
  return { ...marker, markerPath: filePath };
}

function checkpointDueFromMarker(view = {}, marker = null, flags = {}, config = {}) {
  const everyMessages = checkpointEveryMessages(flags, config);
  const everyUserMessages = checkpointEveryUserMessages(flags, config);
  const messageCount = viewMessageCount(view);
  const userCount = viewUserCount(view);
  const markerMessageCount = Number(marker?.messageCount || 0);
  const markerUserCount = Number(marker?.userCount || 0);
  const deltaMessages = Math.max(0, messageCount - markerMessageCount);
  const deltaUserMessages = Math.max(0, userCount - markerUserCount);
  const due = Boolean(flags.force === true
    || (!marker && (messageCount >= everyMessages || (everyUserMessages !== null && userCount >= everyUserMessages)))
    || (marker && (deltaMessages >= everyMessages || (everyUserMessages !== null && deltaUserMessages >= everyUserMessages))));
  return {
    due,
    everyMessages,
    everyUserMessages,
    messageCount,
    userCount,
    markerMessageCount,
    markerUserCount,
    deltaMessages,
    deltaUserMessages,
  };
}

function findNewestJsonlFile(dir) {
  if (!dir) return null;
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        files.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs });
      } catch {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
  return files[0]?.filePath || null;
}

function isPathInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateCheckpointTranscriptPath(filePath, opts = {}) {
  if (!filePath) return { ok: false, status: 'missing_file_path' };
  if (path.extname(filePath) !== '.jsonl') {
    return { ok: false, status: 'invalid_transcript_path', reason: 'not_jsonl', filePath };
  }
  const sessionsDir = opts.sessionsDir || codex.defaultPaths(opts).sessionsDir;
  let realFile;
  let realSessionsDir;
  let stat;
  try {
    realFile = fs.realpathSync(filePath);
    realSessionsDir = fs.realpathSync(sessionsDir);
    stat = fs.statSync(realFile);
  } catch {
    return { ok: false, status: 'not_found', filePath, sessionsDir };
  }
  if (!isPathInside(realFile, realSessionsDir)) {
    return {
      ok: false,
      status: 'invalid_transcript_path',
      reason: 'outside_sessions_dir',
      filePath: realFile,
      sessionsDir: realSessionsDir,
    };
  }
  if (!stat.isFile()) {
    return { ok: false, status: 'invalid_transcript_path', reason: 'not_regular_file', filePath: realFile };
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    return { ok: false, status: 'invalid_transcript_path', reason: 'owner_mismatch', filePath: realFile };
  }
  return { ok: true, filePath: realFile, sessionsDir: realSessionsDir, stat };
}

function checkpointHeartbeatInput(flags = {}, hookInput = {}) {
  return {
    sessionId: flags['session-id'] || hookInput.session_id || undefined,
    filePath: flags['file-path'] || hookInput.transcript_path || undefined,
    hookEventName: hookInput.hook_event_name || flags['hook-event-name'] || undefined,
  };
}

function claimPayload(nowMs, ttlMs) {
  return {
    pid: process.pid,
    createdAt: isoAt(nowMs),
    expiresAt: isoAt(nowMs + ttlMs),
  };
}

function acquireHeartbeatClaim(dir, sessionId, nowMs = Date.now(), ttlMs = 60000) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = codex.markerPath(dir, sessionId);
  const payload = claimPayload(nowMs, ttlMs);
  const content = `${JSON.stringify(payload)}\n`;
  try {
    const fd = fs.openSync(filePath, 'wx');
    try {
      fs.writeFileSync(fd, content, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return { acquired: true, filePath, payload };
  } catch (err) {
    if (err && err.code !== 'EEXIST') {
      return { acquired: false, filePath, reason: err.message || 'claim_failed' };
    }
  }

  const existing = readJsonFile(filePath);
  const expiresMs = existing?.expiresAt ? Date.parse(existing.expiresAt) : NaN;
  if (Number.isFinite(expiresMs) && expiresMs > nowMs) {
    return { acquired: false, filePath, reason: 'claim_active', existing };
  }

  try {
    fs.unlinkSync(filePath);
  } catch {}
  try {
    const fd = fs.openSync(filePath, 'wx');
    try {
      fs.writeFileSync(fd, content, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return { acquired: true, filePath, payload, staleReplaced: true };
  } catch (err) {
    return { acquired: false, filePath, reason: err?.message || 'claim_race' };
  }
}

function releaseHeartbeatClaim(claim) {
  if (!claim?.acquired || !claim.filePath) return;
  const existing = readJsonFile(claim.filePath);
  if (existing?.pid !== claim.payload?.pid || existing?.createdAt !== claim.payload?.createdAt) return;
  try {
    fs.unlinkSync(claim.filePath);
  } catch {}
}

function spoolCheckpointProposal(dir, prepared = {}, meta = {}) {
  const sessionId = prepared.view?.sessionId || meta.sessionId;
  if (!dir || !sessionId || !prepared.prompt) return null;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `${codex.safeMarkerKey(sessionId)}-${stamp}-${process.pid}.json`);
  const payload = {
    kind: 'codex_active_checkpoint_pending_v1',
    createdAt: new Date().toISOString(),
    sessionId,
    source: meta.source || 'codex-heartbeat',
    hookEventName: meta.hookEventName || null,
    triggerKind: meta.triggerKind || 'time_window_message_delta',
    guards: {
      checkpointIsProcessMaterial: true,
      stdoutPromptExcluded: true,
      additionalContextExcluded: true,
      dbWriteExcluded: true,
      activeMemoryCommitExcluded: true,
      rawHookPromptExcluded: true,
    },
    threshold: prepared.checkpointInput?.threshold || null,
    coverage: prepared.checkpointInput?.coverage || null,
    prompt: prepared.prompt,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { filePath, createdAt: payload.createdAt };
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function defaultHooksPath(opts = {}) {
  const codexHome = opts.codexHome || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'hooks.json');
}

function checkpointHeartbeatCommand(flags = {}, opts = {}) {
  const parts = [
    process.execPath,
    opts.scriptPath || path.resolve(__dirname, 'codex-recovery.js'),
    'checkpoint-heartbeat',
    '--hook-stdin',
  ];
  const pushValue = (flag, value) => {
    if (value !== undefined && value !== null && value !== '' && value !== true) {
      parts.push(flag, String(value));
    }
  };
  pushValue('--scope-key', flags['scope-key'] || flags['active-scope-key']);
  pushValue('--active-scope-key', flags['active-scope-key']);
  pushValue('--active-scope-path', flags['active-scope-path']);
  pushValue('--config', flags.config);
  pushValue('--checkpoint-check-interval-ms', flags['checkpoint-check-interval-ms']);
  pushValue('--checkpoint-check-interval-minutes', flags['checkpoint-check-interval-minutes']);
  pushValue('--checkpoint-every-messages', flags['checkpoint-every-messages']);
  pushValue('--checkpoint-every-user-messages', flags['checkpoint-every-user-messages']);
  pushValue('--checkpoint-quiet-ms', flags['checkpoint-quiet-ms']);
  pushValue('--checkpoint-scheduler-dir', flags['checkpoint-scheduler-dir']);
  pushValue('--checkpoint-claim-dir', flags['checkpoint-claim-dir']);
  pushValue('--checkpoint-spool-dir', flags['checkpoint-spool-dir']);
  pushValue('--checkpoint-claim-ttl-ms', flags['checkpoint-claim-ttl-ms']);
  pushValue('--agent-id', flags['agent-id']);
  pushValue('--source', flags.source);
  pushValue('--session-key', flags['session-key']);
  pushValue('--workspace', flags.workspace || flags['workspace-path']);
  pushValue('--project', flags.project || flags['project-key']);
  pushValue('--repo-path', flags['repo-path']);
  pushValue('--codex-home', flags['codex-home']);
  return parts.map(shellQuote).join(' ');
}

function readHooksConfig(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return { hooks: {} };
    const parsed = JSON.parse(raw);
    if (!parsed.hooks || typeof parsed.hooks !== 'object') parsed.hooks = {};
    return parsed;
  } catch (err) {
    if (err && err.code === 'ENOENT') return { hooks: {} };
    throw err;
  }
}

function mergeCheckpointHeartbeatHook(existing = { hooks: {} }, flags = {}, opts = {}) {
  const out = JSON.parse(JSON.stringify(existing || { hooks: {} }));
  if (!out.hooks || typeof out.hooks !== 'object') out.hooks = {};
  const event = 'UserPromptSubmit';
  if (!Array.isArray(out.hooks[event])) out.hooks[event] = [];
  const group = {
    hooks: [{
      type: 'command',
      command: checkpointHeartbeatCommand(flags, opts),
    }],
  };
  const existingGroup = out.hooks[event].find((candidate) => {
    return Array.isArray(candidate?.hooks)
      && candidate.hooks.some((hook) => String(hook?.command || '').includes('checkpoint-heartbeat'));
  });
  if (existingGroup) {
    delete existingGroup.matcher;
    existingGroup.hooks = group.hooks;
  } else {
    out.hooks[event].push(group);
  }
  return out;
}

function inspectCheckpointHeartbeatHook(opts = {}) {
  const hooksPath = opts.hooksPath || defaultHooksPath(opts);
  let parsed;
  try {
    parsed = readHooksConfig(hooksPath);
  } catch (err) {
    return {
      status: 'fail',
      hooksPath,
      installed: false,
      detail: err && err.message ? err.message : String(err),
    };
  }
  const groups = Array.isArray(parsed.hooks?.UserPromptSubmit) ? parsed.hooks.UserPromptSubmit : [];
  const installed = groups.some((group) => {
    return Array.isArray(group?.hooks)
      && group.hooks.some((hook) => String(hook?.command || '').includes('checkpoint-heartbeat'));
  });
  return {
    status: installed ? 'ok' : 'warn',
    hooksPath,
    installed,
    detail: installed
      ? 'UserPromptSubmit checkpoint heartbeat hook is installed.'
      : 'UserPromptSubmit checkpoint heartbeat hook is not installed.',
  };
}

module.exports = {
  acquireHeartbeatClaim,
  checkpointCheckIntervalMs,
  checkpointClaimDir,
  checkpointClaimTtlMs,
  checkpointDueFromMarker,
  checkpointEveryMessages,
  checkpointEveryUserMessages,
  checkpointHeartbeatCommand,
  checkpointHeartbeatInput,
  checkpointMarkerDir,
  checkpointProposalWindow,
  checkpointQuietMs,
  checkpointSchedulerDir,
  checkpointSpoolDir,
  defaultHooksPath,
  findNewestJsonlFile,
  inspectCheckpointHeartbeatHook,
  isoAt,
  loadRuntimeConfig,
  mergeCheckpointHeartbeatHook,
  readCheckpointMarker,
  readHooksConfig,
  readSchedulerMarker,
  releaseHeartbeatClaim,
  spoolCheckpointProposal,
  validateCheckpointTranscriptPath,
  viewMessageCount,
  viewUserCount,
  writeCheckpointMarker,
  writeSchedulerMarker,
};
