'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAquifer } = require('../index');
const {
  REDACTION,
  applyEnrichSafetyGate,
  sanitizeSummaryResult,
} = require('../core/memory-safety-gate');

function textOf(messages) {
  return messages.map(m => m.content || m.text || '').join('\n');
}

function createMockPool(messages) {
  const sessionRow = {
    id: 42,
    session_id: 'safety-session',
    agent_id: 'main',
    tenant_id: 'default',
    model: 'test-model',
    source: 'codex',
    started_at: '2026-04-26T10:00:00Z',
    ended_at: '2026-04-26T10:30:00Z',
    messages: JSON.stringify({ normalized: messages }),
    processing_status: 'pending',
  };
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [sessionRow], rowCount: 1 };
    },
    release: () => {},
  };
  return {
    queries,
    pool: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (String(sql).includes('processing_status')) return { rows: [sessionRow], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      connect: async () => client,
      end: async () => {},
    },
  };
}

describe('v1 enrich safety gate', () => {
  it('drops injected context and raw tool output, while redacting secrets in kept messages', () => {
    const input = [
      { role: 'user', content: '[AQUIFER CONTEXT]\nOld bootstrap text must stay evidence-only.' },
      { role: 'user', content: 'Configure DATABASE_URL=postgresql://user:pass@localhost:5432/db before retrying.' },
      { role: 'tool', content: 'Exit code: 1\nWall time: 0.1\nOutput:\nsecret stack' },
      { role: 'user', content: 'Keep curated memory separate from evidence.' },
    ];
    const before = JSON.stringify(input);

    const result = applyEnrichSafetyGate(input);
    const safeText = textOf(result.messages);

    assert.equal(JSON.stringify(input), before, 'safety gate must not mutate raw evidence');
    assert.equal(result.meta.stats.total, 4);
    assert.equal(result.meta.stats.dropped, 2);
    assert.equal(result.meta.stats.redacted, 1);
    assert.match(safeText, /Keep curated memory separate/);
    assert.match(safeText, new RegExp(REDACTION));
    assert.doesNotMatch(safeText, /AQUIFER CONTEXT/);
    assert.doesNotMatch(safeText, /user:pass/);
    assert.doesNotMatch(safeText, /Exit code/);
  });

  it('redacts summary output recursively before storage or embedding', () => {
    const result = sanitizeSummaryResult({
      summaryText: 'Use sk-abcdefghijklmnopqrstuvwxyz123456 for tests.',
      structuredSummary: {
        decisions: [
          { decision: 'Token ghp_abcdefghijklmnopqrstuvwxyz123456 must not persist.' },
          { decision: '[AQUIFER CONTEXT] injected text' },
        ],
      },
    });

    assert.match(result.summaryResult.summaryText, new RegExp(REDACTION));
    assert.doesNotMatch(result.summaryResult.summaryText, /sk-/);
    assert.equal(result.summaryResult.structuredSummary.decisions.length, 1);
    assert.match(result.summaryResult.structuredSummary.decisions[0].decision, new RegExp(REDACTION));
    assert.equal(result.meta.redacted, 2);
    assert.equal(result.meta.dropped, 1);
  });

  it('enrich feeds sanitized content into summary and embeddings, not raw evidence', async () => {
    const rawMessages = [
      { role: 'user', content: '[AQUIFER CONTEXT]\nInjected bootstrap decision.' },
      { role: 'user', content: 'DATABASE_URL=postgresql://user:pass@localhost:5432/db should be rotated.' },
      { role: 'user', content: 'Keep curated memory separate from evidence.' },
      { role: 'user', content: 'Traceback (most recent call last):\n  File "x.py", line 1, in <module>' },
    ];
    const { pool } = createMockPool(rawMessages);
    const embedInputs = [];
    let summaryInput = null;
    let postProcessCtx = null;
    const aq = createAquifer({
      db: pool,
      migrations: { mode: 'off' },
      embed: {
        fn: async (texts) => {
          embedInputs.push([...texts]);
          return texts.map(() => [0.1, 0.2, 0.3]);
        },
      },
    });

    const result = await aq.enrich('safety-session', {
      agentId: 'main',
      summaryFn: async (messages) => {
        summaryInput = messages;
        return {
          summaryText: 'Summary mentions sk-abcdefghijklmnopqrstuvwxyz123456.',
          structuredSummary: {
            decisions: [{ decision: 'Use token ghp_abcdefghijklmnopqrstuvwxyz123456 nowhere.' }],
          },
        };
      },
      postProcess: async (ctx) => { postProcessCtx = ctx; },
    });

    const summaryInputText = textOf(summaryInput);
    const embeddedText = embedInputs.flat().join('\n');

    assert.equal(postProcessCtx.normalized.length, 4, 'raw evidence stays available outside the indexed path');
    assert.equal(postProcessCtx.sanitized.length, 2);
    assert.equal(result.safetyGate.stats.dropped, 2);
    assert.equal(result.safetyGate.stats.redacted, 1);
    assert.match(summaryInputText, /Keep curated memory separate/);
    assert.match(summaryInputText, new RegExp(REDACTION));
    assert.doesNotMatch(summaryInputText, /AQUIFER CONTEXT|Traceback|user:pass/);
    assert.doesNotMatch(embeddedText, /AQUIFER CONTEXT|Traceback|user:pass|sk-|ghp_/);
    assert.match(result.summary, new RegExp(REDACTION));
    assert.match(result.structuredSummary.decisions[0].decision, new RegExp(REDACTION));
  });
});
