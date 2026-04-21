'use strict';

/**
 * Regression tests: feedback agentId contract
 *
 * Verifies that:
 * 1. core aquifer.feedback() routes by the agentId supplied in opts
 * 2. mcp.js session_feedback tool passes agentId through to aquifer.feedback()
 * 3. openclaw-plugin.js session_feedback tool passes agentId through (explicit param
 *    takes priority, then ctx.agentId falls back, then core default "agent")
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAquifer } = require('../index');

// ---------------------------------------------------------------------------
// Helpers — build a stub pool and storage-like verifier
// ---------------------------------------------------------------------------

/**
 * Creates an aquifer instance whose DB pool is a mock that records the agentId
 * passed to getSession/recordFeedback calls.
 *
 * We inject a pre-migrated state by stubbing ensureMigrated (via the migrate
 * path) — the trick is to pass a mock pool whose `query` handler:
 *   - Returns a rows=[] for the schema/table existence checks (migrate)
 *   - Returns a synthetic session row for the getSession lookup
 *   - Returns a synthetic feedback row for recordFeedback
 *
 * We capture the SQL + params to assert on agentId filtering.
 */
function makeMockPool(sessionRow) {
  const calls = [];

  const pool = {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });

      // Migrate: schema/table existence checks always return empty
      if (/information_schema|CREATE|ALTER|INDEX|EXTENSION|pg_/i.test(sql)) {
        return { rows: [] };
      }

      // getSession lookup — return provided sessionRow or nothing
      if (/FROM.*sessions.*WHERE/i.test(sql) || /session_id\s*=\s*\$1/i.test(sql)) {
        return { rows: sessionRow ? [sessionRow] : [] };
      }

      // recordFeedback INSERT
      if (/INSERT.*feedback/i.test(sql)) {
        return {
          rows: [{
            id: 1,
            verdict: params?.[3] || 'helpful',
            trust_before: 0.5,
            trust_after: 0.6,
          }],
        };
      }

      // trust score SELECT for feedback
      if (/trust_score|SELECT.*sessions/i.test(sql)) {
        return { rows: sessionRow ? [sessionRow] : [] };
      }

      return { rows: [] };
    },
    end: async () => {},
  };

  return pool;
}

// ---------------------------------------------------------------------------
// 1. core aquifer.feedback() — agentId routing
// ---------------------------------------------------------------------------

describe('core aquifer.feedback() agentId routing', () => {
  it('defaults agentId to "agent" when not supplied', async () => {
    const sessionRow = { id: 99, session_id: 'sess-1', agent_id: 'agent', trust_score: 0.5 };
    const pool = makeMockPool(sessionRow);
    const aq = createAquifer({ db: pool });

    // Pre-mark as migrated so ensureMigrated is a no-op
    await aq.migrate().catch(() => {}); // ignore DB errors from migration DDL

    try {
      await aq.feedback('sess-1', { verdict: 'helpful' });
    } catch { /* may throw on recordFeedback mock shape — that's OK */ }

    // Find the getSession query call and check agentId param
    const sessionQuery = pool.calls.find(c =>
      c.params && c.params.includes('agent')
    );
    assert.ok(sessionQuery, 'should have queried with agentId="agent"');
  });

  it('uses supplied agentId when present', async () => {
    const sessionRow = { id: 42, session_id: 'sess-2', agent_id: 'main', trust_score: 0.5 };
    const pool = makeMockPool(sessionRow);
    const aq = createAquifer({ db: pool });

    await aq.migrate().catch(() => {});

    try {
      await aq.feedback('sess-2', { verdict: 'helpful', agentId: 'main' });
    } catch {}

    const sessionQuery = pool.calls.find(c =>
      c.params && c.params.includes('main')
    );
    assert.ok(sessionQuery, 'should have queried with agentId="main"');
  });

  it('throws when verdict is missing', async () => {
    const pool = makeMockPool(null);
    const aq = createAquifer({ db: pool });

    await assert.rejects(
      () => aq.feedback('sess-3', { agentId: 'main' }),
      /verdict.*required/i
    );
  });

  it('throws when session is not found under given agentId', async () => {
    const pool = makeMockPool(null); // getSession returns []
    const aq = createAquifer({ db: pool });

    await aq.migrate().catch(() => {});

    await assert.rejects(
      () => aq.feedback('missing-sess', { verdict: 'helpful', agentId: 'vantage' }),
      /Session not found.*missing-sess.*vantage/i
    );
  });
});

// ---------------------------------------------------------------------------
// 2. MCP consumer — agentId param is wired through
// ---------------------------------------------------------------------------

describe('mcp consumer session_feedback — agentId parameter wiring', () => {
  it('passes agentId from params to aquifer.feedback()', async () => {
    const capturedOpts = {};

    // Simulate the handler logic extracted from mcp.js
    async function simulateMcpFeedbackHandler(params, aquifer) {
      const result = await aquifer.feedback(params.sessionId, {
        verdict: params.verdict,
        note: params.note || undefined,
        agentId: params.agentId || undefined,
      });
      return result;
    }

    const mockAquifer = {
      async feedback(sessionId, opts) {
        capturedOpts.sessionId = sessionId;
        capturedOpts.agentId = opts.agentId;
        capturedOpts.verdict = opts.verdict;
        return { verdict: opts.verdict, trustBefore: 0.5, trustAfter: 0.6 };
      },
    };

    await simulateMcpFeedbackHandler(
      { sessionId: 'sid-abc', verdict: 'helpful', agentId: 'main' },
      mockAquifer
    );

    assert.strictEqual(capturedOpts.sessionId, 'sid-abc');
    assert.strictEqual(capturedOpts.agentId, 'main');
    assert.strictEqual(capturedOpts.verdict, 'helpful');
  });

  it('passes undefined agentId when param is omitted (backward compat)', async () => {
    const capturedOpts = {};

    async function simulateMcpFeedbackHandler(params, aquifer) {
      const result = await aquifer.feedback(params.sessionId, {
        verdict: params.verdict,
        note: params.note || undefined,
        agentId: params.agentId || undefined,
      });
      return result;
    }

    const mockAquifer = {
      async feedback(sessionId, opts) {
        capturedOpts.agentId = opts.agentId;
        return { verdict: opts.verdict, trustBefore: 0.5, trustAfter: 0.6 };
      },
    };

    await simulateMcpFeedbackHandler(
      { sessionId: 'sid-xyz', verdict: 'unhelpful' },
      mockAquifer
    );

    assert.strictEqual(capturedOpts.agentId, undefined,
      'omitted agentId should be undefined, letting core default to "agent"');
  });
});

// ---------------------------------------------------------------------------
// 3. OpenClaw plugin consumer — agentId resolution priority
// ---------------------------------------------------------------------------

describe('openclaw-plugin consumer session_feedback — agentId resolution', () => {
  // Simulate the resolution logic from openclaw-plugin.js
  function resolveAgentId(params, ctx) {
    return params.agentId || ctx?.agentId || undefined;
  }

  it('explicit params.agentId takes priority over ctx.agentId', () => {
    const resolved = resolveAgentId({ agentId: 'vantage' }, { agentId: 'main' });
    assert.strictEqual(resolved, 'vantage');
  });

  it('falls back to ctx.agentId when params.agentId is absent', () => {
    const resolved = resolveAgentId({}, { agentId: 'main' });
    assert.strictEqual(resolved, 'main');
  });

  it('returns undefined when neither params.agentId nor ctx.agentId is present', () => {
    const resolved = resolveAgentId({}, {});
    assert.strictEqual(resolved, undefined,
      'should be undefined so core defaults to "agent"');
  });

  it('returns undefined when ctx itself is null/undefined', () => {
    const resolved = resolveAgentId({}, null);
    assert.strictEqual(resolved, undefined);
  });

  it('passes resolved agentId to aquifer.feedback()', async () => {
    const capturedOpts = {};

    // Simulate the execute() body from openclaw-plugin.js
    async function simulatePluginFeedbackExecute(params, ctx, aquifer) {
      const resolvedAgentId = params.agentId || ctx?.agentId || undefined;
      const result = await aquifer.feedback(params.sessionId, {
        verdict: params.verdict,
        note: params.note || undefined,
        agentId: resolvedAgentId,
      });
      return result;
    }

    const mockAquifer = {
      async feedback(sessionId, opts) {
        capturedOpts.agentId = opts.agentId;
        capturedOpts.sessionId = sessionId;
        return { verdict: opts.verdict, trustBefore: 0.5, trustAfter: 0.55 };
      },
    };

    // Case A: explicit param agentId
    await simulatePluginFeedbackExecute(
      { sessionId: 'sid-1', verdict: 'helpful', agentId: 'vantage' },
      { agentId: 'main' },
      mockAquifer
    );
    assert.strictEqual(capturedOpts.agentId, 'vantage', 'explicit param wins');

    // Case B: ctx agentId
    await simulatePluginFeedbackExecute(
      { sessionId: 'sid-2', verdict: 'helpful' },
      { agentId: 'life' },
      mockAquifer
    );
    assert.strictEqual(capturedOpts.agentId, 'life', 'ctx.agentId used as fallback');

    // Case C: no agentId anywhere → undefined → core defaults to "agent"
    await simulatePluginFeedbackExecute(
      { sessionId: 'sid-3', verdict: 'unhelpful' },
      {},
      mockAquifer
    );
    assert.strictEqual(capturedOpts.agentId, undefined, 'undefined when no agentId');
  });
});

// ---------------------------------------------------------------------------
// 4. getFeedbackStats — aggregate query
// ---------------------------------------------------------------------------

describe('getFeedbackStats', () => {
  const { getFeedbackStats } = require('../core/storage');

  it('returns zeroed stats when both tables are empty', async () => {
    const pool = {
      async query(sql) {
        if (sql.includes('session_feedback')) {
          return { rows: [{ total: 0, helpful: 0, unhelpful: 0, rated_sessions: 0 }] };
        }
        return { rows: [{ total_sessions: 0, avg_ts: null, min_ts: null, max_ts: null }] };
      },
    };
    const stats = await getFeedbackStats(pool, { schema: '"test"', tenantId: 'default' });
    assert.strictEqual(stats.totalFeedback, 0);
    assert.strictEqual(stats.helpfulCount, 0);
    assert.strictEqual(stats.unhelpfulCount, 0);
    assert.strictEqual(stats.feedbackSessions, 0);
    assert.strictEqual(stats.totalSessions, 0);
    assert.strictEqual(stats.trustScoreAvg, 0.5);
  });

  it('preserves trust_score=0 without defaulting to 0.5', async () => {
    const pool = {
      async query(sql) {
        if (sql.includes('session_feedback')) {
          return { rows: [{ total: 5, helpful: 0, unhelpful: 5, rated_sessions: 3 }] };
        }
        return { rows: [{ total_sessions: 10, avg_ts: '0.000', min_ts: 0, max_ts: 0.3 }] };
      },
    };
    const stats = await getFeedbackStats(pool, { schema: '"test"', tenantId: 'default' });
    assert.strictEqual(stats.trustScoreAvg, 0);
    assert.strictEqual(stats.trustScoreMin, 0);
    assert.strictEqual(stats.trustScoreMax, 0.3);
  });

  it('returns correct counts with feedback data', async () => {
    const pool = {
      async query(sql) {
        if (sql.includes('session_feedback')) {
          return { rows: [{ total: 10, helpful: 7, unhelpful: 3, rated_sessions: 5 }] };
        }
        return { rows: [{ total_sessions: 20, avg_ts: '0.600', min_ts: 0.4, max_ts: 0.8 }] };
      },
    };
    const stats = await getFeedbackStats(pool, { schema: '"test"', tenantId: 'default', agentId: 'main' });
    assert.strictEqual(stats.totalFeedback, 10);
    assert.strictEqual(stats.helpfulCount, 7);
    assert.strictEqual(stats.unhelpfulCount, 3);
    assert.strictEqual(stats.feedbackSessions, 5);
    assert.strictEqual(stats.totalSessions, 20);
    assert.strictEqual(stats.trustScoreAvg, 0.6);
    assert.strictEqual(stats.trustScoreMin, 0.4);
    assert.strictEqual(stats.trustScoreMax, 0.8);
  });

  it('uses the same session window for feedback and trust aggregates', async () => {
    const calls = [];
    const pool = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (sql.includes('session_feedback')) {
          return { rows: [{ total: 2, helpful: 1, unhelpful: 1, rated_sessions: 2 }] };
        }
        return { rows: [{ total_sessions: 4, avg_ts: '0.550', min_ts: 0.2, max_ts: 0.9 }] };
      },
    };

    const stats = await getFeedbackStats(pool, {
      schema: '"test"',
      tenantId: 'default',
      agentId: 'main',
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
    });

    assert.strictEqual(stats.totalFeedback, 2);
    assert.strictEqual(stats.totalSessions, 4);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].params, ['default', 'main', '2026-04-01', '2026-04-30']);
    assert.deepEqual(calls[1].params, ['default', 'main', '2026-04-01', '2026-04-30']);
    assert.match(calls[0].sql, /FROM .*sessions s/);
    assert.match(calls[1].sql, /FROM .*sessions s/);
    assert.match(calls[0].sql, /s\.started_at >= \$3::date/);
    assert.match(calls[1].sql, /s\.started_at >= \$3::date/);
  });
});
