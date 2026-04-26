'use strict';

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

function recallMemoryRecords(records = [], query, opts = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) throw new Error('memory.recall(query): query must be a non-empty string');
  const limit = Math.max(1, Math.min(50, opts.limit || 10));
  const feedbackEvents = opts.feedbackEvents || [];

  return records
    .filter(record => isActiveVisible(record, opts))
    .map(record => {
      const haystack = textOf(record).toLowerCase();
      const lexical = lexicalScore(haystack, q);
      const typeRank = (TYPE_RANK[record.memoryType || record.memory_type] || 0) / 100;
      const feedback = feedbackScore(record, feedbackEvents);
      return {
        ...record,
        score: lexical + typeRank + feedback,
        _debug: { lexical, typeRank, feedback },
      };
    })
    .filter(record => record._debug.lexical > 0 || opts.includeAll === true)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aAccepted = Date.parse(a.acceptedAt || a.accepted_at || '') || 0;
      const bAccepted = Date.parse(b.acceptedAt || b.accepted_at || '') || 0;
      if (bAccepted !== aAccepted) return bAccepted - aAccepted;
      return getId(a).localeCompare(getId(b));
    })
    .slice(0, limit);
}

function createMemoryRecall({ pool, schema, defaultTenantId }) {
  async function recall(query, opts = {}) {
    const q = String(query || '').trim();
    if (!q) throw new Error('memory.recall(query): query must be a non-empty string');
    const tenantId = opts.tenantId || defaultTenantId;
    const limit = Math.max(1, Math.min(50, opts.limit || 10));
    const params = [tenantId, q];
    const where = [
      `m.tenant_id = $1`,
      `m.status = 'active'`,
      `m.visible_in_recall = true`,
      `(m.search_tsv @@ plainto_tsquery('simple', $2)
        OR m.title ILIKE '%' || $2 || '%'
        OR m.summary ILIKE '%' || $2 || '%'
        OR m.context_key ILIKE '%' || $2 || '%'
        OR m.topic_key ILIKE '%' || $2 || '%')`,
    ];
    if (opts.scopeId) {
      params.push(opts.scopeId);
      where.push(`m.scope_id = $${params.length}`);
    }
    if (opts.asOf) {
      params.push(opts.asOf);
      const at = `$${params.length}::timestamptz`;
      where.push(`(m.valid_from IS NULL OR m.valid_from <= ${at})`);
      where.push(`(m.valid_to IS NULL OR m.valid_to > ${at})`);
      where.push(`(m.stale_after IS NULL OR m.stale_after > ${at})`);
    }
    params.push(limit);
    const result = await pool.query(
      `SELECT
         m.*, s.scope_kind, s.scope_key, s.inheritance_mode AS scope_inheritance_mode,
         ts_rank(m.search_tsv, plainto_tsquery('simple', $2)) AS lexical_rank
       FROM ${schema}.memory_records m
       JOIN ${schema}.scopes s ON s.id = m.scope_id
       WHERE ${where.join(' AND ')}
       ORDER BY
         (m.title ILIKE '%' || $2 || '%') DESC,
         lexical_rank DESC,
         m.accepted_at DESC NULLS LAST,
         m.id ASC
       LIMIT $${params.length}`,
      params
    );
    return result.rows;
  }

  return { recall };
}

module.exports = {
  recallMemoryRecords,
  createMemoryRecall,
};
