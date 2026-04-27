'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const recovery = require('../scripts/codex-recovery');

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
      idleMs: 1,
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
});
