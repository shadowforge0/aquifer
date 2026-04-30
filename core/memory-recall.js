'use strict';

const { resolveApplicableRecords } = require('./memory-bootstrap');
const { hybridRank } = require('./hybrid-rank');

const TYPE_RANK = {
  constraint: 80,
  preference: 70,
  state: 60,
  open_loop: 55,
  decision: 50,
  fact: 40,
  conclusion: 30,
  entity_note: 20,
};

const FEEDBACK_WEIGHT = {
  helpful: 0.15,
  confirm: 0.10,
  irrelevant: -0.20,
  scope_mismatch: -0.25,
  stale: -0.30,
  incorrect: -0.50,
};

const RETRIEVAL_TYPE_BOOST = 0.05;
const SIGNAL_PRIORITY = {
  linked_summary: 1,
  evidence_item: 2,
  memory_row: 3,
};

const TYPE_RANK_SQL = `
  CASE m.memory_type
    WHEN 'constraint' THEN 0.80
    WHEN 'preference' THEN 0.70
    WHEN 'state' THEN 0.60
    WHEN 'open_loop' THEN 0.55
    WHEN 'decision' THEN 0.50
    WHEN 'fact' THEN 0.40
    WHEN 'conclusion' THEN 0.30
    WHEN 'entity_note' THEN 0.20
    ELSE 0
  END`;

const TYPE_BOOST_SQL = `(${TYPE_RANK_SQL}) * ${RETRIEVAL_TYPE_BOOST}`;

function feedbackScoreSql(schema) {
  return `
    COALESCE((
      SELECT SUM(
        CASE f.feedback_type
          WHEN 'helpful' THEN 0.15
          WHEN 'confirm' THEN 0.10
          WHEN 'irrelevant' THEN -0.20
          WHEN 'scope_mismatch' THEN -0.25
          WHEN 'stale' THEN -0.30
          WHEN 'incorrect' THEN -0.50
          ELSE 0
        END
      )
      FROM ${schema}.feedback f
      WHERE f.tenant_id = $1
        AND f.target_kind = 'memory_record'
        AND f.target_id = m.id::text
    ), 0)`;
}

function textOf(record) {
  return [
    record.title,
    record.summary,
    record.contextKey || record.context_key,
    record.topicKey || record.topic_key,
  ].filter(Boolean).join(' ');
}

function getId(record) {
  return String(record.memoryId || record.memory_id || record.id || record.canonicalKey || record.canonical_key);
}

function parseTime(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : null;
}

function isWithinTime(record, asOf) {
  if (!asOf) return true;
  const at = Date.parse(asOf);
  if (!Number.isFinite(at)) return true;
  const validFrom = parseTime(record.validFrom || record.valid_from);
  const validTo = parseTime(record.validTo || record.valid_to);
  const staleAfter = parseTime(record.staleAfter || record.stale_after);
  if (validFrom !== null && validFrom > at) return false;
  if (validTo !== null && validTo <= at) return false;
  if (staleAfter !== null && staleAfter <= at) return false;
  return true;
}

function isActiveVisible(record, opts = {}) {
  const status = record.status || 'candidate';
  const visible = record.visibleInRecall ?? record.visible_in_recall;
  return status === 'active' && visible === true && isWithinTime(record, opts.asOf);
}

function activeScopeKeys(opts = {}) {
  if (Array.isArray(opts.activeScopePath) && opts.activeScopePath.length > 0) {
    return opts.activeScopePath.map(value => String(value)).filter(Boolean);
  }
  if (opts.activeScopeKey) return [String(opts.activeScopeKey)];
  return null;
}

function rankValue(record, key) {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortRecallRows(a, b) {
  const aSignalPriority = rankValue(a, 'signal_priority');
  const bSignalPriority = rankValue(b, 'signal_priority');
  if (bSignalPriority !== aSignalPriority) return bSignalPriority - aSignalPriority;

  const aTitleMatch = a.title_match === true ? 1 : 0;
  const bTitleMatch = b.title_match === true ? 1 : 0;
  if (bTitleMatch !== aTitleMatch) return bTitleMatch - aTitleMatch;

  const aScore = rankValue(a, 'recall_score') || rankValue(a, 'score');
  const bScore = rankValue(b, 'recall_score') || rankValue(b, 'score');
  if (bScore !== aScore) return bScore - aScore;

  const aAccepted = Date.parse(a.acceptedAt || a.accepted_at || '') || 0;
  const bAccepted = Date.parse(b.acceptedAt || b.accepted_at || '') || 0;
  if (bAccepted !== aAccepted) return bAccepted - aAccepted;

  return getId(a).localeCompare(getId(b));
}

function memoryRecallKey(row) {
  return String(row && (row.id || row.memory_id || row.memoryId || row.canonical_key || row.canonicalKey || ''));
}

function rankHybridMemoryRows(lexicalRows = [], embeddingRows = [], opts = {}) {
  const limit = Math.max(1, Math.min(50, opts.limit || 10));
  const rowsById = new Map();
  function remember(row, signal) {
    const id = memoryRecallKey(row);
    if (!id) return;
    const existing = rowsById.get(id);
    const next = existing ? { ...existing, ...row } : { ...row };
    const signals = new Set(existing && Array.isArray(existing._matchSignals) ? existing._matchSignals : []);
    signals.add(signal);
    next._matchSignals = [...signals];
    next.match_signal = signals.size > 1 ? 'memory_row_hybrid' : 'memory_row';
    delete next.signal_priority;
    rowsById.set(id, next);
  }
  for (const row of lexicalRows || []) remember(row, 'lexical');
  for (const row of embeddingRows || []) remember(row, 'semantic');

  function adapt(row) {
    const id = memoryRecallKey(row);
    return {
      ...row,
      session_id: id,
      started_at: row.accepted_at || row.observed_at || row.updated_at || row.created_at || row.started_at,
      trust_score: row.trust_score ?? 0.5,
    };
  }

  const fused = hybridRank(
    (lexicalRows || []).map(adapt),
    (embeddingRows || []).map(adapt),
    [],
    {
      limit: Math.max(limit, rowsById.size || limit),
      weights: { rrf: 0.82, timeDecay: 0.12, access: 0.06, entityBoost: 0, openLoop: 0 },
    },
  );

  const scored = fused.map(fusedRow => {
    const id = memoryRecallKey(fusedRow);
    const row = rowsById.get(id) || fusedRow;
    const rowScore = rankValue(row, 'recall_score') || rankValue(row, 'score') || rankValue(row, 'semantic_score') || rankValue(row, 'lexical_rank');
    const typeScore = rankValue(row, 'type_rank');
    const feedback = rankValue(row, 'feedback_score');
    const score = (0.82 * rankValue(fusedRow, '_score')) + (0.14 * Math.min(1, Math.max(0, rowScore))) + (0.02 * typeScore) + (0.02 * feedback);
    const ranked = {
      ...row,
      recall_score: score,
      score,
      _score: score,
      _rrf: fusedRow._rrf,
      _timeDecay: fusedRow._timeDecay,
      _access: fusedRow._access,
    };
    delete ranked.session_id;
    delete ranked.signal_priority;
    return ranked;
  });

  scored.sort((a, b) => {
    const aScore = rankValue(a, '_score');
    const bScore = rankValue(b, '_score');
    if (bScore !== aScore) return bScore - aScore;
    const aAccepted = Date.parse(a.accepted_at || a.acceptedAt || '') || 0;
    const bAccepted = Date.parse(b.accepted_at || b.acceptedAt || '') || 0;
    if (bAccepted !== aAccepted) return bAccepted - aAccepted;
    return memoryRecallKey(a).localeCompare(memoryRecallKey(b));
  });

  return scored.slice(0, limit);
}

function feedbackScore(record, feedbackEvents = []) {
  const id = getId(record);
  let score = 0;
  for (const event of feedbackEvents) {
    const targetId = String(event.targetId || event.target_id || '');
    if (targetId !== id) continue;
    const type = event.feedbackType || event.feedback_type || event.verdict;
    score += FEEDBACK_WEIGHT[type] || 0;
  }
  return score;
}

function lexicalScore(haystack, query) {
  if (haystack.includes(query)) return 1;
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const hits = tokens.filter(t => haystack.includes(t)).length;
  return hits / tokens.length;
}

function vecToStr(vec) {
  if (!vec || !Array.isArray(vec) || vec.length === 0) return null;
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) throw new Error(`Vector contains non-finite value at index ${i}`);
  }
  return `[${vec.join(',')}]`;
}

function recallMemoryRecords(records = [], query, opts = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) throw new Error('memory.recall(query): query must be a non-empty string');
  const limit = Math.max(1, Math.min(50, opts.limit || 10));
  const feedbackEvents = opts.feedbackEvents || [];
  const scopeFiltered = activeScopeKeys(opts)
    ? resolveApplicableRecords(
      records.filter(record => isActiveVisible(record, opts)),
      opts,
    )
    : records.filter(record => isActiveVisible(record, opts));

  return scopeFiltered
    .map(record => {
      const haystack = textOf(record).toLowerCase();
      const lexical = lexicalScore(haystack, q);
      const typeRank = ((TYPE_RANK[record.memoryType || record.memory_type] || 0) / 100) * RETRIEVAL_TYPE_BOOST;
      const feedback = feedbackScore(record, feedbackEvents);
      return {
        ...record,
        score: lexical + typeRank + feedback,
        signal_priority: SIGNAL_PRIORITY.memory_row,
        match_signal: 'memory_row',
        _debug: { lexical, typeRank, feedback },
      };
    })
    .filter(record => record._debug.lexical > 0 || opts.includeAll === true)
    .sort(sortRecallRows)
    .slice(0, limit);
}

function createMemoryRecall({ pool, schema, defaultTenantId }) {
  function applyCurrentMemoryFilters(where, params, opts = {}) {
    const scopeKeys = activeScopeKeys(opts);
    if (opts.scopeId) {
      params.push(opts.scopeId);
      where.push(`m.scope_id = $${params.length}`);
    }
    if (scopeKeys) {
      params.push(scopeKeys);
      where.push(`s.scope_key = ANY($${params.length}::text[])`);
    }
    if (opts.asOf) {
      params.push(opts.asOf);
      const at = `$${params.length}::timestamptz`;
      where.push(`(m.valid_from IS NULL OR m.valid_from <= ${at})`);
      where.push(`(m.valid_to IS NULL OR m.valid_to > ${at})`);
      where.push(`(m.stale_after IS NULL OR m.stale_after > ${at})`);
    }
    return scopeKeys;
  }

  async function recall(query, opts = {}) {
    const q = String(query || '').trim();
    if (!q) throw new Error('memory.recall(query): query must be a non-empty string');
    const tenantId = opts.tenantId || defaultTenantId;
    const limit = Math.max(1, Math.min(50, opts.limit || 10));
    const cfg = (opts.ftsConfig === 'zhcfg' || opts.ftsConfig === 'simple') ? opts.ftsConfig : 'simple';
    const scopeKeys = activeScopeKeys(opts);
    const fetchLimit = Math.max(limit, Math.min(200, scopeKeys ? limit * 4 : limit));
    const feedbackScoreExpr = feedbackScoreSql(schema);
    const params = [tenantId, q];
    const where = [
      `m.tenant_id = $1`,
      `m.status = 'active'`,
      `m.visible_in_recall = true`,
      `(m.search_tsv @@ plainto_tsquery('${cfg}', $2)
        OR m.title ILIKE '%' || $2 || '%'
        OR m.summary ILIKE '%' || $2 || '%'
        OR m.context_key ILIKE '%' || $2 || '%'
        OR m.topic_key ILIKE '%' || $2 || '%')`,
    ];
    applyCurrentMemoryFilters(where, params, opts);
    params.push(fetchLimit);
    const result = await pool.query(
      `SELECT
         m.*, s.scope_kind, s.scope_key, s.inheritance_mode AS scope_inheritance_mode,
         'memory_row'::text AS match_signal,
         ${SIGNAL_PRIORITY.memory_row}::int AS signal_priority,
         (m.title ILIKE '%' || $2 || '%') AS title_match,
         ts_rank(m.search_tsv, plainto_tsquery('${cfg}', $2)) AS lexical_rank,
         ${TYPE_BOOST_SQL} AS type_rank,
         ${feedbackScoreExpr} AS feedback_score,
         ts_rank(m.search_tsv, plainto_tsquery('${cfg}', $2))
           + ${TYPE_BOOST_SQL}
           + ${feedbackScoreExpr} AS recall_score
       FROM ${schema}.memory_records m
       JOIN ${schema}.scopes s ON s.id = m.scope_id
       WHERE ${where.join(' AND ')}
       ORDER BY
         title_match DESC,
         recall_score DESC,
         m.accepted_at DESC NULLS LAST,
         m.id ASC
       LIMIT $${params.length}`,
      params
    );
    const applicableRows = scopeKeys
      ? resolveApplicableRecords(result.rows, opts)
      : result.rows;
    return applicableRows
      .sort(sortRecallRows)
      .slice(0, limit);
  }

  async function recallViaEvidenceItems(query, opts = {}) {
    const q = String(query || '').trim();
    if (!q) throw new Error('memory.recall(query): query must be a non-empty string');
    const tenantId = opts.tenantId || defaultTenantId;
    const limit = Math.max(1, Math.min(50, opts.limit || 10));
    const scopeKeys = activeScopeKeys(opts);
    const fetchLimit = Math.max(limit, Math.min(200, scopeKeys ? limit * 4 : limit));
    const feedbackScoreExpr = feedbackScoreSql(schema);
    const params = [tenantId, q];
    const where = [
      `m.tenant_id = $1`,
      `m.status = 'active'`,
      `m.visible_in_recall = true`,
    ];
    applyCurrentMemoryFilters(where, params, opts);
    const queryVec = vecToStr(opts.queryVec);
    let vectorScoreExpr = '0';
    let evidencePredicate = `(ei.excerpt_text ILIKE '%' || $2 || '%'
             OR ei.search_tsv @@ plainto_tsquery('simple', $2))`;
    if (queryVec) {
      params.push(queryVec);
      const vecPos = params.length;
      vectorScoreExpr = `COALESCE(1.0 - (ei.embedding <=> $${vecPos}::vector), 0)`;
      evidencePredicate = opts.vectorOnly === true
        ? `ei.embedding IS NOT NULL`
        : `(${evidencePredicate} OR ei.embedding IS NOT NULL)`;
    }
    params.push(fetchLimit);
    const result = await pool.query(
      `WITH eligible_memories AS (
         SELECT m.*, s.scope_kind, s.scope_key, s.inheritance_mode AS scope_inheritance_mode
         FROM ${schema}.memory_records m
         JOIN ${schema}.scopes s ON s.id = m.scope_id
         WHERE ${where.join(' AND ')}
       ),
       evidence_hits AS (
         SELECT
           e.owner_id AS memory_id,
           MAX(
             CASE WHEN ei.excerpt_text ILIKE '%' || $2 || '%' THEN 1 ELSE 0 END
             + ts_rank(ei.search_tsv, plainto_tsquery('simple', $2))
             + similarity(ei.excerpt_text, $2)
             + ${vectorScoreExpr}
           ) AS evidence_score,
           MAX(ei.created_at) AS latest_evidence_at
         FROM ${schema}.evidence_items ei
         JOIN ${schema}.evidence_refs e
           ON e.tenant_id = ei.tenant_id
          AND e.evidence_item_id = ei.id
          AND e.owner_kind = 'memory_record'
         JOIN eligible_memories em ON em.id = e.owner_id
         WHERE ei.tenant_id = $1
           AND ${evidencePredicate}
         GROUP BY e.owner_id
       )
       SELECT
         m.*,
         'evidence_item'::text AS match_signal,
         ${SIGNAL_PRIORITY.evidence_item}::int AS signal_priority,
         FALSE AS title_match,
         0::real AS lexical_rank,
         eh.evidence_score,
         ${TYPE_BOOST_SQL} AS type_rank,
         ${feedbackScoreExpr} AS feedback_score,
         eh.evidence_score
           + ${TYPE_BOOST_SQL}
           + ${feedbackScoreExpr} AS recall_score
       FROM evidence_hits eh
       JOIN eligible_memories m ON m.id = eh.memory_id
       ORDER BY
         recall_score DESC,
         eh.latest_evidence_at DESC NULLS LAST,
         m.accepted_at DESC NULLS LAST,
         m.id ASC
       LIMIT $${params.length}`,
      params,
    );
    const applicableRows = scopeKeys
      ? resolveApplicableRecords(result.rows, opts)
      : result.rows;
    return applicableRows
      .sort(sortRecallRows)
      .slice(0, limit);
  }

  async function recallViaMemoryEmbeddings(queryVec, opts = {}) {
    const vector = vecToStr(queryVec);
    if (!vector) return [];
    const tenantId = opts.tenantId || defaultTenantId;
    const limit = Math.max(1, Math.min(50, opts.limit || 10));
    const scopeKeys = activeScopeKeys(opts);
    const fetchLimit = Math.max(limit, Math.min(200, scopeKeys ? limit * 4 : limit));
    const feedbackScoreExpr = feedbackScoreSql(schema);
    const params = [tenantId, vector];
    const where = [
      `m.tenant_id = $1`,
      `m.status = 'active'`,
      `m.visible_in_recall = true`,
      `m.embedding IS NOT NULL`,
    ];
    applyCurrentMemoryFilters(where, params, opts);
    params.push(fetchLimit);
    const result = await pool.query(
      `SELECT
         m.*, s.scope_kind, s.scope_key, s.inheritance_mode AS scope_inheritance_mode,
         'memory_row'::text AS match_signal,
         ${SIGNAL_PRIORITY.memory_row}::int AS signal_priority,
         FALSE AS title_match,
         0::real AS lexical_rank,
         1.0 - (m.embedding <=> $2::vector) AS semantic_score,
         ${TYPE_BOOST_SQL} AS type_rank,
         ${feedbackScoreExpr} AS feedback_score,
         1.0 - (m.embedding <=> $2::vector)
           + ${TYPE_BOOST_SQL}
           + ${feedbackScoreExpr} AS recall_score
       FROM ${schema}.memory_records m
       JOIN ${schema}.scopes s ON s.id = m.scope_id
       WHERE ${where.join(' AND ')}
       ORDER BY
         m.embedding <=> $2::vector ASC,
         m.accepted_at DESC NULLS LAST,
         m.id ASC
       LIMIT $${params.length}`,
      params,
    );
    const applicableRows = scopeKeys
      ? resolveApplicableRecords(result.rows, opts)
      : result.rows;
    return applicableRows
      .sort(sortRecallRows)
      .slice(0, limit);
  }

  async function recallViaLinkedSummaryEmbeddings(queryVec, opts = {}) {
    const vector = vecToStr(queryVec);
    if (!vector) return [];
    const tenantId = opts.tenantId || defaultTenantId;
    const limit = Math.max(1, Math.min(50, opts.limit || 10));
    const scopeKeys = activeScopeKeys(opts);
    const fetchLimit = Math.max(limit, Math.min(200, scopeKeys ? limit * 4 : limit));
    const feedbackScoreExpr = feedbackScoreSql(schema);
    const params = [tenantId, vector];
    const where = [
      `m.tenant_id = $1`,
      `m.status = 'active'`,
      `m.visible_in_recall = true`,
    ];
    applyCurrentMemoryFilters(where, params, opts);
    params.push(fetchLimit);
    const result = await pool.query(
      `WITH eligible_memories AS (
         SELECT m.*, s.scope_kind, s.scope_key, s.inheritance_mode AS scope_inheritance_mode
         FROM ${schema}.memory_records m
         JOIN ${schema}.scopes s ON s.id = m.scope_id
         WHERE ${where.join(' AND ')}
       ),
       linked_summary_hits AS (
         SELECT
           e.owner_id AS memory_id,
           MAX(1.0 - (ss.embedding <=> $2::vector)) AS linked_summary_score,
           MAX(ss.updated_at) AS latest_summary_at
         FROM ${schema}.evidence_refs e
         JOIN ${schema}.sessions src
           ON src.tenant_id = e.tenant_id
          AND src.session_id = e.source_ref
         JOIN ${schema}.session_summaries ss
           ON ss.session_row_id = src.id
         WHERE e.tenant_id = $1
           AND e.owner_kind = 'memory_record'
           AND e.source_kind = 'session_summary'
           AND ss.embedding IS NOT NULL
           AND EXISTS (SELECT 1 FROM eligible_memories em WHERE em.id = e.owner_id)
         GROUP BY e.owner_id
       )
       SELECT
         m.*,
         'linked_summary'::text AS match_signal,
         ${SIGNAL_PRIORITY.linked_summary}::int AS signal_priority,
         FALSE AS title_match,
         0::real AS lexical_rank,
         lsh.linked_summary_score,
         0::real AS type_rank,
         ${feedbackScoreExpr} AS feedback_score,
         (lsh.linked_summary_score * 0.35)
           + ${feedbackScoreExpr} AS recall_score
       FROM linked_summary_hits lsh
       JOIN eligible_memories m ON m.id = lsh.memory_id
       ORDER BY
         recall_score DESC,
         lsh.latest_summary_at DESC NULLS LAST,
         m.accepted_at DESC NULLS LAST,
         m.id ASC
       LIMIT $${params.length}`,
      params,
    );
    const applicableRows = scopeKeys
      ? resolveApplicableRecords(result.rows, opts)
      : result.rows;
    return applicableRows
      .sort(sortRecallRows)
      .slice(0, limit);
  }

  return {
    recall,
    recallViaEvidenceItems,
    recallViaMemoryEmbeddings,
    recallViaLinkedSummaryEmbeddings,
    rankHybridMemoryRows,
  };
}

module.exports = {
  recallMemoryRecords,
  createMemoryRecall,
  rankHybridMemoryRows,
};
