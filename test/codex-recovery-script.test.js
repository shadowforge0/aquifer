'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const recovery = require('../scripts/codex-recovery');

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
    assert.match(context, /has not read the full JSONL transcript/);
    assert.match(context, /codex-recovery\.js' 'prompt'/);
    assert.match(context, /codex-recovery\.js' 'finalize'/);
    assert.match(context, /--summary-stdin/);
    assert.match(context, /--verdict' 'declined'/);
  });
});
