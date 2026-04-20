'use strict';

// aquifer.insights.* — higher-order observations distilled from sessions.
//
// Insight types: preference / pattern / frustration / workflow.
// Recall blends semantic similarity (vector), importance, and recency
// (linear decay over recencyWindowDays, default 90).
//
// Lifecycle is EXPLICIT — no read-time "auto-stale". Statuses:
//   'active'     — returned by recall by default
//   'stale'      — set via markStale(id); recall excludes unless includeStale
//   'superseded' — set via supersede(oldId, newId); excluded unless includeStale
// The scripts/extract-insights-from-recent-sessions.js cron job is the
// only thing that typically calls supersede() (when a newer extraction run
// fully covers the old evidence).

const crypto = require('crypto');
const { ok, err } = require('./errors');
const { normalizeEntityName } = require('./entity');

const VALID_TYPES = new Set(['preference', 'pattern', 'frustration', 'workflow']);

const DEFAULT_RECALL_WEIGHTS = Object.freeze({
  semantic: 0.65,
  importance: 0.25,
  recency: 0.10,
});

const DEFAULT_DEDUP = Object.freeze({
  mode: 'off',
  cosineThreshold: 0.88,
  closeBandFrom: 0.85,
});

const VALID_DEDUP_MODES = new Set(['off', 'shadow', 'enforce']);

// Recency linear decay horizon — an insight is treated as "fully recent" at
// creation (age=0) and "zero recency" at age >= recencyWindowDays. Beyond,
// recency contribution is clamped to 0 rather than going negative. Configurable
// via createAquifer({ insights: { recencyWindowDays } }).
const DEFAULT_RECENCY_WINDOW_DAYS = 90;

function defaultIdempotencyKey({
  tenantId, agentId, type, title, body, sourceSessionIds, evidenceWindow,
}) {
  const sorted = (sourceSessionIds || []).slice().sort().join('|');
  const winFrom = evidenceWindow && evidenceWindow.from ? new Date(evidenceWindow.from).toISOString() : '';
  const winTo = evidenceWindow && evidenceWindow.to ? new Date(evidenceWindow.to).toISOString() : '';
  // Hash must include body + window so legitimate revisions (same sessions but
  // tightened body, or extended window) get a new key and replace the old row
  // via supersede, not get swallowed as a duplicate.
  return crypto.createHash('sha256')
    .update(`${tenantId}|${agentId}|${type}|${title}|${body || ''}|${sorted}|${winFrom}|${winTo}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Canonical identity helpers (Phase 2 C1)
//
// Two-layer identity:
//   canonical_key_v2 — "which claim is this" (type + canonicalClaim + entitySet)
//   idempotency_key  — "which revision of that claim" (legacy, unchanged)
//
// canonicalClaim is produced by the extractor LLM (a normalized declarative
// claim without rhetoric/examples/time words). Title/body/sessions/window
// are revision-level and stay out of canonical_key_v2.
// ---------------------------------------------------------------------------

function normalizeCanonicalClaim(text) {
  if (typeof text !== 'string') return '';

  let s = text.normalize('NFKC');
  s = s.toLowerCase();
  s = s.replace(/\s+/g, ' ');
  s = s.trim();
  s = s.replace(/^[\s\-_.,;:!?'"()\[\]{}]+/, '');
  s = s.replace(/[\s\-_.,;:!?'"()\[\]{}]+$/, '');

  return s;
}

function normalizeBody(text) {
  return normalizeCanonicalClaim(text);
}

function normalizeEntitySet(entities) {
  if (!Array.isArray(entities) || entities.length === 0) return '';

  return [...new Set(
    entities
      .map(entity => normalizeEntityName(entity))
      .filter(Boolean)
  )]
    .sort()
    .join('|');
}

function defaultCanonicalKey({ tenantId, agentId, type, canonicalClaim, entities }) {
  return crypto.createHash('sha256')
    .update(`${tenantId ?? ''}|${agentId ?? ''}|${type ?? ''}|${normalizeCanonicalClaim(canonicalClaim)}|${normalizeEntitySet(entities)}`)
    .digest('hex');
}

// Parse the upper bound of a tstzrange returned by node-postgres as a raw
// string (default mapping when range types aren't explicitly parsed). Accepts
// the forms `[lower,upper)` / `(lower,upper]` / infinity sentinels.
function parseUpperFromRange(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/^[[(]([^,]*),([^)\]]*)[\])]$/);
  if (!m) return null;
  const upper = m[2].trim().replace(/^"|"$/g, '');
  if (!upper || upper === 'infinity') return null;
  const d = new Date(upper);
  return Number.isFinite(d.getTime()) ? d : null;
}

// Revision-level idempotency key: same claim (canonicalKeyV2) + same body +
// same source sessions + same evidence window = duplicate. Body tightening or
// window extension produces a new revision (old one is superseded).
function revisionIdempotencyKey({ canonicalKeyV2, body, sourceSessionIds, fromIso, toIso }) {
  const sorted = (sourceSessionIds || []).slice().sort().join('|');
  return crypto.createHash('sha256')
    .update(`${canonicalKeyV2}|${normalizeBody(body)}|${sorted}|${fromIso || ''}|${toIso || ''}`)
    .digest('hex');
}

function vecToPgLiteral(v) {
  if (!Array.isArray(v) || v.length === 0) return null;
  return `[${v.join(',')}]`;
}

function truncate(input, limit) {
  if (typeof input !== 'string') return '';
  if (!Number.isFinite(limit) || limit < 0) return '';
  return input.length <= limit ? input : input.slice(0, limit);
}

function truncateNormalized(input, limit) {
  return truncate(normalizeBody(input), limit);
}

function resolveDedupConfig(dedup, embedFn) {
  let resolved;
  if (dedup === true) {
    resolved = { ...DEFAULT_DEDUP, mode: 'enforce' };
  } else if (dedup === false || dedup === undefined) {
    resolved = { ...DEFAULT_DEDUP };
  } else if (dedup && typeof dedup === 'object') {
    resolved = { ...DEFAULT_DEDUP, ...dedup };
  } else {
    resolved = { ...DEFAULT_DEDUP };
  }

  const rawMode = typeof resolved.mode === 'string' ? resolved.mode.trim().toLowerCase() : resolved.mode;
  if (!VALID_DEDUP_MODES.has(rawMode)) {
    console.warn(`[aquifer] insights dedup: invalid mode ${JSON.stringify(resolved.mode)}; coercing to 'off'`);
    resolved.mode = 'off';
  } else {
    resolved.mode = rawMode;
  }

  const envMode = process.env.AQUIFER_INSIGHTS_DEDUP_MODE;
  if (typeof envMode === 'string') {
    const normalizedEnvMode = envMode.trim().toLowerCase();
    if (VALID_DEDUP_MODES.has(normalizedEnvMode)) {
      resolved.mode = normalizedEnvMode;
    }
  }

  // Reject non-numeric sentinels (null, bool, objects) BEFORE Number()
  // coerces them to 0 — 0 would silently become a "merge everything"
  // threshold in enforce mode.
  let cosineThreshold;
  if (resolved.cosineThreshold === null || resolved.cosineThreshold === undefined
      || typeof resolved.cosineThreshold === 'boolean') {
    console.warn(`[aquifer] insights dedup: invalid cosineThreshold ${JSON.stringify(resolved.cosineThreshold)}; defaulting to 0.88`);
    cosineThreshold = DEFAULT_DEDUP.cosineThreshold;
  } else {
    cosineThreshold = Number(resolved.cosineThreshold);
    if (!Number.isFinite(cosineThreshold)) {
      console.warn('[aquifer] insights dedup: invalid cosineThreshold; defaulting to 0.88');
      cosineThreshold = DEFAULT_DEDUP.cosineThreshold;
    } else if (cosineThreshold < 0.75 || cosineThreshold > 0.95) {
      const clamped = Math.max(0, Math.min(1, cosineThreshold));
      console.warn(`[aquifer] insights dedup: cosineThreshold ${cosineThreshold} outside recommended [0.75,0.95]; using ${clamped}`);
      cosineThreshold = (cosineThreshold >= 0 && cosineThreshold <= 1) ? cosineThreshold : clamped;
    }
  }
  resolved.cosineThreshold = cosineThreshold;

  let closeBandFrom;
  if (resolved.closeBandFrom === null || resolved.closeBandFrom === undefined
      || typeof resolved.closeBandFrom === 'boolean') {
    console.warn(`[aquifer] insights dedup: invalid closeBandFrom ${JSON.stringify(resolved.closeBandFrom)}; defaulting to 0.85`);
    closeBandFrom = DEFAULT_DEDUP.closeBandFrom;
  } else {
    closeBandFrom = Number(resolved.closeBandFrom);
    if (!Number.isFinite(closeBandFrom)) {
      console.warn('[aquifer] insights dedup: invalid closeBandFrom; defaulting to 0.85');
      closeBandFrom = DEFAULT_DEDUP.closeBandFrom;
    }
  }
  if (closeBandFrom >= resolved.cosineThreshold) {
    const adjusted = Math.max(0, resolved.cosineThreshold - 0.03);
    console.warn(`[aquifer] insights dedup: closeBandFrom ${closeBandFrom} must be below cosineThreshold ${resolved.cosineThreshold}; using ${adjusted}`);
    closeBandFrom = adjusted;
  }
  resolved.closeBandFrom = closeBandFrom;

  if (resolved.mode !== 'off') {
    console.log(`[aquifer] insights dedup: mode=${resolved.mode} threshold=${resolved.cosineThreshold} close_band_from=${resolved.closeBandFrom}`);
    if (!embedFn) {
      console.warn('[aquifer] insights dedup: embedFn unavailable; semantic dedup disabled at runtime');
    }
  }

  return Object.freeze(resolved);
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    insightType: row.insight_type,
    title: row.title,
    body: row.body,
    sourceSessionIds: row.source_session_ids || [],
    evidenceWindow: row.evidence_window,  // raw tstzrange string from PG
    importance: (row.importance !== null && row.importance !== undefined) ? Number(row.importance) : null,
    status: row.status,
    supersededBy: (row.superseded_by !== null && row.superseded_by !== undefined) ? Number(row.superseded_by) : null,
    idempotencyKey: row.idempotency_key || null,
    canonicalKeyV2: row.canonical_key_v2 || null,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    score: (row._score !== null && row._score !== undefined) ? Number(row._score) : undefined,
    semanticScore: (row._semantic_score !== null && row._semantic_score !== undefined) ? Number(row._semantic_score) : undefined,
  };
}

function createInsights({ pool, schema, defaultTenantId, embedFn, recallWeights, recencyWindowDays, dedup }) {
  if (!pool) throw new Error('createInsights: pool is required');
  if (!schema) throw new Error('createInsights: schema is required');

  const weights = { ...DEFAULT_RECALL_WEIGHTS, ...(recallWeights || {}) };
  const recencyWindow = Number.isFinite(recencyWindowDays) && recencyWindowDays > 0
    ? recencyWindowDays : DEFAULT_RECENCY_WINDOW_DAYS;
  const tbl = `${schema}.insights`;
  const dedupConfig = resolveDedupConfig(dedup, embedFn);

  if (dedupConfig.mode !== 'off') {
    pool.query(
      `SELECT count(*)::int AS n FROM ${tbl}
        WHERE canonical_key_v2 IS NULL AND status = 'active'`
    ).then(r => {
      const n = r && r.rows && r.rows[0] ? Number(r.rows[0].n) : 0;
      if (n > 0) {
        console.warn(
          `[aquifer] insights: ${n} active rows with canonical_key_v2 IS NULL. `
          + 'Run scripts/backfill-canonical-key.js to include them in canonical dedup.'
        );
      }
    }).catch(() => {
      // non-fatal
    });
  }

  // -------------------------------------------------------------------------
  // commitInsight
  // -------------------------------------------------------------------------
  async function commitInsight(input = {}) {
    try {
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const agentId = input.agentId;
      if (!agentId) return err('AQ_INVALID_INPUT', 'agentId is required');
      const type = input.type;
      if (!VALID_TYPES.has(type)) return err('AQ_INVALID_INPUT', `type must be one of ${[...VALID_TYPES].join('|')}`);
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title) return err('AQ_INVALID_INPUT', 'title must be non-empty string');
      const body = typeof input.body === 'string' ? input.body.trim() : '';
      if (!body) return err('AQ_INVALID_INPUT', 'body must be non-empty string');
      const sourceSessionIds = Array.isArray(input.sourceSessionIds) ? input.sourceSessionIds : [];
      if (!sourceSessionIds.length) return err('AQ_INVALID_INPUT', 'sourceSessionIds must contain at least one id');
      const win = input.evidenceWindow || {};
      if (!win.from || !win.to) return err('AQ_INVALID_INPUT', 'evidenceWindow.from and .to are required');
      const fromIso = new Date(win.from).toISOString();
      const toIso = new Date(win.to).toISOString();
      if (!Number.isFinite(new Date(fromIso).getTime()) || !Number.isFinite(new Date(toIso).getTime())) {
        return err('AQ_INVALID_INPUT', 'evidenceWindow.from / .to must parse to timestamps');
      }
      const importance = (input.importance !== null && input.importance !== undefined) ? Number(input.importance) : 0.5;
      if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
        return err('AQ_INVALID_INPUT', 'importance must be in [0,1]');
      }
      let metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};

      // ---------------------------------------------------------------------
      // Phase 2 C1: two-layer identity.
      //   canonicalKeyV2 = "which claim" (type + canonicalClaim + entitySet)
      //   idempotencyKey = "which revision of that claim"
      // canonicalClaim comes from the extractor LLM; when absent we fall back
      // to title and flag dedupQuality so callers know the dedupe is weak.
      // ---------------------------------------------------------------------
      const canonicalClaim = typeof input.canonicalClaim === 'string' ? input.canonicalClaim : '';
      const entities = Array.isArray(input.entities) ? input.entities : [];
      const canonicalKeyV2 = input.canonicalKey
        || defaultCanonicalKey({
          tenantId, agentId, type,
          canonicalClaim: canonicalClaim || title,
          entities,
        });

      if (!input.canonicalClaim && !input.canonicalKey) {
        metadata = { ...metadata, dedupQuality: 'title_fallback' };
      }

      const idempotencyKey = input.idempotencyKey
        || revisionIdempotencyKey({
          canonicalKeyV2, body, sourceSessionIds, fromIso, toIso,
        });

      // Step A — revision dedupe. Exact same claim/body/sessions/window.
      const existing = await pool.query(
        `SELECT * FROM ${tbl} WHERE idempotency_key = $1 LIMIT 1`,
        [idempotencyKey]
      );
      if (existing.rowCount > 0) return ok({ insight: mapRow(existing.rows[0]), duplicate: true });

      // Step B — canonical lookup: is this claim already active? If so, decide
      // between stale replay (incoming window older than active) vs revision
      // (incoming same or newer, body/window differ enough that Step A missed).
      const canonLookup = await pool.query(
        `SELECT * FROM ${tbl}
          WHERE tenant_id = $1
            AND agent_id = $2
            AND insight_type = $3
            AND canonical_key_v2 = $4
            AND status = 'active'
          ORDER BY created_at DESC
          LIMIT 1`,
        [tenantId, agentId, type, canonicalKeyV2]
      );

      let toSupersede = null;
      if (canonLookup.rowCount > 0) {
        const activeRow = canonLookup.rows[0];
        const activeUpper = parseUpperFromRange(activeRow.evidence_window);
        // Rule 4 — stale replay: incoming evidence is older than what's
        // already active. Keep the active row, tell caller it's a duplicate.
        if (activeUpper && new Date(toIso).getTime() < activeUpper.getTime()) {
          return ok({ insight: mapRow(activeRow), duplicate: true });
        }
        // Rule 2/3 — revision: different revision key, incoming window is not
        // stale. Insert new and mark the previous active row as superseded.
        toSupersede = Number(activeRow.id);
      }

      let embedding = null;
      let embeddingReady = false;

      if (dedupConfig.mode !== 'off' && !toSupersede && embedFn) {
        // Embed the incoming title+body once. If this throws, the label
        // is genuinely 'embed_failed' — the candidate SELECT never ran.
        let embedFailed = false;
        try {
          const v = await embedFn([`${title}\n\n${body}`]);
          if (Array.isArray(v) && Array.isArray(v[0])) {
            embedding = vecToPgLiteral(v[0]);
          }
          embeddingReady = true;
        } catch {
          embedFailed = true;
          embeddingReady = true;
          metadata = { ...metadata, dedupSkipped: 'embed_failed' };
        }

        if (!embedFailed && embedding) {
          // Candidate lookup. If this throws (DB error), let it bubble
          // to the outer commitInsight try/catch → AQ_INTERNAL. Do NOT
          // mislabel it as embed_failed.
          const semanticLookup = await pool.query(
            `SELECT *, 1.0 - (embedding <=> $4::vector) AS cos_sim
               FROM ${tbl}
              WHERE tenant_id = $1
                AND agent_id = $2
                AND insight_type = $3
                AND status = 'active'
                AND embedding IS NOT NULL
              ORDER BY embedding <=> $4::vector
              LIMIT 1`,
            [tenantId, agentId, type, embedding]
          );

          if (semanticLookup.rowCount > 0) {
            const candidate = semanticLookup.rows[0];
            const cosine = Number(candidate.cos_sim);

            if (cosine >= dedupConfig.cosineThreshold) {
              const candidateUpper = parseUpperFromRange(candidate.evidence_window);
              const isStaleReplay = candidateUpper
                && new Date(toIso).getTime() < candidateUpper.getTime();

              if (dedupConfig.mode === 'enforce') {
                // Enforce path: stale-replay returns the candidate as
                // duplicate; otherwise supersede.
                if (isStaleReplay) {
                  return ok({ insight: mapRow(candidate), duplicate: true });
                }
                toSupersede = Number(candidate.id);
                metadata = {
                  ...metadata,
                  dedupVia: 'semantic',
                  dedupCandidate: { id: Number(candidate.id), cosine },
                };
              } else {
                // Shadow path: always insert the new row, always record
                // shadowMatch metadata. staleReplay flag tells reviewers
                // the enforce-mode twin would have returned duplicate
                // instead of superseding.
                metadata = {
                  ...metadata,
                  shadowMatch: {
                    candidateId: Number(candidate.id),
                    cosine,
                    threshold: dedupConfig.cosineThreshold,
                    candidateTitle: truncate(candidate.title, 200),
                    candidateBody: truncateNormalized(candidate.body, 200),
                    wouldSupersede: !isStaleReplay,
                    staleReplay: Boolean(isStaleReplay),
                    ranAt: new Date().toISOString(),
                  },
                };
              }
            } else if (cosine >= dedupConfig.closeBandFrom) {
              metadata = {
                ...metadata,
                dedupNear: {
                  candidateId: Number(candidate.id),
                  cosine,
                  threshold: dedupConfig.cosineThreshold,
                  closeBandFrom: dedupConfig.closeBandFrom,
                  candidateTitle: truncate(candidate.title, 200),
                  candidateBody: truncateNormalized(candidate.body, 200),
                },
              };
            }
          }
        }
      }

      // Optional embedding.
      if (embedFn && !embeddingReady) {
        try {
          const v = await embedFn([`${title}\n\n${body}`]);
          if (Array.isArray(v) && Array.isArray(v[0])) embedding = vecToPgLiteral(v[0]);
        } catch {
          // Embed failure is non-fatal — insight saved without semantic recall path.
        }
      }

      const evidenceRange = `[${fromIso},${toIso})`;
      const inserted = await pool.query(
        `INSERT INTO ${tbl}
          (tenant_id, agent_id, insight_type, title, body, source_session_ids,
           evidence_window, embedding, importance, status, idempotency_key,
           canonical_key_v2, metadata)
         VALUES ($1,$2,$3,$4,$5,$6, $7::tstzrange, $8::vector, $9, 'active', $10, $11, $12::jsonb)
         RETURNING *`,
        [tenantId, agentId, type, title, body, sourceSessionIds,
         evidenceRange, embedding, importance, idempotencyKey,
         canonicalKeyV2, JSON.stringify(metadata)]
      );
      const newRow = inserted.rows[0];

      // Best-effort supersede of the prior active revision. Insights are
      // eventually consistent — if the old row was already superseded by a
      // racing writer, log and continue without failing the new insert.
      if (toSupersede && Number(newRow.id) !== toSupersede) {
        try {
          await pool.query(
            `UPDATE ${tbl}
                SET status = 'superseded', superseded_by = $2, updated_at = now()
              WHERE id = $1 AND status = 'active'`,
            [toSupersede, Number(newRow.id)]
          );
        } catch {
          // swallow — new row is already persisted
        }
      }

      return ok({ insight: mapRow(newRow), duplicate: false });
    } catch (e) {
      if (/duplicate key/.test(e.message)) return err('AQ_CONFLICT', e.message);
      return err('AQ_INTERNAL', e.message);
    }
  }

  // -------------------------------------------------------------------------
  // recallInsights
  // -------------------------------------------------------------------------
  async function recallInsights(query, input = {}) {
    try {
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const agentId = input.agentId;
      if (!agentId) return err('AQ_INVALID_INPUT', 'agentId is required');
      const type = input.type || null;
      if (type && !VALID_TYPES.has(type)) {
        return err('AQ_INVALID_INPUT', `type must be one of ${[...VALID_TYPES].join('|')}`);
      }
      const limit = Math.max(1, Math.min(50, Number(input.limit) || 5));
      const minImportance = (input.minImportance !== null && input.minImportance !== undefined) ? Number(input.minImportance) : 0;
      const includeStale = input.includeStale === true;

      const where = ['tenant_id = $1', 'agent_id = $2', 'importance >= $3'];
      const params = [tenantId, agentId, minImportance];
      if (!includeStale) where.push(`status = 'active'`);
      if (type) {
        params.push(type);
        where.push(`insight_type = $${params.length}`);
      }

      // Empty query → blend importance × recency (linear decay over
      // recencyWindow days), no semantic component. Falls back to created_at
      // DESC as tiebreak so identical blended scores remain deterministic.
      if (!query || typeof query !== 'string' || !query.trim()) {
        params.push(recencyWindow);
        const winPos = params.length;
        params.push(weights.importance);
        const wImpPos = params.length;
        params.push(weights.recency);
        const wRecPos = params.length;
        params.push(limit);
        const r = await pool.query(
          `SELECT *,
            (
              $${wImpPos}::real * importance +
              $${wRecPos}::real * GREATEST(0, 1.0 - (extract(epoch FROM (now() - created_at)) / 86400.0) / $${winPos}::real)
            ) AS _score
           FROM ${tbl}
           WHERE ${where.join(' AND ')}
           ORDER BY _score DESC, created_at DESC
           LIMIT $${params.length}`,
          params
        );
        return ok({ rows: r.rows.map(mapRow) });
      }

      // Vector recall: requires embedFn.
      if (!embedFn) return err('AQ_DEPENDENCY', 'recallInsights with query requires embedFn');
      let queryVec;
      try {
        const v = await embedFn([query]);
        queryVec = vecToPgLiteral(v[0]);
      } catch (e) {
        return err('AQ_DEPENDENCY', `embedFn failed: ${e.message}`);
      }
      if (!queryVec) return err('AQ_DEPENDENCY', 'embedFn returned empty vector');

      params.push(queryVec);
      const vecPos = params.length;
      params.push(weights.semantic);
      const wSemPos = params.length;
      params.push(weights.importance);
      const wImpPos = params.length;
      params.push(weights.recency);
      const wRecPos = params.length;
      params.push(limit);
      const limitPos = params.length;

      params.push(recencyWindow);
      const winPos = params.length;
      const r = await pool.query(
        `WITH scored AS (
          SELECT *,
            1.0 - (embedding <=> $${vecPos}::vector) AS _semantic_score,
            extract(epoch FROM (now() - created_at)) / 86400.0 AS _age_days
          FROM ${tbl}
          WHERE embedding IS NOT NULL
            AND ${where.join(' AND ')}
        )
        SELECT *,
          (
            $${wSemPos}::real * GREATEST(0, _semantic_score) +
            $${wImpPos}::real * importance +
            $${wRecPos}::real * GREATEST(0, 1.0 - _age_days / $${winPos}::real)
          ) AS _score
        FROM scored
        ORDER BY _score DESC
        LIMIT $${limitPos}`,
        params
      );
      return ok({ rows: r.rows.map(mapRow) });
    } catch (e) {
      return err('AQ_INTERNAL', e.message);
    }
  }

  // -------------------------------------------------------------------------
  // markStale / supersede — explicit lifecycle (callers / scripts use these).
  // -------------------------------------------------------------------------
  async function markStale(insightId) {
    try {
      const id = Number(insightId);
      if (!Number.isInteger(id) || id <= 0) return err('AQ_INVALID_INPUT', 'insightId must be positive integer');
      const r = await pool.query(
        `UPDATE ${tbl} SET status='stale', updated_at=now()
         WHERE id=$1 AND status <> 'stale' RETURNING id, status`,
        [id]
      );
      if (r.rowCount === 0) return err('AQ_NOT_FOUND', `insight ${id} not found or already stale`);
      return ok({ id: Number(r.rows[0].id), status: r.rows[0].status });
    } catch (e) {
      return err('AQ_INTERNAL', e.message);
    }
  }

  async function supersede(oldId, newId) {
    try {
      const o = Number(oldId), n = Number(newId);
      if (!Number.isInteger(o) || !Number.isInteger(n)) return err('AQ_INVALID_INPUT', 'oldId/newId must be integers');
      if (o === n) return err('AQ_INVALID_INPUT', 'oldId and newId must differ (no self-supersede)');
      // Verify both exist and share tenant + agent. FK alone would allow a
      // caller with a cross-tenant id to form an illegal supersession chain.
      const vr = await pool.query(
        `SELECT id, tenant_id, agent_id FROM ${tbl} WHERE id = ANY($1)`,
        [[o, n]]
      );
      if (vr.rowCount < 2) return err('AQ_NOT_FOUND', `insight ${o} or ${n} not found`);
      const oldRow = vr.rows.find(r => Number(r.id) === o);
      const newRow = vr.rows.find(r => Number(r.id) === n);
      if (!oldRow || !newRow) return err('AQ_NOT_FOUND', `insight ${o} or ${n} not found`);
      if (oldRow.tenant_id !== newRow.tenant_id || oldRow.agent_id !== newRow.agent_id) {
        return err('AQ_CONFLICT', `supersede crosses tenant/agent: old=${oldRow.tenant_id}/${oldRow.agent_id}, new=${newRow.tenant_id}/${newRow.agent_id}`);
      }
      const r = await pool.query(
        `UPDATE ${tbl} SET status='superseded', superseded_by=$2, updated_at=now()
         WHERE id=$1 AND status <> 'superseded' RETURNING id, status, superseded_by`,
        [o, n]
      );
      if (r.rowCount === 0) return err('AQ_NOT_FOUND', `insight ${o} not found or already superseded`);
      return ok({ id: Number(r.rows[0].id), status: r.rows[0].status, supersededBy: Number(r.rows[0].superseded_by) });
    } catch (e) {
      return err('AQ_INTERNAL', e.message);
    }
  }

  return {
    commitInsight,
    recallInsights,
    markStale,
    supersede,
    _internal: { defaultIdempotencyKey, vecToPgLiteral, mapRow, weights, dedup: dedupConfig },
  };
}

module.exports = {
  createInsights,
  defaultIdempotencyKey,
  defaultCanonicalKey,
  normalizeCanonicalClaim,
  normalizeBody,
  normalizeEntitySet,
};
