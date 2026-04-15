'use strict';

// ---------------------------------------------------------------------------
// rrfFusion — Reciprocal Rank Fusion across 3 result lists
// ---------------------------------------------------------------------------

function rrfFusion(ftsResults = [], embResults = [], turnResults = [], K = 60) {
  const scores = new Map();

  // M3 fix: fallback to .id when .session_id missing (FTS returns .id)
  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i];
    if (!r) continue;
    const id = r.session_id || String(r.id);
    if (id) scores.set(id, (scores.get(id) || 0) + 1 / (K + i + 1));
  }

  for (let i = 0; i < embResults.length; i++) {
    const r = embResults[i];
    if (!r) continue;
    const id = r.session_id || String(r.id);
    if (id) scores.set(id, (scores.get(id) || 0) + 1 / (K + i + 1));
  }

  for (let i = 0; i < turnResults.length; i++) {
    const r = turnResults[i];
    if (!r) continue;
    const id = r.session_id || String(r.id);
    if (id) scores.set(id, (scores.get(id) || 0) + 1 / (K + i + 1));
  }

  return scores;
}

// ---------------------------------------------------------------------------
// timeDecay — sigmoid decay based on age in days
// ---------------------------------------------------------------------------

function timeDecay(startedAt, midpointDays = 45, steepness = 0.05, nowMs = Date.now()) {
  if (!startedAt) return 0.5;
  const dt = typeof startedAt === 'string' ? new Date(startedAt) : startedAt;
  if (isNaN(dt.getTime())) return 0.5;

  const ageDays = (nowMs - dt.getTime()) / (1000 * 60 * 60 * 24);
  return 1 / (1 + Math.exp(steepness * (ageDays - midpointDays)));
}

// ---------------------------------------------------------------------------
// accessScore — exponential decay on access recency (30-day half-life)
// ---------------------------------------------------------------------------

function accessScore(accessCount, lastAccessedAt, nowMs = Date.now()) {
  if (!accessCount || accessCount <= 0) return 0;
  if (!lastAccessedAt) return 0;

  const dt = typeof lastAccessedAt === 'string' ? new Date(lastAccessedAt) : lastAccessedAt;
  if (isNaN(dt.getTime())) return 0;

  const daysSince = (nowMs - dt.getTime()) / (1000 * 60 * 60 * 24);
  return accessCount * Math.exp(-0.693 * daysSince / 30);
}

// ---------------------------------------------------------------------------
// hybridRank — combine all signals into final ranked list
//
// Scoring order:
//   1. rawBase = rrf * normRrf + timeDecay * td + access * as
//   2. base = min(1, rawBase)
//   3. trustMultiplier = 0.5 + (trust_score ?? 0.5)        [0.5–1.5]
//   4. trustedBase = base * trustMultiplier
//   5. withOpenLoop = min(1, trustedBase + openLoop boost)
//   6. finalScore = min(1, withOpenLoop + entityBoost * entitySc * (1 - withOpenLoop))
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHTS = {
  rrf: 0.65,
  timeDecay: 0.25,
  access: 0.10,
  entityBoost: 0.18,
  openLoop: 0.08,
};

function hybridRank(ftsResults, embResults, turnResults, opts = {}) {
  const {
    limit = 5,
    weights = {},
    entityScoreBySession = new Map(),
    openLoopSet = new Set(),
  } = opts;

  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const nowMs = opts.nowMs ?? Date.now();

  // Build allResults map: session_id → result object
  const allResults = new Map();

  // M3 fix: use session_id || id as key consistently
  const _key = (r) => r ? (r.session_id || String(r.id || '')) : '';
  for (const r of (ftsResults || [])) {
    if (!r) continue;
    const k = _key(r);
    if (k && !allResults.has(k)) allResults.set(k, { ...r, session_id: k });
  }
  for (const r of (embResults || [])) {
    if (!r) continue;
    const k = _key(r);
    if (k && !allResults.has(k)) allResults.set(k, { ...r, session_id: k });
  }
  for (const r of (turnResults || [])) {
    if (!r) continue;
    const k = _key(r);
    if (k && allResults.has(k)) {
      const existing = allResults.get(k);
      existing.matched_turn_text = r.matched_turn_text;
      existing.matched_turn_index = r.matched_turn_index;
    } else if (k) {
      allResults.set(k, { ...r, session_id: k });
    }
  }

  if (allResults.size === 0) return [];

  // Adaptive K
  const maxLen = Math.max(
    (ftsResults || []).length,
    (embResults || []).length,
    (turnResults || []).length,
  );
  const K = Math.max(20, Math.floor(maxLen / 2)) || 30;

  // RRF scores
  const rrfScores = rrfFusion(ftsResults || [], embResults || [], turnResults || [], K);

  // Normalization: theoretical max = listCount / (K + 1)
  const listCount = (turnResults && turnResults.length > 0 ? 3 : 2);
  const maxRrf = listCount / (K + 1);

  // Score each session
  const scored = [];
  for (const [sessionId, result] of allResults) {
    const rawRrf = rrfScores.get(sessionId) || 0;
    const normRrf = maxRrf > 0 ? rawRrf / maxRrf : 0;

    const td = timeDecay(result.started_at, 45, 0.05, nowMs);

    const accessEff = accessScore(
      result.access_count || 0,
      result.last_accessed_at,
      nowMs,
    );
    const as = 1 - Math.exp(-accessEff / 5);

    // Step 1–2: base score
    const rawBase = w.rrf * normRrf + w.timeDecay * td + w.access * as;
    const base = Math.min(1, rawBase);

    // Step 3–4: trust multiplier (read from result row)
    const trustSc = result.trust_score ?? 0.5;
    const trustMultiplier = 0.5 + trustSc;
    const trustedBase = Math.min(1, base * trustMultiplier);

    // Step 5: open-loop boost
    const olBoost = openLoopSet.has(sessionId) ? w.openLoop : 0;
    const withOpenLoop = Math.min(1, trustedBase + olBoost);

    // Step 6: entity boost
    const entitySc = entityScoreBySession.get(sessionId) || 0;
    const finalScore = Math.min(1, withOpenLoop + w.entityBoost * entitySc * (1 - withOpenLoop));

    scored.push({
      ...result,
      _score: finalScore,
      _rrf: normRrf,
      _timeDecay: td,
      _access: as,
      _entityScore: entitySc,
      _trustScore: trustSc,
      _trustMultiplier: trustMultiplier,
      _openLoopBoost: olBoost,
    });
  }

  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { rrfFusion, timeDecay, accessScore, hybridRank };
