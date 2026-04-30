'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const recovery = require('../scripts/codex-recovery');
const CLI_PATH = path.join(__dirname, '..', 'consumers', 'cli.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aquifer-codex-recovery-'));
}

function captureConsoleLog(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .then(() => lines.join('\n'))
    .finally(() => {
      console.log = original;
    });
}

describe('scripts/codex-recovery', () => {
  it('parses command flags used by the Codex hook flow', () => {
    const args = recovery.parseArgs([
      'finalize',
      '--session-id', 'abc',
      '--summary-stdin',
      '--source', 'codex-wrapper',
      '--sessions-dir', '/tmp/sessions',
    ]);

    assert.deepEqual(args._, ['finalize']);
    assert.equal(args.flags['session-id'], 'abc');
    assert.equal(args.flags['summary-stdin'], true);
    assert.equal(args.flags.source, 'codex-wrapper');
    assert.equal(args.flags['sessions-dir'], '/tmp/sessions');
  });

  it('parses active checkpoint prompt flags', () => {
    const args = recovery.parseArgs([
      'checkpoint-prompt',
      '--file-path', '/tmp/current.jsonl',
      '--scope-key', 'project:aquifer',
      '--checkpoint-every-messages', '20',
      '--checkpoint-every-user-messages', '10',
    ]);

    assert.deepEqual(args._, ['checkpoint-prompt']);
    assert.equal(args.flags['file-path'], '/tmp/current.jsonl');
    assert.equal(args.flags['scope-key'], 'project:aquifer');
    assert.equal(args.flags['checkpoint-every-messages'], '20');
    assert.equal(args.flags['checkpoint-every-user-messages'], '10');
  });

  it('parses active checkpoint tick flags', () => {
    const args = recovery.parseArgs([
      'checkpoint-tick',
      '--scope-key', 'project:aquifer',
      '--sessions-dir', '/tmp/sessions',
      '--checkpoint-marker-dir', '/tmp/markers',
      '--checkpoint-every-messages', '20',
      '--json',
    ]);

    assert.deepEqual(args._, ['checkpoint-tick']);
    assert.equal(args.flags['scope-key'], 'project:aquifer');
    assert.equal(args.flags['sessions-dir'], '/tmp/sessions');
    assert.equal(args.flags['checkpoint-marker-dir'], '/tmp/markers');
    assert.equal(args.flags['checkpoint-every-messages'], '20');
    assert.equal(args.flags.json, true);
  });

  it('parses active checkpoint heartbeat flags', () => {
    const args = recovery.parseArgs([
      'checkpoint-heartbeat',
      '--hook-stdin',
      '--scope-key', 'project:aquifer',
      '--checkpoint-check-interval-minutes', '10',
      '--checkpoint-scheduler-dir', '/tmp/scheduler',
      '--checkpoint-claim-dir', '/tmp/claims',
      '--checkpoint-every-messages', '20',
      '--checkpoint-quiet-ms', '3000',
      '--checkpoint-spool-dir', '/tmp/spool',
    ]);

    assert.deepEqual(args._, ['checkpoint-heartbeat']);
    assert.equal(args.flags['hook-stdin'], true);
    assert.equal(args.flags['scope-key'], 'project:aquifer');
    assert.equal(args.flags['checkpoint-check-interval-minutes'], '10');
    assert.equal(args.flags['checkpoint-scheduler-dir'], '/tmp/scheduler');
    assert.equal(args.flags['checkpoint-claim-dir'], '/tmp/claims');
    assert.equal(args.flags['checkpoint-every-messages'], '20');
    assert.equal(args.flags['checkpoint-quiet-ms'], '3000');
    assert.equal(args.flags['checkpoint-spool-dir'], '/tmp/spool');
  });

  it('parses active checkpoint heartbeat hook install flags', () => {
    const args = recovery.parseArgs([
      'checkpoint-heartbeat-hook',
      '--scope-key', 'project:aquifer',
      '--hooks-path', '/tmp/hooks.json',
      '--apply',
      '--json',
    ]);

    assert.deepEqual(args._, ['checkpoint-heartbeat-hook']);
    assert.equal(args.flags['scope-key'], 'project:aquifer');
    assert.equal(args.flags['hooks-path'], '/tmp/hooks.json');
    assert.equal(args.flags.apply, true);
    assert.equal(args.flags.json, true);
  });

  it('resolves checkpoint heartbeat policy from config with flags taking precedence', () => {
    const config = {
      codex: {
        checkpoint: {
          checkIntervalMinutes: 15,
          everyMessages: 30,
          everyUserMessages: 12,
          quietMs: 5000,
          claimTtlMs: 90000,
        },
      },
    };

    assert.equal(recovery.checkpointCheckIntervalMs({}, config), 15 * 60 * 1000);
    assert.equal(recovery.checkpointEveryMessages({}, config), 30);
    assert.equal(recovery.checkpointEveryUserMessages({}, config), 12);
    assert.equal(recovery.checkpointQuietMs({}, config), 5000);
    assert.equal(recovery.checkpointClaimTtlMs({}, config), 90000);

    assert.equal(recovery.checkpointCheckIntervalMs({
      'checkpoint-check-interval-minutes': '5',
    }, config), 5 * 60 * 1000);
    assert.equal(recovery.checkpointEveryMessages({
      'checkpoint-every-messages': '7',
    }, config), 7);
    assert.equal(recovery.checkpointQuietMs({
      'checkpoint-quiet-ms': '250',
    }, config), 250);
  });

  it('builds options from Codex wrapper env without requiring an LLM config', () => {
    const opts = recovery.buildRecoveryOptions({}, {
      CODEX_AQUIFER_AGENT_ID: 'main',
      CODEX_AQUIFER_SOURCE: 'codex-wrapper',
      CODEX_AQUIFER_SESSION_KEY: 'codex:wrapper:run',
      CODEX_HOME: '/tmp/codex-home',
    });

    assert.equal(opts.agentId, 'main');
    assert.equal(opts.source, 'codex-wrapper');
    assert.equal(opts.sessionKey, 'codex:wrapper:run');
    assert.equal(opts.codexHome, '/tmp/codex-home');
    assert.equal(opts.excludeNewest, true);
  });

  it('renders metadata-only recovery context with consent commands', () => {
    const context = recovery.renderHookContext([{
      sessionId: 'session-1',
      fileSessionId: 'rollout-1',
      userCount: 4,
      messageCount: 9,
      updatedAt: '2026-04-26T10:00:00.000Z',
    }], {
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    });

    assert.match(context, /\[AQUIFER RECOVERY\]/);
    assert.match(context, /eligible for DB recovery/);
    assert.match(context, /did not inject transcript text/);
    assert.match(context, /codex-recovery\.js' 'prompt'/);
    assert.match(context, /codex-recovery\.js' 'finalize'/);
    assert.match(context, /--summary-stdin/);
    assert.match(context, /--all'.*'--verdict' 'deferred'/s);
    assert.match(context, /--verdict' 'declined'/);
  });

  it('keeps JSONL preview recovery commands on the consent-gated preview path', () => {
    const context = recovery.renderHookContext([{
      origin: 'jsonl_preview',
      sessionId: 'rollout-preview',
      fileSessionId: 'rollout-preview',
      updatedAt: '2026-04-26T10:00:00.000Z',
    }], {
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    });

    assert.match(context, /\[AQUIFER RECOVERY\]/);
    assert.match(context, /'prompt' '--session-id' 'rollout-preview'.*'--include-jsonl-previews'/s);
    assert.match(context, /'finalize' '--session-id' 'rollout-preview'.*'--include-jsonl-previews'.*'--summary-stdin'/s);
    assert.match(context, /'decision'.*'--include-jsonl-previews'.*'--all'.*'--verdict' 'declined'/s);
  });

  it('renders a selectable SessionStart recovery list for all eligible candidates', () => {
    const context = recovery.renderHookContext([
      { sessionId: 'session-1', origin: 'imported_marker' },
      { sessionId: 'session-2', origin: 'jsonl_preview' },
      { sessionId: 'session-3', origin: 'jsonl_preview' },
    ], {
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    });

    assert.match(context, /found 3 Codex JSONL session\(s\) eligible for DB recovery/);
    assert.match(context, /session-1/);
    assert.match(context, /session-2/);
    assert.match(context, /session-3/);
    assert.match(context, /SELECTED_IDS_COMMA_SEPARATED/);
    assert.match(context, /Manual later: rerun preview or prompt with --include-deferred/);
  });

  it('prompt output includes the exact finalize command for the selected candidate', async () => {
    const root = tmpDir();
    const sessionsDir = path.join(root, 'sessions');
    const stateDir = path.join(root, 'state');
    const file = path.join(sessionsDir, 'rollout-prompt.jsonl');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(file, [
      '{"type":"session_meta","payload":{"id":"meta-prompt"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u1"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a1"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u2"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a2"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u3"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a3"}]}}',
    ].join('\n') + '\n', 'utf8');

    const output = await captureConsoleLog(() => recovery.cmdPrompt({}, {
      'session-id': 'meta-prompt',
    }, {
      sessionsDir,
      stateDir,
      includeJsonlPreviews: true,
      minSessionBytes: 1,
      idleMs: 0,
      excludeNewest: false,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    }));

    assert.match(output, /<sanitized_transcript>/);
    assert.match(output, /\[AQUIFER FINALIZE\]/);
    assert.match(output, /codex-recovery\.js' 'finalize' '--session-id' 'meta-prompt'/);
    assert.match(output, /'--include-jsonl-previews'/);
    assert.match(output, /'--summary-stdin'/);
    assert.match(output, /'--mode' 'session_start_recovery'/);
  });

  it('checkpoint-prompt emits process-material prompt for an active transcript', async () => {
    const root = tmpDir();
    const file = path.join(root, 'active-checkpoint.jsonl');
    fs.writeFileSync(file, [
      '{"type":"session_meta","payload":{"id":"meta-active-checkpoint-script"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"[AQUIFER CONTEXT] should be filtered"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u1 checkpoint content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a1 checkpoint content"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u2 checkpoint content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a2 checkpoint content"}]}}',
    ].join('\n') + '\n', 'utf8');

    const output = await captureConsoleLog(() => recovery.cmdCheckpointPrompt({}, {
      'file-path': file,
      'scope-key': 'project:aquifer',
      'checkpoint-every-messages': '4',
    }, {
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    }));

    assert.match(output, /active-session checkpoint proposal/);
    assert.match(output, /process material/);
    assert.match(output, /u1 checkpoint content/);
    assert.match(output, /\[AQUIFER CHECKPOINT\]/);
    assert.doesNotMatch(output, /AQUIFER CONTEXT/);
    assert.doesNotMatch(output, /transcriptHash/);
  });

  it('checkpoint-tick emits a prompt once and marker-suppresses repeated ticks', async () => {
    const root = tmpDir();
    const stateDir = path.join(root, 'state');
    const file = path.join(root, 'active-checkpoint-tick.jsonl');
    fs.writeFileSync(file, [
      '{"type":"session_meta","payload":{"id":"meta-active-checkpoint-tick"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u1 tick content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a1 tick content"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u2 tick content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a2 tick content"}]}}',
    ].join('\n') + '\n', 'utf8');

    const firstOutput = await captureConsoleLog(() => recovery.cmdCheckpointTick({}, {
      'file-path': file,
      'scope-key': 'project:aquifer',
      'checkpoint-every-messages': '4',
      json: true,
    }, {
      stateDir,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    }));
    const first = JSON.parse(firstOutput);

    assert.equal(first.status, 'needs_agent_checkpoint');
    assert.equal(first.due, true);
    assert.match(first.prompt, /active-session checkpoint proposal/);
    assert.match(first.prompt, /u1 tick content/);
    assert.equal(first.marker.messageCount, 4);
    assert.equal(fs.existsSync(first.marker.markerPath), true);

    const secondOutput = await captureConsoleLog(() => recovery.cmdCheckpointTick({}, {
      'file-path': file,
      'scope-key': 'project:aquifer',
      'checkpoint-every-messages': '4',
      json: true,
    }, {
      stateDir,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    }));
    const second = JSON.parse(secondOutput);

    assert.equal(second.status, 'not_ready');
    assert.equal(second.due, false);
    assert.equal(second.threshold.deltaMessages, 0);
    assert.equal(second.prompt, undefined);
  });

  it('checkpoint-heartbeat time-gates from the last successful proposal before reading transcript path', async () => {
    const root = tmpDir();
    const stateDir = path.join(root, 'state');
    const sessionsDir = path.join(root, 'sessions');
    const sessionId = 'heartbeat-time-gate';
    const lastProposalAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    recovery.writeSchedulerMarker(recovery.checkpointSchedulerDir({}, { stateDir }), sessionId, {
      lastProposalAt,
    });

    const result = await recovery.cmdCheckpointHeartbeat({}, {
      'scope-key': 'project:aquifer',
      'checkpoint-check-interval-minutes': '10',
    }, {
      stateDir,
      sessionsDir,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    }, {
      session_id: sessionId,
      hook_event_name: 'UserPromptSubmit',
      transcript_path: path.join(root, 'outside.jsonl'),
      prompt: 'RAW_PROMPT_SECRET_SHOULD_NOT_BE_USED',
    });

    assert.equal(result.status, 'not_due_time');
    assert.equal(result.due, false);
    assert.equal(result.lastProposalAt, lastProposalAt);
    assert.ok(Date.parse(result.nextCheckAt) >= Date.now() + 4 * 60 * 1000);
  });

  it('checkpoint-heartbeat does not use transcript mtime as the first-layer gate', async () => {
    const root = tmpDir();
    const stateDir = path.join(root, 'state');
    const sessionsDir = path.join(root, 'sessions');
    const spoolDir = path.join(root, 'spool');
    const file = path.join(sessionsDir, 'heartbeat-recent-mtime.jsonl');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(file, [
      '{"type":"session_meta","payload":{"id":"heartbeat-recent-mtime"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u1 heartbeat content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a1 heartbeat content"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u2 heartbeat content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a2 heartbeat content"}]}}',
    ].join('\n') + '\n', 'utf8');

    const result = await recovery.cmdCheckpointHeartbeat({}, {
      'scope-key': 'project:aquifer',
      'checkpoint-check-interval-minutes': '10',
      'checkpoint-every-messages': '4',
      'checkpoint-spool-dir': spoolDir,
    }, {
      stateDir,
      sessionsDir,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    }, {
      session_id: 'heartbeat-recent-mtime',
      hook_event_name: 'UserPromptSubmit',
      transcript_path: file,
      prompt: 'RAW_PROMPT_SECRET_SHOULD_NOT_BE_USED',
    });

    assert.equal(result.status, 'checkpoint_spooled');
    assert.equal(result.due, true);
    assert.notEqual(result.status, 'transcript_not_quiet');
  });

  it('checkpoint-heartbeat spools an oversize transcript from a bounded tail view', async () => {
    const root = tmpDir();
    const stateDir = path.join(root, 'state');
    const sessionsDir = path.join(root, 'sessions');
    const spoolDir = path.join(root, 'spool');
    const file = path.join(sessionsDir, 'heartbeat-oversize-tail.jsonl');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(file, [
      '{"type":"session_meta","payload":{"id":"heartbeat-oversize-tail"}}',
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-test', padding: 'x'.repeat(4000) } }),
      '{"type":"event_msg","payload":{"type":"user_message","message":"u1 early content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a1 early content"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u2 early content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a2 early content"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u3 middle content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a3 middle content"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u4 tail content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a4 tail content"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u5 tail content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a5 tail content"}]}}',
    ].join('\n') + '\n', 'utf8');

    const result = await recovery.cmdCheckpointHeartbeat({}, {
      'scope-key': 'project:aquifer',
      'checkpoint-check-interval-ms': '0',
      'checkpoint-every-messages': '10',
      'max-checkpoint-bytes': '10',
      'max-checkpoint-messages': '4',
      'checkpoint-spool-dir': spoolDir,
    }, {
      stateDir,
      sessionsDir,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    }, {
      session_id: 'heartbeat-oversize-tail',
      hook_event_name: 'UserPromptSubmit',
      transcript_path: file,
      prompt: 'RAW_PROMPT_SECRET_SHOULD_NOT_BE_USED',
    });

    assert.equal(result.status, 'checkpoint_spooled');
    assert.equal(result.threshold.messageCount, 10);
    assert.equal(result.threshold.deltaMessages, 10);
    assert.equal(result.coverage.coveredUntilMessageIndex, 9);
    assert.ok(result.spool.filePath.startsWith(spoolDir));
    const payload = JSON.parse(fs.readFileSync(result.spool.filePath, 'utf8'));
    assert.match(payload.prompt, /u5 tail content/);
    assert.doesNotMatch(payload.prompt, /u1 early content/);
  });

  it('checkpoint-heartbeat skips transcript work while another heartbeat owns the claim', async () => {
    const root = tmpDir();
    const stateDir = path.join(root, 'state');
    const sessionsDir = path.join(root, 'sessions');
    const sessionId = 'heartbeat-claimed';
    const claim = recovery.acquireHeartbeatClaim(
      recovery.checkpointClaimDir({}, { stateDir }),
      sessionId,
      Date.now(),
      60000,
    );
    assert.equal(claim.acquired, true);

    try {
      const result = await recovery.cmdCheckpointHeartbeat({}, {
        'scope-key': 'project:aquifer',
        'checkpoint-check-interval-ms': '0',
      }, {
        stateDir,
        sessionsDir,
        agentId: 'main',
        source: 'codex',
        sessionKey: 'codex:cli',
      }, {
        session_id: sessionId,
        hook_event_name: 'UserPromptSubmit',
        transcript_path: path.join(root, 'outside.jsonl'),
        prompt: 'RAW_PROMPT_SECRET_SHOULD_NOT_BE_USED',
      });

      assert.equal(result.status, 'checkpoint_heartbeat_claimed');
      assert.equal(result.due, false);
      assert.equal(result.reason, 'claim_active');
      assert.equal(
        recovery.readSchedulerMarker(recovery.checkpointSchedulerDir({}, { stateDir }), sessionId),
        null,
      );
    } finally {
      recovery.releaseHeartbeatClaim(claim);
    }
  });

  it('checkpoint-heartbeat rejects eligible transcript paths outside the Codex sessions dir', async () => {
    const root = tmpDir();
    const stateDir = path.join(root, 'state');
    const sessionsDir = path.join(root, 'sessions');
    const outside = path.join(root, 'outside.jsonl');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(outside, '{"type":"session_meta","payload":{"id":"heartbeat-outside"}}\n', 'utf8');

    const result = await recovery.cmdCheckpointHeartbeat({}, {
      'scope-key': 'project:aquifer',
      'checkpoint-check-interval-ms': '0',
    }, {
      stateDir,
      sessionsDir,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    }, {
      session_id: 'heartbeat-outside',
      hook_event_name: 'UserPromptSubmit',
      transcript_path: outside,
      prompt: 'RAW_PROMPT_SECRET_SHOULD_NOT_BE_USED',
    });

    assert.equal(result.status, 'invalid_transcript_path');
    assert.equal(result.reason, 'outside_sessions_dir');
    assert.equal(result.due, false);
  });

  it('checkpoint-heartbeat resets the next check window when message delta is insufficient', async () => {
    const root = tmpDir();
    const stateDir = path.join(root, 'state');
    const sessionsDir = path.join(root, 'sessions');
    const file = path.join(sessionsDir, 'heartbeat-short.jsonl');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(file, [
      '{"type":"session_meta","payload":{"id":"heartbeat-short"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u1 short"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a1 short"}]}}',
    ].join('\n') + '\n', 'utf8');

    const result = await recovery.cmdCheckpointHeartbeat({}, {
      'scope-key': 'project:aquifer',
      'checkpoint-check-interval-ms': '600000',
      'checkpoint-quiet-ms': '0',
      'checkpoint-every-messages': '20',
    }, {
      stateDir,
      sessionsDir,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    }, {
      session_id: 'heartbeat-short',
      hook_event_name: 'UserPromptSubmit',
      transcript_path: file,
      prompt: 'RAW_PROMPT_SECRET_SHOULD_NOT_BE_USED',
    });

    assert.equal(result.status, 'not_enough_messages');
    assert.equal(result.due, false);
    assert.equal(result.threshold.due, false);
    assert.equal(result.threshold.deltaMessages, 2);
    assert.equal(result.nextCheckAt, null);

    const marker = recovery.readSchedulerMarker(recovery.checkpointSchedulerDir({}, { stateDir }), 'heartbeat-short');
    assert.equal(marker.lastStatus, 'not_enough_messages');
    assert.equal(marker.lastReason, null);
    assert.equal(marker.lastProposalAt || null, null);
    assert.equal(marker.lastCoveredMessageCount || 0, 0);
  });

  it('checkpoint-heartbeat writes a local spool proposal without echoing prompt text', async () => {
    const root = tmpDir();
    const stateDir = path.join(root, 'state');
    const sessionsDir = path.join(root, 'sessions');
    const spoolDir = path.join(root, 'spool');
    const file = path.join(sessionsDir, 'heartbeat-due.jsonl');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(file, [
      '{"type":"session_meta","payload":{"id":"heartbeat-due"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u1 heartbeat content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a1 heartbeat content"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u2 heartbeat content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a2 heartbeat content"}]}}',
    ].join('\n') + '\n', 'utf8');

    const result = await recovery.cmdCheckpointHeartbeat({}, {
      'scope-key': 'project:aquifer',
      'checkpoint-check-interval-ms': '0',
      'checkpoint-quiet-ms': '0',
      'checkpoint-every-messages': '4',
      'checkpoint-spool-dir': spoolDir,
    }, {
      stateDir,
      sessionsDir,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    }, {
      session_id: 'heartbeat-due',
      hook_event_name: 'UserPromptSubmit',
      transcript_path: file,
      prompt: 'RAW_PROMPT_SECRET_SHOULD_NOT_BE_USED',
    });

    assert.equal(result.status, 'checkpoint_spooled');
    assert.equal(result.due, true);
    assert.equal(result.threshold.deltaMessages, 4);
    assert.ok(result.spool.filePath.startsWith(spoolDir));
    assert.doesNotMatch(JSON.stringify(result), /active-session checkpoint proposal/);
    assert.doesNotMatch(JSON.stringify(result), /RAW_PROMPT_SECRET_SHOULD_NOT_BE_USED/);

    const payload = JSON.parse(fs.readFileSync(result.spool.filePath, 'utf8'));
    assert.equal(payload.kind, 'codex_active_checkpoint_pending_v1');
    assert.match(payload.prompt, /active-session checkpoint proposal/);
    assert.match(payload.prompt, /u1 heartbeat content/);
    assert.doesNotMatch(payload.prompt, /RAW_PROMPT_SECRET_SHOULD_NOT_BE_USED/);

    const marker = recovery.readSchedulerMarker(recovery.checkpointSchedulerDir({}, { stateDir }), 'heartbeat-due');
    assert.equal(marker.lastStatus, 'checkpoint_spooled');
    assert.equal(marker.lastReason, null);
    assert.equal(marker.lastCoveredMessageCount, 4);
    assert.equal(marker.lastSpoolPath, result.spool.filePath);
  });

  it('checkpoint-heartbeat dry-run does not advance proposal coverage', async () => {
    const root = tmpDir();
    const stateDir = path.join(root, 'state');
    const sessionsDir = path.join(root, 'sessions');
    const spoolDir = path.join(root, 'spool');
    const file = path.join(sessionsDir, 'heartbeat-dry-run.jsonl');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(file, [
      '{"type":"session_meta","payload":{"id":"heartbeat-dry-run"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u1 heartbeat content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a1 heartbeat content"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u2 heartbeat content"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a2 heartbeat content"}]}}',
    ].join('\n') + '\n', 'utf8');

    const result = await recovery.cmdCheckpointHeartbeat({}, {
      'scope-key': 'project:aquifer',
      'checkpoint-check-interval-ms': '0',
      'checkpoint-every-messages': '4',
      'checkpoint-spool-dir': spoolDir,
      'dry-run': true,
    }, {
      stateDir,
      sessionsDir,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    }, {
      session_id: 'heartbeat-dry-run',
      hook_event_name: 'UserPromptSubmit',
      transcript_path: file,
      prompt: 'RAW_PROMPT_SECRET_SHOULD_NOT_BE_USED',
    });

    assert.equal(result.status, 'checkpoint_due_dry_run');
    assert.equal(result.due, true);
    assert.equal(result.spool, null);
    const marker = recovery.readSchedulerMarker(recovery.checkpointSchedulerDir({}, { stateDir }), 'heartbeat-dry-run');
    assert.equal(marker.lastStatus, 'checkpoint_due_dry_run');
    assert.equal(marker.lastCoveredMessageCount || 0, 0);
    assert.equal(marker.lastCoveredUserCount || 0, 0);
    assert.equal(marker.lastProposalAt || null, null);
  });

  it('checkpoint-heartbeat-hook renders a dry-run UserPromptSubmit hook without writing hooks.json', async () => {
    const root = tmpDir();
    const hooksPath = path.join(root, 'hooks.json');

    let result;
    await captureConsoleLog(async () => {
      result = await recovery.cmdCheckpointHeartbeatHook({
        'scope-key': 'project:aquifer',
        'hooks-path': hooksPath,
        'checkpoint-check-interval-minutes': '10',
        'checkpoint-every-messages': '20',
      }, {
        agentId: 'main',
        source: 'codex',
        sessionKey: 'codex:cli',
      });
    });

    assert.equal(result.status, 'dry_run');
    assert.equal(result.event, 'UserPromptSubmit');
    assert.match(result.command, /checkpoint-heartbeat/);
    assert.match(result.command, /--hook-stdin/);
    assert.match(result.command, /--scope-key/);
    assert.equal(fs.existsSync(hooksPath), false);
    assert.equal(result.hooks.hooks.UserPromptSubmit.length, 1);
  });

  it('checkpoint-heartbeat-hook leaves policy defaults to config unless explicitly passed', async () => {
    const root = tmpDir();
    const hooksPath = path.join(root, 'hooks.json');
    const configPath = path.join(root, 'aquifer.config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      codex: { checkpoint: { checkIntervalMinutes: 15, everyMessages: 30 } },
    }), 'utf8');

    let result;
    await captureConsoleLog(async () => {
      result = await recovery.cmdCheckpointHeartbeatHook({
        'scope-key': 'project:aquifer',
        'hooks-path': hooksPath,
        config: configPath,
      }, {
        agentId: 'main',
        source: 'codex',
      });
    });

    assert.match(result.command, /--config/);
    assert.doesNotMatch(result.command, /checkpoint-check-interval-minutes/);
    assert.doesNotMatch(result.command, /checkpoint-every-messages/);
    assert.doesNotMatch(result.command, /checkpoint-quiet-ms/);
  });

  it('checkpoint-heartbeat-hook applies idempotently and preserves existing hook groups', async () => {
    const root = tmpDir();
    const hooksPath = path.join(root, 'hooks.json');
    fs.writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'node session-start.js' }] }],
      },
    }), 'utf8');

    let first;
    let second;
    await captureConsoleLog(async () => {
      first = await recovery.cmdCheckpointHeartbeatHook({
        'scope-key': 'project:aquifer',
        'hooks-path': hooksPath,
        apply: true,
      }, {
        agentId: 'main',
        source: 'codex',
        sessionKey: 'codex:cli',
      });
      second = await recovery.cmdCheckpointHeartbeatHook({
        'scope-key': 'project:aquifer',
        'hooks-path': hooksPath,
        apply: true,
      }, {
        agentId: 'main',
        source: 'codex',
        sessionKey: 'codex:cli',
      });
    });

    assert.equal(first.status, 'applied');
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(hooks.hooks.SessionStart[0].matcher, 'startup|resume');
    assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command, /checkpoint-heartbeat/);

    const inspect = recovery.inspectCheckpointHeartbeatHook({ hooksPath });
    assert.equal(inspect.status, 'ok');
    assert.equal(inspect.installed, true);
  });

  it('decision --all with an exception defers only unselected recovery candidates', async () => {
    const root = tmpDir();
    const sessionsDir = path.join(root, 'sessions');
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(sessionsDir, { recursive: true });
    for (const id of ['one', 'two']) {
      fs.writeFileSync(path.join(sessionsDir, `rollout-${id}.jsonl`), [
        `{"type":"session_meta","payload":{"id":"meta-${id}"}}`,
        '{"type":"event_msg","payload":{"type":"user_message","message":"u1"}}',
        '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a1"}]}}',
        '{"type":"event_msg","payload":{"type":"user_message","message":"u2"}}',
        '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a2"}]}}',
        '{"type":"event_msg","payload":{"type":"user_message","message":"u3"}}',
        '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a3"}]}}',
      ].join('\n') + '\n', 'utf8');
    }

    const output = await captureConsoleLog(() => recovery.cmdDecision({}, {
      all: true,
      'except-session-id': 'meta-one',
      verdict: 'deferred',
    }, {
      sessionsDir,
      stateDir,
      includeJsonlPreviews: true,
      minSessionBytes: 1,
      idleMs: 0,
      excludeNewest: false,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
      maxRecoveryCandidates: 5,
    }));

    assert.equal(output, 'Recovery deferred: 1 candidate(s)');

    const hookOutput = await captureConsoleLog(() => recovery.cmdHookContext({}, {}, {
      sessionsDir,
      stateDir,
      minSessionBytes: 1,
      excludeNewest: false,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
      maxRecoveryCandidates: 5,
    }));

    assert.match(hookOutput, /meta-one/);
    assert.doesNotMatch(hookOutput, /meta-two/);
  });

  it('finalize output includes committed human review text when available', async () => {
    const root = tmpDir();
    const sessionsDir = path.join(root, 'sessions');
    const stateDir = path.join(root, 'state');
    const file = path.join(sessionsDir, 'rollout-review.jsonl');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(file, [
      '{"type":"session_meta","payload":{"id":"meta-review"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u1"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a1"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u2"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a2"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u3"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a3"}]}}',
    ].join('\n') + '\n', 'utf8');
    const old = new Date(Date.now() - 3000);
    fs.utimesSync(file, old, old);

    const aq = {
      async getSession() { return null; },
      async commit() {},
      finalization: {
        async finalizeSession() {
          return {
            status: 'finalized',
            humanReviewText: '已整理進 DB：Codex recovery review surface',
            memoryResult: { promoted: 1 },
          };
        },
      },
    };
    aq.finalizeSession = aq.finalization.finalizeSession;

    const output = await captureConsoleLog(() => recovery.cmdFinalize(aq, {
      'session-id': 'meta-review',
      'summary-text': 'Codex recovery review surface',
    }, {
      sessionsDir,
      stateDir,
      includeJsonlPreviews: true,
      minSessionBytes: 1,
      idleMs: 0,
      excludeNewest: false,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    }));

    assert.match(output, /Finalization finalized: meta-review/);
    assert.match(output, /已整理進 DB：Codex recovery review surface/);
  });

  it('hook-context prompts from JSONL stat preview when no import marker exists', async () => {
    const root = tmpDir();
    const sessionsDir = path.join(root, 'sessions');
    const stateDir = path.join(root, 'state');
    const previous = path.join(sessionsDir, 'rollout-previous.jsonl');
    const current = path.join(sessionsDir, 'rollout-current.jsonl');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(previous, '{"type":"session_meta","payload":{"id":"meta-previous"}}\n', 'utf8');
    fs.writeFileSync(current, '{"type":"session_meta","payload":{"id":"meta-current"}}\n', 'utf8');
    const now = Date.now();
    fs.utimesSync(previous, new Date(now - 1000), new Date(now - 1000));
    fs.utimesSync(current, new Date(now), new Date(now));

    const output = await captureConsoleLog(() => recovery.cmdHookContext({}, {}, {
      sessionsDir,
      stateDir,
      minSessionBytes: 1,
      excludeNewest: true,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
    }));

    assert.equal(output, '');
  });

  it('hook-context prompts only from DB-eligible JSONL recovery candidates', async () => {
    const root = tmpDir();
    const sessionsDir = path.join(root, 'sessions');
    const stateDir = path.join(root, 'state');
    const previous = path.join(sessionsDir, 'rollout-previous.jsonl');
    const short = path.join(sessionsDir, 'rollout-short.jsonl');
    const current = path.join(sessionsDir, 'rollout-current.jsonl');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(previous, [
      '{"type":"session_meta","payload":{"id":"meta-previous"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u1"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a1"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u2"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a2"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u3"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a3"}]}}',
    ].join('\n') + '\n', 'utf8');
    fs.writeFileSync(short, [
      '{"type":"session_meta","payload":{"id":"meta-short"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u1"}}',
    ].join('\n') + '\n', 'utf8');
    fs.writeFileSync(current, '{"type":"session_meta","payload":{"id":"meta-current"}}\n', 'utf8');
    const now = Date.now();
    fs.utimesSync(previous, new Date(now - 3000), new Date(now - 3000));
    fs.utimesSync(short, new Date(now - 2000), new Date(now - 2000));
    fs.utimesSync(current, new Date(now), new Date(now));

    const output = await captureConsoleLog(() => recovery.cmdHookContext({}, {}, {
      sessionsDir,
      stateDir,
      minSessionBytes: 1,
      excludeNewest: true,
      agentId: 'main',
      source: 'codex',
      sessionKey: 'codex:cli',
      minUserMessages: 3,
    }));

    assert.match(output, /\[AQUIFER RECOVERY\]/);
    assert.match(output, /meta-previous/);
    assert.doesNotMatch(output, /meta-short/);
    assert.doesNotMatch(output, /rollout-current/);
  });

  it('doctor verifies wrapper preflight without printing transcript text', async () => {
    const root = tmpDir();
    const sessionsDir = path.join(root, 'sessions');
    const stateDir = path.join(root, 'state');
    const hooksPath = path.join(root, 'hooks.json');
    const previous = path.join(sessionsDir, 'rollout-previous.jsonl');
    const current = path.join(sessionsDir, 'rollout-current.jsonl');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(previous, [
      '{"type":"session_meta","payload":{"id":"meta-previous"}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"private user transcript"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"private assistant transcript"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u2"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a2"}]}}',
      '{"type":"event_msg","payload":{"type":"user_message","message":"u3"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a3"}]}}',
    ].join('\n') + '\n', 'utf8');
    fs.writeFileSync(current, '{"type":"session_meta","payload":{"id":"meta-current"}}\n', 'utf8');
    const now = Date.now();
    fs.utimesSync(previous, new Date(now - 1000), new Date(now - 1000));
    fs.utimesSync(current, new Date(now), new Date(now));
    await captureConsoleLog(() => recovery.cmdCheckpointHeartbeatHook({
      'scope-key': 'project:aquifer',
      'hooks-path': hooksPath,
      apply: true,
    }, {
      agentId: 'main',
      source: 'codex-wrapper',
      sessionKey: 'codex:wrapper:run',
    }));

    const output = await captureConsoleLog(() => recovery.cmdDoctor({}, {}, {
      sessionsDir,
      stateDir,
      hooksPath,
      minSessionBytes: 1,
      excludeNewest: true,
      agentId: 'main',
      source: 'codex-wrapper',
      sessionKey: 'codex:wrapper:run',
      maxRecoveryCandidates: 3,
    }, {
      CODEX_AQUIFER_SOURCE: 'codex-wrapper',
      CODEX_AQUIFER_SESSION_KEY: 'codex:wrapper:run',
    }));

    assert.match(output, /Codex recovery doctor: ok/);
    assert.match(output, /wrapper_env/);
    assert.match(output, /current_transcript_guard/);
    assert.match(output, /checkpoint_heartbeat_hook/);
    assert.match(output, /eligibleCandidates=1/);
    assert.doesNotMatch(output, /private user transcript/);
    assert.doesNotMatch(output, /private assistant transcript/);
    assert.doesNotMatch(output, /meta-current/);
  });

  it('doctor can fail strict wrapper checks before live deployment', async () => {
    const report = await recovery.buildDoctorReport({}, {
      sessionsDir: path.join(tmpDir(), 'sessions'),
      stateDir: path.join(tmpDir(), 'state'),
      strictWrapperEnv: true,
      excludeNewest: false,
    }, {});

    assert.equal(report.status, 'fail');
    assert.ok(report.checks.some(check => check.name === 'wrapper_env' && check.status === 'fail'));
    assert.ok(report.checks.some(check => check.name === 'current_transcript_guard' && check.status === 'fail'));
  });

  it('doctor reports Aquifer init failures as structured checks', async () => {
    let report;
    const previousExitCode = process.exitCode;
    await captureConsoleLog(async () => {
      report = await recovery.cmdDoctorInitFailure({}, {
        sessionsDir: path.join(tmpDir(), 'sessions'),
        stateDir: path.join(tmpDir(), 'state'),
        strictWrapperEnv: true,
      }, new Error('Database URL is required'), {
        CODEX_AQUIFER_SOURCE: 'codex-wrapper',
      });
    });
    process.exitCode = previousExitCode;

    assert.equal(report.status, 'fail');
    assert.ok(report.checks.some(check => check.name === 'aquifer_init' && check.status === 'fail'));
    assert.ok(report.checks.some(check => check.name === 'wrapper_env' && check.status === 'ok'));
  });

  it('public CLI delegates codex-recovery doctor as structured JSON', () => {
    const root = tmpDir();
    const result = spawnSync('node', [
      CLI_PATH,
      'codex-recovery',
      'doctor',
      '--json',
      '--strict-wrapper-env',
      '--sessions-dir',
      path.join(root, 'sessions'),
      '--state-dir',
      path.join(root, 'state'),
    ], {
      env: {
        ...process.env,
        AQUIFER_CONFIG: '/dev/null',
        AQUIFER_DB_URL: '',
        DATABASE_URL: '',
        CODEX_AQUIFER_SOURCE: 'codex-wrapper',
        CODEX_AQUIFER_SESSION_KEY: 'codex:wrapper:run',
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.ok(['ok', 'warn'].includes(payload.status));
    assert.ok(payload.checks.some(check => check.name === 'wrapper_env' && check.status === 'ok'));
    assert.ok(payload.checks.some(check => check.name === 'current_transcript_guard' && check.status === 'ok'));
    assert.equal(result.stderr, '');
  });

  it('public CLI help lists codex-recovery', () => {
    const result = spawnSync('node', [CLI_PATH, '--help'], { encoding: 'utf8' });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /codex-recovery .*recovery\/checkpoint flows/);
    assert.match(result.stdout, /codex-recovery checkpoint-heartbeat --hook-stdin --scope-key project:aquifer/);
  });
});
