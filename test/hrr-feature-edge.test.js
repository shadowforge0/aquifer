'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { hybridRank } = require('../core/hybrid-rank');
const {
  resolveEntities,
  getSessionsByEntityIntersection,
} = require('../core/entity');
const { recordFeedback } = require('../core/storage');
const { createAquifer } = require('../core/aquifer');

function makeFeedbackPool(selectRows) {
  const calls = [];
  let released = false;

  const client = {
    async query(sql, params) {
      calls.push({ sql, params });

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }

      if (sql.includes('SELECT trust_score')) {
        return { rows: selectRows };
      }

      // Dedupe lookup: no prior feedback exists, so tests run the full
      // trust-update path.
      if (sql.includes('session_feedback') && sql.includes('SELECT 1')) {
        return { rows: [] };
      }

      if (sql.includes('UPDATE "aq".session_summaries')) {
        return { rows: [] };
      }

      if (sql.includes('INSERT INTO "aq".session_feedback')) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {
      released = true;
    },
  };

  return {
    pool: {
      async connect() {
        return client;
      },
    },
    calls,
    wasReleased() {
      return released;
    },
  };
}

describe('hybrid-rank.js edge cases', () => {
  describe('trust multiplier', () => {
    it('treats null and undefined trust_score as the neutral default', () => {
      const now = new Date().toISOString();
      const rows = hybridRank(
        [
          { session_id: 'missing', started_at: now },
          { session_id: 'nullish', started_at: now, trust_score: null },
          { session_id: 'undef', started_at: now, trust_score: undefined },
        ],
        [],
        [],
        {
          weights: { rrf: 0, timeDecay: 1, access: 0, entityBoost: 0, openLoop: 0 },
          limit: 3,
        }
      );

      const missing = rows.find((row) => row.session_id === 'missing');
      const nullish = rows.find((row) => row.session_id === 'nullish');
      const undef = rows.find((row) => row.session_id === 'undef');

      assert.equal(missing._trustScore, 0.5);
      assert.equal(nullish._trustScore, 0.5);
      assert.equal(undef._trustScore, 0.5);
      assert.equal(missing._trustMultiplier, 1.0);
      assert.equal(nullish._trustMultiplier, 1.0);
      assert.equal(undef._trustMultiplier, 1.0);
      assert.equal(nullish._score, missing._score);
      assert.equal(undef._score, missing._score);
    });

    it('keeps trust_score=0.5 equivalent to omitting trust_score', () => {
      const now = new Date().toISOString();
      const rows = hybridRank(
        [
          { session_id: 'neutral', started_at: now, trust_score: 0.5 },
          { session_id: 'implicit', started_at: now },
        ],
        [],
        [],
        {
          weights: { rrf: 0, timeDecay: 1, access: 0, entityBoost: 0, openLoop: 0 },
          limit: 2,
        }
      );

      const neutral = rows.find((row) => row.session_id === 'neutral');
      const implicit = rows.find((row) => row.session_id === 'implicit');

      assert.equal(neutral._trustMultiplier, 1.0);
      assert.equal(neutral._score, implicit._score);
    });

    it('handles trust scores extremely close to the boundaries', () => {
      const now = new Date().toISOString();
      const rows = hybridRank(
        [
          { session_id: 'almost-zero', started_at: now, trust_score: 0.001 },
          { session_id: 'almost-one', started_at: now, trust_score: 0.999 },
        ],
        [],
        [],
        {
          weights: { rrf: 0, timeDecay: 1, access: 0, entityBoost: 0, openLoop: 0 },
          limit: 2,
        }
      );

      const low = rows.find((row) => row.session_id === 'almost-zero');
      const high = rows.find((row) => row.session_id === 'almost-one');

      assert.ok(Math.abs(low._trustMultiplier - 0.501) < 1e-12);
      assert.ok(Math.abs(high._trustMultiplier - 1.499) < 1e-12);
      assert.ok(high._score > low._score);
    });

    it('ranks higher-trust sessions first when base signals are otherwise identical', () => {
      const now = new Date().toISOString();
      const rows = hybridRank(
        [
          { session_id: 'low', started_at: now, trust_score: 0.1 },
          { session_id: 'high', started_at: now, trust_score: 0.9 },
        ],
        [],
        [],
        {
          weights: { rrf: 0, timeDecay: 1, access: 0, entityBoost: 0, openLoop: 0 },
          limit: 2,
        }
      );

      assert.equal(rows[0].session_id, 'high');
      assert.equal(rows[1].session_id, 'low');
    });

    it('clamps a high-trust saturated score at 1.0', () => {
      const now = new Date().toISOString();
      const [row] = hybridRank(
        [{
          session_id: 'sat',
          started_at: now,
          trust_score: 1.0,
          access_count: 1000,
          last_accessed_at: now,
        }],
        [],
        [],
        {
          limit: 1,
          weights: { rrf: 10, timeDecay: 10, access: 10, entityBoost: 0, openLoop: 0 },
        }
      );

      assert.equal(row._trustMultiplier, 1.5);
      assert.equal(row._score, 1);
    });
  });

  describe('open-loop handling', () => {
    it('applies no boost when openLoopSet is an empty Set', () => {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const baseline = hybridRank(
        [
          { session_id: 'a', started_at: now },
          { session_id: 'b', started_at: now },
        ],
        [],
        [],
        {
          weights: { rrf: 0, timeDecay: 1, access: 0, entityBoost: 0, openLoop: 0.08 },
          limit: 2,
          nowMs,
        }
      );

      const withEmptySet = hybridRank(
        [
          { session_id: 'a', started_at: now },
          { session_id: 'b', started_at: now },
        ],
        [],
        [],
        {
          weights: { rrf: 0, timeDecay: 1, access: 0, entityBoost: 0, openLoop: 0.08 },
          openLoopSet: new Set(),
          limit: 2,
          nowMs,
        }
      );

      assert.deepEqual(withEmptySet.map((row) => row._openLoopBoost), [0, 0]);
      assert.deepEqual(withEmptySet.map((row) => row._score), baseline.map((row) => row._score));
    });

    it('keeps relative order unchanged when every session gets the same open-loop boost', () => {
      const newer = new Date().toISOString();
      const older = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();

      const withoutBoost = hybridRank(
        [
          { session_id: 'newer', started_at: newer },
          { session_id: 'older', started_at: older },
        ],
        [],
        [],
        {
          weights: { rrf: 0, timeDecay: 1, access: 0, entityBoost: 0, openLoop: 0.08 },
          limit: 2,
        }
      );

      const withBoost = hybridRank(
        [
          { session_id: 'newer', started_at: newer },
          { session_id: 'older', started_at: older },
        ],
        [],
        [],
        {
          weights: { rrf: 0, timeDecay: 1, access: 0, entityBoost: 0, openLoop: 0.08 },
          openLoopSet: new Set(['newer', 'older']),
          limit: 2,
        }
      );

      assert.deepEqual(withoutBoost.map((row) => row.session_id), ['newer', 'older']);
      assert.deepEqual(withBoost.map((row) => row.session_id), ['newer', 'older']);
      assert.deepEqual(withBoost.map((row) => row._openLoopBoost), [0.08, 0.08]);
    });

    it('ignores open-loop entries for sessions not present in the result lists', () => {
      const now = new Date().toISOString();
      const baseline = hybridRank(
        [{ session_id: 'present', started_at: now }],
        [],
        [],
        {
          weights: { rrf: 0, timeDecay: 1, access: 0, entityBoost: 0, openLoop: 0.08 },
          limit: 1,
        }
      );

      const [row] = hybridRank(
        [{ session_id: 'present', started_at: now }],
        [],
        [],
        {
          weights: { rrf: 0, timeDecay: 1, access: 0, entityBoost: 0, openLoop: 0.08 },
          openLoopSet: new Set(['missing-session']),
          limit: 1,
        }
      );

      assert.equal(row._openLoopBoost, 0);
      // hybridRank reads `now` inside the call; two sequential invocations
      // with the same input can differ by ~1e-10 through time-decay rounding.
      // Lock equality with a tolerance rather than strict eq.
      assert.ok(Math.abs(row._score - baseline[0]._score) < 1e-6,
        `score drift exceeds tolerance: ${row._score} vs ${baseline[0]._score}`);
    });
  });

  describe('combined signals', () => {
    it('lets trust suppression lose even with open-loop and entity boosts', () => {
      const now = new Date().toISOString();
      const rows = hybridRank(
        [
          { session_id: 'suppressed', started_at: now, trust_score: 0 },
          { session_id: 'trusted', started_at: now, trust_score: 1 },
        ],
        [],
        [],
        {
          weights: { rrf: 0, timeDecay: 1, access: 0, entityBoost: 0.18, openLoop: 0.08 },
          entityScoreBySession: new Map([['suppressed', 1]]),
          openLoopSet: new Set(['suppressed']),
          limit: 2,
        }
      );

      assert.equal(rows[0].session_id, 'trusted');
      assert.equal(rows[1].session_id, 'suppressed');
      assert.ok(rows[0]._score > rows[1]._score);
    });

    it('lets trust alone elevate a session without open-loop or entity help', () => {
      const now = new Date().toISOString();
      const rows = hybridRank(
        [
          { session_id: 'neutral', started_at: now, trust_score: 0.5 },
          { session_id: 'trusted', started_at: now, trust_score: 1.0 },
        ],
        [],
        [],
        {
          weights: { rrf: 0, timeDecay: 1, access: 0, entityBoost: 0, openLoop: 0 },
          limit: 2,
        }
      );

      assert.equal(rows[0].session_id, 'trusted');
      assert.equal(rows[0]._openLoopBoost, 0);
      assert.equal(rows[0]._entityScore, 0);
    });
  });
});

describe('entity.js edge cases', () => {
  describe('resolveEntities', () => {
    it('returns a mapped entity for a single matching name', async () => {
      const pool = {
        async query() {
          return { rows: [{ id: 7, name: 'PostgreSQL', normalized_name: 'postgresql' }] };
        },
      };

      const result = await resolveEntities(pool, {
        schema: 'aq',
        tenantId: 'tenant',
        names: ['PostgreSQL'],
      });

      assert.deepEqual(result, [{
        entityId: 7,
        name: 'PostgreSQL',
        normalizedName: 'postgresql',
        inputName: 'PostgreSQL',
      }]);
    });

    it('returns [] when a single input name does not resolve', async () => {
      const pool = {
        async query() {
          return { rows: [] };
        },
      };

      const result = await resolveEntities(pool, {
        schema: 'aq',
        tenantId: 'tenant',
        names: ['unknown'],
      });

      assert.deepEqual(result, []);
    });

    it('skips names that normalize to empty strings without querying', async () => {
      let queryCount = 0;
      const pool = {
        async query() {
          queryCount++;
          return { rows: [] };
        },
      };

      const result = await resolveEntities(pool, {
        schema: 'aq',
        tenantId: 'tenant',
        names: ['   ---   ', '(( ))', '!!!'],
      });

      assert.deepEqual(result, []);
      assert.equal(queryCount, 0);
    });

    it('normalizes unicode and fullwidth input before querying', async () => {
      const captured = [];
      const pool = {
        async query(sql, params) {
          captured.push(params[1]);
          return { rows: [{ id: 1, name: 'Pg', normalized_name: 'pg' }] };
        },
      };

      await resolveEntities(pool, {
        schema: 'aq',
        tenantId: 'tenant',
        names: ['ＰＧ'],
      });

      assert.deepEqual(captured, ['pg']);
    });
  });

  describe('getSessionsByEntityIntersection', () => {
    it('clamps limit=0 up to 1', async () => {
      let capturedLimit = null;
      const pool = {
        async query(sql, params) {
          capturedLimit = params[params.length - 1];
          return { rows: [] };
        },
      };

      const result = await getSessionsByEntityIntersection(pool, {
        schema: 'aq',
        entityIds: [1, 2],
        tenantId: 'tenant',
        limit: 0,
      });

      assert.deepEqual(result, []);
      assert.equal(capturedLimit, 1);
    });
  });
});

describe('storage.js edge cases', () => {
  describe('recordFeedback', () => {
    it('raises trust by 0.05 for helpful feedback', async () => {
      const mock = makeFeedbackPool([{ trust_score: 0.5 }]);

      const result = await recordFeedback(mock.pool, {
        schema: 'aq',
        tenantId: 'tenant',
        sessionRowId: 10,
        sessionId: 'sess-10',
        agentId: 'agent',
        verdict: 'helpful',
      });

      const updateCall = mock.calls.find((call) => call.sql.includes('UPDATE "aq".session_summaries'));
      const insertCall = mock.calls.find((call) => call.sql.includes('INSERT INTO "aq".session_feedback'));

      assert.deepEqual(result, { trustBefore: 0.5, trustAfter: 0.55, verdict: 'helpful', duplicate: false });
      assert.equal(updateCall.params[0], 0.55);
      assert.equal(insertCall.params[6], 0.5);
      assert.equal(insertCall.params[7], 0.55);
      assert.equal(mock.wasReleased(), true);
    });

    it('lowers trust by 0.10 for unhelpful feedback', async () => {
      const mock = makeFeedbackPool([{ trust_score: 0.5 }]);

      const result = await recordFeedback(mock.pool, {
        schema: 'aq',
        tenantId: 'tenant',
        sessionRowId: 10,
        sessionId: 'sess-10',
        agentId: 'agent',
        verdict: 'unhelpful',
      });

      const updateCall = mock.calls.find((call) => call.sql.includes('UPDATE "aq".session_summaries'));
      const insertCall = mock.calls.find((call) => call.sql.includes('INSERT INTO "aq".session_feedback'));

      assert.deepEqual(result, { trustBefore: 0.5, trustAfter: 0.4, verdict: 'unhelpful', duplicate: false });
      assert.equal(updateCall.params[0], 0.4);
      assert.equal(insertCall.params[6], 0.5);
      assert.equal(insertCall.params[7], 0.4);
    });

    it('keeps trust at 0 for unhelpful feedback when already at the floor', async () => {
      const mock = makeFeedbackPool([{ trust_score: 0 }]);

      const result = await recordFeedback(mock.pool, {
        schema: 'aq',
        tenantId: 'tenant',
        sessionRowId: 10,
        sessionId: 'sess-10',
        agentId: 'agent',
        verdict: 'unhelpful',
      });

      const updateCall = mock.calls.find((call) => call.sql.includes('UPDATE "aq".session_summaries'));
      const insertCall = mock.calls.find((call) => call.sql.includes('INSERT INTO "aq".session_feedback'));

      assert.deepEqual(result, { trustBefore: 0, trustAfter: 0, verdict: 'unhelpful', duplicate: false });
      assert.equal(updateCall.params[0], 0);
      assert.equal(insertCall.params[6], 0);
      assert.equal(insertCall.params[7], 0);
    });

    it('keeps trust at 1 for helpful feedback when already at the ceiling', async () => {
      const mock = makeFeedbackPool([{ trust_score: 1 }]);

      const result = await recordFeedback(mock.pool, {
        schema: 'aq',
        tenantId: 'tenant',
        sessionRowId: 10,
        sessionId: 'sess-10',
        agentId: 'agent',
        verdict: 'helpful',
      });

      const updateCall = mock.calls.find((call) => call.sql.includes('UPDATE "aq".session_summaries'));

      assert.deepEqual(result, { trustBefore: 1, trustAfter: 1, verdict: 'helpful', duplicate: false });
      assert.equal(updateCall.params[0], 1);
    });

    it('throws when the session has no summary row to lock', async () => {
      const mock = makeFeedbackPool([]);

      await assert.rejects(
        () => recordFeedback(mock.pool, {
          schema: 'aq',
          tenantId: 'tenant',
          sessionRowId: 10,
          sessionId: 'sess-10',
          agentId: 'agent',
          verdict: 'helpful',
        }),
        /Session not enriched/
      );

      assert.equal(mock.calls.some((call) => call.sql === 'ROLLBACK'), true);
      assert.equal(mock.wasReleased(), true);
    });
  });
});

describe('aquifer.js edge cases', () => {
  describe('feedback', () => {
    it('throws when getSession returns null for a missing sessionId', async () => {
      const aquifer = createAquifer({
        db: {
          async query() {
            return { rows: [] };
          },
        },
      });

      await assert.rejects(
        () => aquifer.feedback(undefined, { verdict: 'helpful' }),
        /Session not found/
      );
    });
  });

  describe('recall with entities', () => {
    it('ignores an empty entities array and runs normal recall flow', async () => {
      const queries = [];
      const aquifer = createAquifer({
        db: {
          async query(sql) {
            queries.push(sql);
            return { rows: [] };
          },
        },
        embed: {
          async fn() {
            return [[0.1]];
          },
          dim: 1,
        },
      });

      const result = await aquifer.recall('test query', { entities: [] });

      assert.deepEqual(result, []);
    });

    it('ignores entityMode when entities are not provided', async () => {
      const aquifer = createAquifer({
        db: {
          async query() {
            return { rows: [] };
          },
        },
        embed: {
          async fn() {
            return [[0.1]];
          },
          dim: 1,
        },
      });

      const result = await aquifer.recall('test query', { entityMode: 'all' });

      assert.deepEqual(result, []);
    });
  });
});
