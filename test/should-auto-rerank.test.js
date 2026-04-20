'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { shouldAutoRerank } = require('../core/aquifer');

const defaultAuto = {
  enabled: true,
  modes: ['hybrid'],
  minQueryChars: 6,
  minQueryTokens: 2,
  minResults: 2,
  maxResults: 12,
  maxTopScoreGap: 0.08,
  alwaysWhenEntities: true,
  ftsMinResults: 5,
};

function ranked(scores) {
  return scores.map((s, i) => ({ session_id: `s${i}`, _score: s }));
}

describe('shouldAutoRerank', () => {
  it('does not fire when auto is disabled even with otherwise good signals', () => {
    const r = shouldAutoRerank({
      query: 'a longer query with many tokens',
      mode: 'hybrid',
      ranked: ranked([0.9, 0.85, 0.7]),
      hasEntities: false,
      autoTrigger: { ...defaultAuto, enabled: false },
    });
    assert.equal(r.apply, false);
    assert.equal(r.reason, 'auto_disabled');
  });

  it('fires immediately when entities are present (alwaysWhenEntities=true)', () => {
    const r = shouldAutoRerank({
      query: 'X',  // even short query is OK with entities
      mode: 'hybrid',
      ranked: ranked([0.9]),  // even tiny shortlist
      hasEntities: true,
      autoTrigger: defaultAuto,
    });
    assert.equal(r.apply, true);
    assert.equal(r.reason, 'entities_present');
  });

  it('skips when shortlist below minResults', () => {
    const r = shouldAutoRerank({
      query: 'long enough query string',
      mode: 'hybrid',
      ranked: ranked([0.9]),
      hasEntities: false,
      autoTrigger: defaultAuto,
    });
    assert.equal(r.apply, false);
    assert.equal(r.reason, 'too_few_results');
  });

  it('skips when shortlist above maxResults', () => {
    const r = shouldAutoRerank({
      query: 'long enough query string',
      mode: 'hybrid',
      ranked: ranked(new Array(20).fill(0.5)),
      hasEntities: false,
      autoTrigger: defaultAuto,
    });
    assert.equal(r.apply, false);
    assert.equal(r.reason, 'too_many_results');
  });

  it('skips when query is too short and too few tokens', () => {
    const r = shouldAutoRerank({
      query: 'hi',
      mode: 'hybrid',
      ranked: ranked([0.9, 0.7]),
      hasEntities: false,
      autoTrigger: defaultAuto,
    });
    assert.equal(r.apply, false);
    assert.equal(r.reason, 'query_too_short');
  });

  it('fires when top1/top2 gap is close (mixed signals)', () => {
    const r = shouldAutoRerank({
      query: 'hello world this is a query',
      mode: 'hybrid',
      ranked: ranked([0.82, 0.78, 0.5]),  // gap 0.04 < 0.08
      hasEntities: false,
      autoTrigger: defaultAuto,
    });
    assert.equal(r.apply, true);
    assert.equal(r.reason, 'top_score_gap_close');
  });

  it('skips when top1/top2 gap is wide (clear winner)', () => {
    const r = shouldAutoRerank({
      query: 'hello world this is a query',
      mode: 'hybrid',
      ranked: ranked([0.95, 0.5, 0.4]),  // gap 0.45 > 0.08
      hasEntities: false,
      autoTrigger: defaultAuto,
    });
    assert.equal(r.apply, false);
    assert.equal(r.reason, 'top_score_gap_wide');
  });

  it('fires on FTS-only mode when shortlist is wide enough', () => {
    const r = shouldAutoRerank({
      query: 'long enough query string',
      mode: 'fts',
      ranked: ranked([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]),  // 7 > ftsMinResults=5
      hasEntities: false,
      autoTrigger: defaultAuto,
    });
    assert.equal(r.apply, true);
    assert.equal(r.reason, 'fts_wide_shortlist');
  });

  it('skips FTS-only when shortlist is narrow (no rerank value)', () => {
    const r = shouldAutoRerank({
      query: 'long enough query string',
      mode: 'fts',
      ranked: ranked([0.9, 0.8, 0.7]),  // 3 <= ftsMinResults=5
      hasEntities: false,
      autoTrigger: defaultAuto,
    });
    assert.equal(r.apply, false);
    assert.equal(r.reason, 'fts_shortlist_too_narrow');
  });

  it('skips when mode not in autoTrigger.modes', () => {
    const r = shouldAutoRerank({
      query: 'long enough query string',
      mode: 'vector',  // not in default modes ['hybrid']
      ranked: ranked([0.9, 0.85, 0.7]),
      hasEntities: false,
      autoTrigger: defaultAuto,
    });
    assert.equal(r.apply, false);
    assert.equal(r.reason, 'mode_not_in_autotrigger_modes');
  });

  it('respects custom autoTrigger.modes including vector', () => {
    const r = shouldAutoRerank({
      query: 'long enough query string',
      mode: 'vector',
      ranked: ranked([0.82, 0.78, 0.7]),
      hasEntities: false,
      autoTrigger: { ...defaultAuto, modes: ['hybrid', 'vector'] },
    });
    assert.equal(r.apply, true);
    assert.equal(r.reason, 'top_score_gap_close');
  });

  it('alwaysWhenEntities=false drops entities to normal gating', () => {
    const r = shouldAutoRerank({
      query: 'x',  // too short
      mode: 'hybrid',
      ranked: ranked([0.9]),
      hasEntities: true,  // entities present but...
      autoTrigger: { ...defaultAuto, alwaysWhenEntities: false },
    });
    // Falls through to normal gating: too_few_results / query_too_short
    assert.equal(r.apply, false);
    assert.ok(['too_few_results', 'query_too_short'].includes(r.reason));
  });
});
