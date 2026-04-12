'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createAquifer } = require('../index');

// Mock pool that simulates a successful enrich flow
function createMockPool() {
  const sessionRow = {
    id: 42,
    session_id: 'test-session',
    agent_id: 'main',
    tenant_id: 'default',
    model: 'test-model-v1',
    source: 'gateway',
    started_at: '2026-04-12T10:00:00Z',
    ended_at: '2026-04-12T10:30:00Z',
    messages: JSON.stringify({ normalized: [
      { role: 'user', content: 'hello', timestamp: '2026-04-12T10:00:00Z' },
      { role: 'assistant', content: 'hi there', timestamp: '2026-04-12T10:01:00Z' },
    ]}),
    processing_status: 'pending',
  };

  const queries = [];
  const mockClient = {
    query: async (sql, params) => {
      queries.push({ sql: sql.trim().slice(0, 60), params });
      if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) return;
      return { rows: [sessionRow] };
    },
    release: () => { queries.push({ sql: 'RELEASE' }); },
  };

  const pool = {
    query: async (sql, params) => {
      queries.push({ sql: sql.trim().slice(0, 60), params });
      if (sql.includes('processing_status')) {
        return { rows: [sessionRow] };
      }
      return { rows: [] };
    },
    connect: async () => mockClient,
    end: async () => {},
  };

  return { pool, queries, sessionRow };
}

describe('enrich postProcess hook', () => {
  let aq, mockPool, queries;

  beforeEach(() => {
    const mock = createMockPool();
    mockPool = mock.pool;
    queries = mock.queries;
    aq = createAquifer({
      db: mockPool,
      embed: { fn: async (texts) => texts.map(() => [0.1, 0.2, 0.3]) },
    });
  });

  it('calls postProcess with correct context after commit', async () => {
    let capturedCtx = null;
    const result = await aq.enrich('test-session', {
      agentId: 'main',
      summaryFn: async () => ({
        summaryText: 'test summary',
        structuredSummary: { title: 'Test' },
        extra: { myData: 123 },
      }),
      postProcess: async (ctx) => { capturedCtx = ctx; },
    });

    // postProcess was called
    assert.ok(capturedCtx);

    // session metadata
    assert.equal(capturedCtx.session.id, 42);
    assert.equal(capturedCtx.session.sessionId, 'test-session');
    assert.equal(capturedCtx.session.agentId, 'main');
    assert.equal(capturedCtx.session.model, 'test-model-v1');
    assert.equal(capturedCtx.session.source, 'gateway');

    // summary
    assert.ok(capturedCtx.summary);
    assert.equal(capturedCtx.summary.summaryText, 'test summary');

    // extra passthrough
    assert.deepEqual(capturedCtx.extra, { myData: 123 });

    // embedding computed
    assert.ok(capturedCtx.embedding);
    assert.equal(capturedCtx.embedding.length, 3);

    // normalized messages
    assert.ok(Array.isArray(capturedCtx.normalized));
    assert.equal(capturedCtx.normalized.length, 2);

    // skipped flags
    assert.equal(capturedCtx.skipped.summary, false);

    // return value has session and no error
    assert.ok(result.session);
    assert.equal(result.session.sessionId, 'test-session');
    assert.equal(result.postProcessError, null);

    // client was released BEFORE postProcess (check order)
    const releaseIdx = queries.findIndex(q => q.sql === 'RELEASE');
    assert.ok(releaseIdx >= 0, 'client should be released');
  });

  it('postProcess receives null summary when skipSummary', async () => {
    let capturedCtx = null;
    await aq.enrich('test-session', {
      agentId: 'main',
      skipSummary: true,
      postProcess: async (ctx) => { capturedCtx = ctx; },
    });

    assert.ok(capturedCtx);
    assert.equal(capturedCtx.summary, null);
    assert.equal(capturedCtx.embedding, null);
    assert.equal(capturedCtx.skipped.summary, true);
  });

  it('postProcess throw sets postProcessError without affecting session status', async () => {
    const result = await aq.enrich('test-session', {
      agentId: 'main',
      summaryFn: async () => ({
        summaryText: 'test',
        structuredSummary: { title: 'T' },
      }),
      postProcess: async () => { throw new Error('hook failed'); },
    });

    // enrich did not throw
    assert.ok(result);
    assert.ok(result.postProcessError);
    assert.equal(result.postProcessError.message, 'hook failed');

    // session was still marked succeeded (COMMIT happened before postProcess)
    const commitQuery = queries.find(q => q.sql.includes('COMMIT'));
    assert.ok(commitQuery, 'COMMIT should have happened');
  });

  it('enrich without postProcess works as before (backward compat)', async () => {
    const result = await aq.enrich('test-session', {
      agentId: 'main',
      summaryFn: async () => ({
        summaryText: 'test',
        structuredSummary: { title: 'T' },
      }),
    });

    assert.ok(result);
    assert.equal(result.summary, 'test');
    assert.equal(result.postProcessError, null);
    assert.ok(result.session);
    assert.ok(result.effectiveModel);
  });

  it('opts.model overrides session.model in summary and effectiveModel', async () => {
    let capturedCtx = null;
    const result = await aq.enrich('test-session', {
      agentId: 'main',
      model: 'override-model',
      summaryFn: async () => ({
        summaryText: 'test',
        structuredSummary: { title: 'T' },
      }),
      postProcess: async (ctx) => { capturedCtx = ctx; },
    });

    // effectiveModel reflects the override
    assert.equal(result.effectiveModel, 'override-model');
    assert.equal(capturedCtx.effectiveModel, 'override-model');
    // session.model is still the original
    assert.equal(capturedCtx.session.model, 'test-model-v1');
  });

  it('warnings in postProcess context are a defensive copy', async () => {
    let capturedWarnings = null;
    const result = await aq.enrich('test-session', {
      agentId: 'main',
      summaryFn: async () => ({
        summaryText: 'test',
        structuredSummary: { title: 'T' },
      }),
      postProcess: async (ctx) => {
        capturedWarnings = ctx.warnings;
        ctx.warnings.push('injected by postProcess');
      },
    });

    // postProcess could push to its copy
    assert.ok(capturedWarnings.includes('injected by postProcess'));
    // but the returned warnings are unaffected
    assert.ok(!result.warnings.includes('injected by postProcess'));
  });
});
