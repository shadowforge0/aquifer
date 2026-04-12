'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { rrfFusion, timeDecay, accessScore, hybridRank } = require('../core/hybrid-rank');

describe('rrfFusion', () => {
  it('returns empty map for empty inputs', () => {
    const scores = rrfFusion([], [], []);
    assert.equal(scores.size, 0);
  });

  it('merges three result lists by session_id', () => {
    const fts = [{ session_id: 'a' }, { session_id: 'b' }];
    const emb = [{ session_id: 'b' }, { session_id: 'c' }];
    const turn = [{ session_id: 'a' }, { session_id: 'c' }];
    const scores = rrfFusion(fts, emb, turn);
    assert.equal(scores.size, 3);
    // 'a' and 'b' and 'c' all present
    assert.ok(scores.has('a'));
    assert.ok(scores.has('b'));
    assert.ok(scores.has('c'));
  });

  it('gives higher score to items appearing in multiple lists', () => {
    const fts = [{ session_id: 'x' }];
    const emb = [{ session_id: 'x' }];
    const turn = [{ session_id: 'y' }];
    const scores = rrfFusion(fts, emb, turn);
    assert.ok(scores.get('x') > scores.get('y'));
  });

  it('falls back to .id when .session_id missing', () => {
    const fts = [{ id: '123' }];
    const scores = rrfFusion(fts, [], []);
    assert.ok(scores.has('123'));
  });

  it('handles null/undefined items gracefully', () => {
    const fts = [null, undefined, { session_id: 'a' }];
    // Should not throw
    const scores = rrfFusion(fts, [], []);
    assert.ok(scores.size >= 0);
  });
});

describe('timeDecay', () => {
  it('returns ~1 for very recent dates', () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    const score = timeDecay(recent);
    assert.ok(score > 0.9);
  });

  it('returns ~0.5 at midpoint', () => {
    const midpoint = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const score = timeDecay(midpoint, 45);
    assert.ok(score > 0.4 && score < 0.6, `Expected ~0.5, got ${score}`);
  });

  it('returns ~0 for very old dates', () => {
    const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const score = timeDecay(old);
    assert.ok(score < 0.1);
  });

  it('returns 0.5 for null/undefined input', () => {
    assert.equal(timeDecay(null), 0.5);
    assert.equal(timeDecay(undefined), 0.5);
  });

  it('returns 0.5 for invalid date string', () => {
    assert.equal(timeDecay('not-a-date'), 0.5);
  });

  it('accepts Date object', () => {
    const score = timeDecay(new Date());
    assert.ok(score > 0.9);
  });
});

describe('accessScore', () => {
  it('returns 0 for zero access count', () => {
    assert.equal(accessScore(0, new Date().toISOString()), 0);
  });

  it('returns 0 for null last accessed', () => {
    assert.equal(accessScore(5, null), 0);
  });

  it('returns positive for recent access', () => {
    const score = accessScore(3, new Date().toISOString());
    assert.ok(score > 0);
  });

  it('decays with time since last access', () => {
    const recent = accessScore(3, new Date().toISOString());
    const old = accessScore(3, new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString());
    assert.ok(recent > old);
  });
});

describe('hybridRank', () => {
  it('returns empty for empty inputs', () => {
    const result = hybridRank([], [], []);
    assert.equal(result.length, 0);
  });

  it('respects limit', () => {
    const fts = Array.from({ length: 20 }, (_, i) => ({
      session_id: `s${i}`, started_at: new Date().toISOString(),
      summary_text: 'test', structured_summary: { title: `t${i}` },
    }));
    const result = hybridRank(fts, [], [], { limit: 3 });
    assert.equal(result.length, 3);
  });

  it('applies entity boost', () => {
    const fts = [
      { session_id: 'a', started_at: new Date().toISOString() },
      { session_id: 'b', started_at: new Date().toISOString() },
    ];
    const entityMap = new Map([['a', 1.0]]);
    const result = hybridRank(fts, [], [], { limit: 2, entityScoreBySession: entityMap });
    assert.equal(result[0].session_id, 'a'); // boosted
  });

  it('attaches _score, _rrf, _timeDecay, _access, _entityScore, _trustScore, _openLoopBoost', () => {
    const fts = [{ session_id: 'x', started_at: new Date().toISOString() }];
    const [r] = hybridRank(fts, [], [], { limit: 1 });
    assert.ok('_score' in r);
    assert.ok('_rrf' in r);
    assert.ok('_timeDecay' in r);
    assert.ok('_access' in r);
    assert.ok('_entityScore' in r);
    assert.ok('_trustScore' in r);
    assert.ok('_trustMultiplier' in r);
    assert.ok('_openLoopBoost' in r);
  });

  it('propagates matched_turn_text from turn results', () => {
    const fts = [{ session_id: 'a', started_at: new Date().toISOString() }];
    const turns = [{ session_id: 'a', matched_turn_text: 'hello world', matched_turn_index: 3 }];
    const [r] = hybridRank(fts, [], turns, { limit: 1 });
    assert.equal(r.matched_turn_text, 'hello world');
    assert.equal(r.matched_turn_index, 3);
  });

  it('trust multiplier: high trust ranks above low trust', () => {
    const fts = [
      { session_id: 'high', started_at: new Date().toISOString(), trust_score: 0.9 },
      { session_id: 'low', started_at: new Date().toISOString(), trust_score: 0.1 },
    ];
    const result = hybridRank(fts, [], [], { limit: 2 });
    assert.equal(result[0].session_id, 'high');
    assert.equal(result[1].session_id, 'low');
    assert.ok(result[0]._trustMultiplier > result[1]._trustMultiplier);
  });

  it('trust default 0.5 is neutral (multiplier = 1.0)', () => {
    const fts = [{ session_id: 'x', started_at: new Date().toISOString() }];
    const [r] = hybridRank(fts, [], [], { limit: 1 });
    assert.equal(r._trustScore, 0.5);
    assert.equal(r._trustMultiplier, 1.0);
  });

  it('open-loop boost: session with open loops scores higher', () => {
    const now = new Date().toISOString();
    const fts = [
      { session_id: 'with_ol', started_at: now },
      { session_id: 'no_ol', started_at: now },
    ];
    const olSet = new Set(['with_ol']);
    const result = hybridRank(fts, [], [], { limit: 2, openLoopSet: olSet });
    assert.equal(result[0].session_id, 'with_ol');
    assert.ok(result[0]._openLoopBoost > 0);
    assert.equal(result[1]._openLoopBoost, 0);
  });

  it('open-loop weight=0 has no effect', () => {
    const now = new Date().toISOString();
    const fts = [{ session_id: 'a', started_at: now }];
    const olSet = new Set(['a']);
    const [r] = hybridRank(fts, [], [], {
      limit: 1,
      openLoopSet: olSet,
      weights: { openLoop: 0 },
    });
    assert.equal(r._openLoopBoost, 0);
  });
});
