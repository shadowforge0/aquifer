'use strict';

const fs = require('fs');
const path = require('path');

const codex = require('../consumers/codex');
const {
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
  checkpointSchedulerDir,
  checkpointSpoolDir,
  defaultHooksPath,
  findNewestJsonlFile,
  isoAt,
  loadRuntimeConfig,
  mergeCheckpointHeartbeatHook,
  readCheckpointMarker,
  readHooksConfig,
  readSchedulerMarker,
  releaseHeartbeatClaim,
  spoolCheckpointProposal,
  validateCheckpointTranscriptPath,
  writeCheckpointMarker,
  writeSchedulerMarker,
} = require('./codex-checkpoint-runtime');

function parseIntFlag(value, fallback) {
  if (value === undefined || value === null || value === true || value === '') return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseScopePath(value) {
  if (!value || value === true) return undefined;
  const parts = String(value).split(',').map(part => part.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function readHookInputFromStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function cmdCheckpointPrompt(aquifer, flags, opts) {
  const filePath = flags['file-path'];
  if (!filePath) throw new Error('checkpoint-prompt requires --file-path');
  const prepared = await codex.prepareActiveSessionCheckpoint(aquifer, {
    ...opts,
    filePath,
    sessionId: flags['session-id'] || undefined,
    scopeKind: flags['scope-kind'] || undefined,
    scopeKey: flags['scope-key'] || flags['active-scope-key'] || undefined,
    activeScopeKey: flags['active-scope-key'] || flags['scope-key'] || undefined,
    activeScopePath: parseScopePath(flags['active-scope-path']),
    checkpointEveryMessages: parseIntFlag(flags['checkpoint-every-messages'], undefined),
    checkpointEveryUserMessages: parseIntFlag(flags['checkpoint-every-user-messages'], undefined),
    maxCheckpointBytes: parseIntFlag(flags['max-checkpoint-bytes'], undefined),
    maxCheckpointMessages: parseIntFlag(flags['max-checkpoint-messages'], undefined),
    maxCheckpointChars: parseIntFlag(flags['max-checkpoint-chars'], undefined),
    maxCheckpointPromptTokens: parseIntFlag(flags['max-checkpoint-prompt-tokens'], undefined),
    force: flags.force === true,
  });
  if (flags.json) {
    console.log(JSON.stringify({
      status: prepared.status,
      due: prepared.due === true,
      threshold: prepared.checkpointInput?.threshold || null,
      coverage: prepared.checkpointInput?.coverage || null,
      prompt: prepared.prompt || null,
    }, null, 2));
    return;
  }
  if (prepared.status !== 'needs_agent_checkpoint') {
    const threshold = prepared.checkpointInput?.threshold;
    if (threshold) {
      console.log(`Checkpoint prompt unavailable: ${prepared.status} (${threshold.messageCount}/${threshold.everyMessages} messages)`);
    } else {
      console.log(`Checkpoint prompt unavailable: ${prepared.status}`);
    }
    return;
  }
  console.log([
    prepared.prompt,
    '',
    '[AQUIFER CHECKPOINT]',
    'Use the returned JSON as checkpoint process material for a later handoff or operator-reviewed checkpoint write.',
  ].join('\n'));
}

async function cmdCheckpointTick(aquifer, flags, opts) {
  const paths = codex.defaultPaths(opts);
  const filePath = flags['file-path'] || findNewestJsonlFile(opts.sessionsDir || paths.sessionsDir);
  if (!filePath) throw new Error('checkpoint-tick requires --file-path or a readable --sessions-dir');
  const view = codex.materializeRecoveryTranscriptView({
    filePath,
    sessionId: flags['session-id'] || undefined,
  }, {
    ...opts,
    tailOnMaxBudget: true,
    maxRecoveryBytes: parseIntFlag(flags['max-checkpoint-bytes'], opts.maxRecoveryBytes),
    maxRecoveryMessages: parseIntFlag(flags['max-checkpoint-messages'], opts.maxRecoveryMessages),
    maxRecoveryChars: parseIntFlag(flags['max-checkpoint-chars'], opts.maxRecoveryChars),
    maxRecoveryPromptTokens: parseIntFlag(flags['max-checkpoint-prompt-tokens'], opts.maxRecoveryPromptTokens),
  });
  if (!view || view.status !== 'ok') {
    const result = {
      status: view?.status || 'missing_view',
      due: false,
      filePath,
      reason: view?.reason || null,
      view,
    };
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`Checkpoint tick unavailable: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    return result;
  }

  const markerDir = checkpointMarkerDir(flags, opts);
  const marker = readCheckpointMarker(markerDir, view.sessionId);
  const threshold = checkpointDueFromMarker(view, marker, flags);
  if (!threshold.due) {
    const result = {
      status: 'not_ready',
      due: false,
      filePath,
      sessionId: view.sessionId,
      marker: marker ? {
        markerPath: marker.markerPath,
        messageCount: marker.messageCount || 0,
        userCount: marker.userCount || 0,
        writtenAt: marker.writtenAt || null,
      } : null,
      threshold,
    };
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Checkpoint tick not ready: ${threshold.deltaMessages}/${threshold.everyMessages} new messages`);
    }
    return result;
  }

  const prepared = await codex.prepareActiveSessionCheckpoint(aquifer, {
    ...opts,
    filePath,
    view,
    sessionId: flags['session-id'] || undefined,
    scopeKind: flags['scope-kind'] || undefined,
    scopeKey: flags['scope-key'] || flags['active-scope-key'] || undefined,
    activeScopeKey: flags['active-scope-key'] || flags['scope-key'] || undefined,
    activeScopePath: parseScopePath(flags['active-scope-path']),
    checkpointEveryMessages: parseIntFlag(flags['checkpoint-every-messages'], undefined),
    checkpointEveryUserMessages: parseIntFlag(flags['checkpoint-every-user-messages'], undefined),
    maxCheckpointBytes: parseIntFlag(flags['max-checkpoint-bytes'], undefined),
    maxCheckpointMessages: parseIntFlag(flags['max-checkpoint-messages'], undefined),
    maxCheckpointChars: parseIntFlag(flags['max-checkpoint-chars'], undefined),
    maxCheckpointPromptTokens: parseIntFlag(flags['max-checkpoint-prompt-tokens'], undefined),
    force: true,
    triggerKind: marker ? 'message_count_delta' : 'message_count',
  });
  const writtenMarker = prepared.status === 'needs_agent_checkpoint' && flags['dry-run'] !== true
    ? writeCheckpointMarker(markerDir, prepared)
    : null;
  const result = {
    status: prepared.status,
    due: prepared.due === true,
    filePath,
    sessionId: view.sessionId,
    marker: writtenMarker,
    previousMarker: marker ? {
      markerPath: marker.markerPath,
      messageCount: marker.messageCount || 0,
      userCount: marker.userCount || 0,
      writtenAt: marker.writtenAt || null,
    } : null,
    threshold,
    coverage: prepared.checkpointInput?.coverage || null,
    prompt: prepared.prompt || null,
  };
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (prepared.status !== 'needs_agent_checkpoint') {
    console.log(`Checkpoint tick unavailable: ${prepared.status}`);
    return result;
  }
  console.log([
    prepared.prompt,
    '',
    '[AQUIFER CHECKPOINT TICK]',
    writtenMarker
      ? `Marker written: ${writtenMarker.markerPath}`
      : 'Dry run: marker not written.',
    'Use the returned JSON as checkpoint process material for a later handoff or operator-reviewed checkpoint write.',
  ].join('\n'));
  return result;
}

function emitCheckpointHeartbeatResult(result, flags = {}) {
  if (flags.json) console.log(JSON.stringify(result, null, 2));
}

async function cmdCheckpointHeartbeat(aquifer, flags, opts, hookInputArg) {
  const hookInput = hookInputArg || (flags['hook-stdin'] === true ? readHookInputFromStdin() : {});
  const input = checkpointHeartbeatInput(flags, hookInput);
  const config = loadRuntimeConfig(flags, opts);
  const nowMs = Date.now();
  const intervalMs = checkpointCheckIntervalMs(flags, config);
  const schedulerDir = checkpointSchedulerDir(flags, opts);

  let safeSessionId;
  try {
    safeSessionId = codex.assertSafeSessionId(input.sessionId, 'sessionId');
  } catch {
    const result = { status: 'missing_or_invalid_session_id', due: false };
    emitCheckpointHeartbeatResult(result, flags);
    return result;
  }

  const marker = readSchedulerMarker(schedulerDir, safeSessionId);
  const proposalWindow = checkpointProposalWindow(marker, intervalMs, nowMs);
  const nextCheckAt = proposalWindow.nextProposalAt || null;
  if (flags.force !== true && !proposalWindow.due) {
    const result = {
      status: 'not_due_time',
      due: false,
      sessionId: safeSessionId,
      lastProposalAt: proposalWindow.lastProposalAt,
      nextCheckAt: proposalWindow.nextProposalAt,
      markerPath: marker.markerPath,
    };
    emitCheckpointHeartbeatResult(result, flags);
    return result;
  }

  const claim = acquireHeartbeatClaim(
    checkpointClaimDir(flags, opts),
    safeSessionId,
    nowMs,
    checkpointClaimTtlMs(flags, config),
  );
  if (!claim.acquired) {
    const result = {
      status: 'checkpoint_heartbeat_claimed',
      due: false,
      sessionId: safeSessionId,
      reason: claim.reason || 'claim_active',
    };
    emitCheckpointHeartbeatResult(result, flags);
    return result;
  }

  try {
    const pathCheck = validateCheckpointTranscriptPath(input.filePath, opts);
    if (!pathCheck.ok) {
      const written = writeSchedulerMarker(schedulerDir, safeSessionId, {
        lastCheckAt: isoAt(nowMs),
        nextCheckAt,
        lastStatus: pathCheck.status,
        lastReason: pathCheck.reason || null,
        hookEventName: input.hookEventName || null,
      });
      const result = {
        status: pathCheck.status,
        due: false,
        sessionId: safeSessionId,
        reason: pathCheck.reason || null,
        nextCheckAt,
        markerPath: written?.markerPath || null,
      };
      emitCheckpointHeartbeatResult(result, flags);
      return result;
    }

    const view = codex.materializeRecoveryTranscriptView({
      filePath: pathCheck.filePath,
      sessionId: safeSessionId,
    }, {
      ...opts,
      tailOnMaxBudget: true,
      maxRecoveryBytes: parseIntFlag(flags['max-checkpoint-bytes'], opts.maxRecoveryBytes),
      maxRecoveryMessages: parseIntFlag(flags['max-checkpoint-messages'], opts.maxRecoveryMessages),
      maxRecoveryChars: parseIntFlag(flags['max-checkpoint-chars'], opts.maxRecoveryChars),
      maxRecoveryPromptTokens: parseIntFlag(flags['max-checkpoint-prompt-tokens'], opts.maxRecoveryPromptTokens),
    });
    if (!view || view.status !== 'ok') {
      const written = writeSchedulerMarker(schedulerDir, safeSessionId, {
        lastCheckAt: isoAt(nowMs),
        nextCheckAt,
        lastStatus: view?.status || 'missing_view',
        lastReason: view?.reason || null,
        hookEventName: input.hookEventName || null,
      });
      const result = {
        status: view?.status || 'missing_view',
        due: false,
        sessionId: safeSessionId,
        reason: view?.reason || null,
        nextCheckAt,
        markerPath: written?.markerPath || null,
      };
      emitCheckpointHeartbeatResult(result, flags);
      return result;
    }

    const coveredMessages = Number(marker?.lastCoveredMessageCount || 0);
    const coveredUsers = Number(marker?.lastCoveredUserCount || 0);
    const threshold = checkpointDueFromMarker(view, coveredMessages > 0 || coveredUsers > 0
      ? { messageCount: coveredMessages, userCount: coveredUsers }
      : null, flags, config);
    if (!threshold.due) {
      const written = writeSchedulerMarker(schedulerDir, safeSessionId, {
        lastCheckAt: isoAt(nowMs),
        nextCheckAt,
        lastStatus: 'not_enough_messages',
        lastReason: null,
        hookEventName: input.hookEventName || null,
        lastObservedMessageCount: threshold.messageCount,
        lastObservedUserCount: threshold.userCount,
      });
      const result = {
        status: 'not_enough_messages',
        due: false,
        sessionId: safeSessionId,
        nextCheckAt,
        markerPath: written?.markerPath || null,
        threshold,
      };
      emitCheckpointHeartbeatResult(result, flags);
      return result;
    }

    const prepared = await codex.prepareActiveSessionCheckpoint(aquifer, {
      ...opts,
      filePath: pathCheck.filePath,
      view,
      sessionId: safeSessionId,
      scopeKind: flags['scope-kind'] || undefined,
      scopeKey: flags['scope-key'] || flags['active-scope-key'] || undefined,
      activeScopeKey: flags['active-scope-key'] || flags['scope-key'] || undefined,
      activeScopePath: parseScopePath(flags['active-scope-path']),
      checkpointEveryMessages: checkpointEveryMessages(flags, config),
      checkpointEveryUserMessages: checkpointEveryUserMessages(flags, config),
      force: true,
      includeCurrentMemory: false,
      triggerKind: 'heartbeat_time_window',
    });
    if (prepared.status !== 'needs_agent_checkpoint') {
      const written = writeSchedulerMarker(schedulerDir, safeSessionId, {
        lastCheckAt: isoAt(nowMs),
        nextCheckAt,
        lastStatus: prepared.status,
        hookEventName: input.hookEventName || null,
      });
      const result = {
        status: prepared.status,
        due: false,
        sessionId: safeSessionId,
        nextCheckAt,
        markerPath: written?.markerPath || null,
      };
      emitCheckpointHeartbeatResult(result, flags);
      return result;
    }

    const spool = flags['dry-run'] === true
      ? null
      : spoolCheckpointProposal(checkpointSpoolDir(flags, opts), prepared, {
        sessionId: safeSessionId,
        source: opts.source || 'codex',
        hookEventName: input.hookEventName || null,
      });
    const proposalAt = isoAt(nowMs);
    const nextProposalAt = isoAt(nowMs + intervalMs);
    const markerPatch = {
      lastCheckAt: proposalAt,
      lastProposalAt: flags['dry-run'] === true ? marker?.lastProposalAt || null : proposalAt,
      nextCheckAt: flags['dry-run'] === true ? nextCheckAt : nextProposalAt,
      lastStatus: flags['dry-run'] === true ? 'checkpoint_due_dry_run' : 'checkpoint_spooled',
      lastReason: null,
      hookEventName: input.hookEventName || null,
      lastSpoolPath: spool?.filePath || marker?.lastSpoolPath || null,
    };
    if (flags['dry-run'] !== true) {
      markerPatch.lastCoveredMessageCount = threshold.messageCount;
      markerPatch.lastCoveredUserCount = threshold.userCount;
    }
    const written = writeSchedulerMarker(schedulerDir, safeSessionId, markerPatch);
    const result = {
      status: flags['dry-run'] === true ? 'checkpoint_due_dry_run' : 'checkpoint_spooled',
      due: true,
      sessionId: safeSessionId,
      nextCheckAt: flags['dry-run'] === true ? nextCheckAt : nextProposalAt,
      markerPath: written?.markerPath || null,
      spool,
      threshold,
      coverage: prepared.checkpointInput?.coverage || null,
    };
    emitCheckpointHeartbeatResult(result, flags);
    return result;
  } finally {
    releaseHeartbeatClaim(claim);
  }
}

async function cmdCheckpointHeartbeatHook(flags, opts) {
  if (!flags['scope-key'] && !flags['active-scope-key']) {
    throw new Error('checkpoint-heartbeat-hook requires --scope-key or --active-scope-key');
  }
  const hooksPath = flags['hooks-path'] || defaultHooksPath(opts);
  const before = readHooksConfig(hooksPath);
  const after = mergeCheckpointHeartbeatHook(before, flags, opts);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  const apply = flags.apply === true;
  if (apply) {
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify(after, null, 2) + '\n', 'utf8');
  }
  const result = {
    status: apply ? 'applied' : 'dry_run',
    hooksPath,
    changed,
    event: 'UserPromptSubmit',
    command: checkpointHeartbeatCommand(flags, opts),
    hooks: after,
  };
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  console.log([
    `Codex heartbeat hook ${apply ? 'applied' : 'dry run'}: ${hooksPath}`,
    `Changed: ${changed ? 'yes' : 'no'}`,
    'Command:',
    result.command,
    apply ? '' : 'Pass --apply to write the merged hooks.json.',
  ].filter(Boolean).join('\n'));
  return result;
}

module.exports = {
  cmdCheckpointHeartbeat,
  cmdCheckpointHeartbeatHook,
  cmdCheckpointPrompt,
  cmdCheckpointTick,
  emitCheckpointHeartbeatResult,
  parseScopePath,
  readHookInputFromStdin,
};
