'use strict';

const crypto = require('crypto');

// C1: quote identifier for SQL safety
function qi(identifier) { return `"${identifier}"`; }

// Validate vector for NaN/Infinity before pgvector cast
function vecToStr(vec) {
  if (!vec || !Array.isArray(vec) || vec.length === 0) return null;
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) throw new Error(`Vector contains non-finite value at index ${i}`);
  }
  return `[${vec.join(',')}]`;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_TURN_CHARS = 5;
const MAX_TURN_CHARS = 2000;

const TURN_NOISE_RE = [
  /^\/\w/,
  /^(ok(ay)?|好的?|嗯|對|是的?|yes|yep|no|y|n|got it|thanks?|thx|收到|了解|繼續|不用了?|sure|確認|確定)\.?$/i,
  /^HEARTBEAT_OK$/,
  /^THINK_OK$/,
  /^\[Queued messages while agent was busy\]/,
  /^<<<EXTERNAL_UNTRUSTED_CONTENT/,
  /^A new session was started via \/new/,
];

const VALID_STATUSES = new Set(['pending', 'processing', 'succeeded', 'partial', 'failed', 'skipped']);
const FINALIZATION_STATUSES = new Set([
  'pending',
  'processing',
  'finalized',
  'failed',
  'skipped',
  'declined',
  'deferred',
]);
const FINALIZATION_MODES = new Set([
  'handoff',
  'session_end',
  'session_start_recovery',
  'afterburn',
  'manual',
]);

function requireField(obj, field) {
  if (!obj || obj[field] === undefined || obj[field] === null || obj[field] === '') {
    throw new Error(`${field} is required`);
  }
}

function toJson(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

// ---------------------------------------------------------------------------
// upsertSession
// ---------------------------------------------------------------------------

async function upsertSession(pool, {
  schema,
  tenantId,
  sessionId,
  sessionKey,
  agentId,
  source,
  messages,
  msgCount,
  userCount,
  assistantCount,
  model,
  tokensIn,
  tokensOut,
  startedAt,
  lastMessageAt,
}) {
  const result = await pool.query(
    `INSERT INTO ${qi(schema)}.sessions
      (tenant_id, session_id, session_key, agent_id, source, messages,
       msg_count, user_count, assistant_count, model, tokens_in, tokens_out,
       started_at, ended_at, last_message_at, processing_status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13,now()),COALESCE($14,now()),$14,'pending')
    ON CONFLICT (tenant_id, agent_id, session_id) DO UPDATE SET
      session_key = EXCLUDED.session_key,
      source = COALESCE(EXCLUDED.source, ${qi(schema)}.sessions.source),
      messages = EXCLUDED.messages,
      msg_count = EXCLUDED.msg_count,
      user_count = EXCLUDED.user_count,
      assistant_count = EXCLUDED.assistant_count,
      model = EXCLUDED.model,
      tokens_in = EXCLUDED.tokens_in,
      tokens_out = EXCLUDED.tokens_out,
      started_at = COALESCE(EXCLUDED.started_at, ${qi(schema)}.sessions.started_at),
      ended_at = COALESCE(EXCLUDED.last_message_at, ${qi(schema)}.sessions.ended_at),
      last_message_at = COALESCE(EXCLUDED.last_message_at, ${qi(schema)}.sessions.last_message_at),
      processing_status = 'pending',
      processing_error = NULL
    RETURNING id, tenant_id, agent_id, session_id, processing_status, (xmax = 0) AS is_new`,
    [
      tenantId, sessionId, sessionKey || null, agentId, source || 'api',
      messages ? JSON.stringify(messages) : null,
      msgCount || 0, userCount || 0, assistantCount || 0,
      model || null, tokensIn || 0, tokensOut || 0,
      startedAt || null, lastMessageAt || null,
    ]
  );
  if (!result.rows[0]) return null;
  const r = result.rows[0];
  return {
    id: r.id,
    tenantId: r.tenant_id,
    agentId: r.agent_id,
    sessionId: r.session_id,
    processingStatus: r.processing_status,
    isNew: r.is_new,
  };
}

// ---------------------------------------------------------------------------
// upsertSummary
// ---------------------------------------------------------------------------

async function upsertSummary(pool, sessionRowId, {
  schema,
  tenantId,
  agentId,
  sessionId,
  summaryText,
  structuredSummary,
  model,
  sourceHash,
  msgCount,
  userCount,
  assistantCount,
  startedAt,
  endedAt,
  embedding,
}) {
  const embStr = embedding ? vecToStr(embedding) : null;
  const result = await pool.query(
    `INSERT INTO ${qi(schema)}.session_summaries
      (session_row_id, tenant_id, agent_id, session_id, summary_version, model, source_hash,
       message_count, user_message_count, assistant_message_count,
       started_at, ended_at, structured_summary, summary_text, embedding, updated_at)
    VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::jsonb,'{}'::jsonb),COALESCE($13,''),$14::vector,now())
    ON CONFLICT (session_row_id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      agent_id = EXCLUDED.agent_id,
      session_id = EXCLUDED.session_id,
      model = COALESCE(NULLIF(EXCLUDED.model, 'unknown'), ${qi(schema)}.session_summaries.model),
      source_hash = COALESCE(EXCLUDED.source_hash, ${qi(schema)}.session_summaries.source_hash),
      message_count = COALESCE(EXCLUDED.message_count, ${qi(schema)}.session_summaries.message_count),
      user_message_count = COALESCE(EXCLUDED.user_message_count, ${qi(schema)}.session_summaries.user_message_count),
      assistant_message_count = COALESCE(EXCLUDED.assistant_message_count, ${qi(schema)}.session_summaries.assistant_message_count),
      started_at = COALESCE(EXCLUDED.started_at, ${qi(schema)}.session_summaries.started_at),
      ended_at = COALESCE(EXCLUDED.ended_at, ${qi(schema)}.session_summaries.ended_at),
      structured_summary = COALESCE(NULLIF(EXCLUDED.structured_summary, '{}'::jsonb), ${qi(schema)}.session_summaries.structured_summary),
      summary_text = COALESCE(NULLIF(EXCLUDED.summary_text, ''), ${qi(schema)}.session_summaries.summary_text),
      embedding = COALESCE(EXCLUDED.embedding, ${qi(schema)}.session_summaries.embedding),
      updated_at = now()
    RETURNING session_row_id, tenant_id, agent_id, session_id, model`,
    [
      sessionRowId, tenantId, agentId || null, sessionId || null,
      model || 'unknown', sourceHash || null,
      msgCount || 0, userCount || 0, assistantCount || 0,
      startedAt || null, endedAt || null,
      structuredSummary ? JSON.stringify(structuredSummary) : null,
      summaryText || '',
      embStr,
    ]
  );
  return result.rows[0] || null;
}

// ---------------------------------------------------------------------------
// markStatus
// ---------------------------------------------------------------------------

async function markStatus(pool, sessionRowId, status, error, { schema } = {}) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  const result = await pool.query(
    `UPDATE ${qi(schema)}.sessions
    SET processing_status = $1,
        processed_at = CASE WHEN $1 IN ('succeeded', 'partial') THEN now() ELSE processed_at END,
        processing_error = $2
    WHERE id = $3
    RETURNING id, processing_status, processing_error`,
    [status, error || null, sessionRowId]
  );
  return result.rows[0] || null;
}

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------

async function getSession(pool, sessionId, agentId, options = {}, { schema, tenantId: defaultTenantId } = {}) {
  // Support legacy: options can be a string (treated as source)
  let source = null;
  let tid = defaultTenantId;
  if (typeof options === 'string') {
    source = options;
  } else {
    source = options.source || null;
    tid = options.tenantId || tid;
  }
  const result = await pool.query(
    `SELECT *
    FROM ${qi(schema)}.sessions
    WHERE session_id = $1
      AND agent_id = $2
      AND tenant_id = $3
      AND ($4::text IS NULL OR source = $4)
    LIMIT 1`,
    [sessionId, agentId, tid, source]
  );
  return result.rows[0] || null;
}

// ---------------------------------------------------------------------------
// getMessages
// ---------------------------------------------------------------------------

async function getMessages(pool, sessionId, agentId, { schema, tenantId } = {}) {
  const row = await getSession(pool, sessionId, agentId, { tenantId }, { schema, tenantId });
  if (!row || !row.messages) return null;
  const msgs = typeof row.messages === 'string' ? JSON.parse(row.messages) : row.messages;
  return msgs.normalized || msgs;
}

// ---------------------------------------------------------------------------
// searchSessions (trigram + FTS fallback)
// ---------------------------------------------------------------------------

async function searchSessions(pool, query, {
  schema,
  tenantId,
  agentId,
  agentIds: rawAgentIds,
  source,
  dateFrom,
  dateTo,
  limit = 20,
  ftsConfig = 'simple',
} = {}) {
  const clampedLimit = Math.max(1, Math.min(100, limit));

  // Whitelist tsconfig to prevent injection
  const cfg = (ftsConfig === 'zhcfg' || ftsConfig === 'simple') ? ftsConfig : 'simple';

  // Normalize agentId/agentIds
  const agentIds = rawAgentIds && rawAgentIds.length > 0
    ? rawAgentIds
    : (agentId ? [agentId] : null);

  // Escape LIKE special characters in query
  const likeQuery = query.replace(/[%_\\]/g, '\\$&');

  // Primary: trigram ILIKE on search_text (works for CJK + Latin)
  // Fallback: tsvector FTS (for installations without search_text populated)
  const where = [
    `(ss.search_text ILIKE '%' || $1 || '%' OR ss.search_tsv @@ plainto_tsquery('${cfg}', $2))`,
    `s.tenant_id = $3`,
  ];
  const params = [likeQuery, query, tenantId];

  if (agentIds) {
    params.push(agentIds);
    where.push(`s.agent_id = ANY($${params.length})`);
  }
  if (source) {
    params.push(source);
    where.push(`s.source = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    where.push(`s.started_at::date >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`s.started_at::date <= $${params.length}::date`);
  }
  params.push(clampedLimit);

  const result = await pool.query(
    `SELECT
      s.id,
      s.session_id,
      s.agent_id,
      s.source,
      s.started_at,
      s.last_message_at,
      s.msg_count,
      ss.summary_text,
      ss.structured_summary,
      ss.access_count,
      ss.last_accessed_at,
      ss.trust_score,
      CASE WHEN ss.search_text IS NOT NULL
        THEN similarity(ss.search_text, $2)
        ELSE ts_rank(ss.search_tsv, plainto_tsquery('${cfg}', $2))
      END AS fts_rank
    FROM ${qi(schema)}.sessions s
    -- INNER JOIN: the WHERE clause references ss.search_text / ss.search_tsv,
    -- which a LEFT JOIN would leave NULL for unenriched sessions — filtering
    -- them out. Be explicit: FTS recall is a SUMMARIZED-sessions search. Raw
    -- unenriched sessions don't participate. Named searchSessions for historic
    -- reasons; semantically it is search-over-enriched-sessions.
    JOIN ${qi(schema)}.session_summaries ss ON ss.session_row_id = s.id
    WHERE ${where.join(' AND ')}
    ORDER BY
      COALESCE(ss.search_text ILIKE '%' || $1 || '%', FALSE) DESC,
      fts_rank DESC,
      s.last_message_at DESC NULLS LAST
    LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// recordAccess
// ---------------------------------------------------------------------------

async function recordAccess(pool, sessionRowIds, { schema } = {}) {
  if (!sessionRowIds || sessionRowIds.length === 0) return;
  await pool.query(
    `UPDATE ${qi(schema)}.session_summaries
    SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = now()
    WHERE session_row_id = ANY($1)`,
    [sessionRowIds]
  );
}

// ---------------------------------------------------------------------------
// Session finalization ledger
// ---------------------------------------------------------------------------

function normalizeFinalizationStatus(status) {
  const out = status || 'pending';
  if (!FINALIZATION_STATUSES.has(out)) throw new Error(`Invalid finalization status: ${out}`);
  return out;
}

function normalizeFinalizationMode(mode) {
  const out = mode || 'handoff';
  if (!FINALIZATION_MODES.has(out)) throw new Error(`Invalid finalization mode: ${out}`);
  return out;
}

async function upsertSessionFinalization(pool, input = {}, { schema, tenantId: defaultTenantId } = {}) {
  requireField(input, 'sessionRowId');
  requireField(input, 'sessionId');
  requireField(input, 'agentId');
  requireField(input, 'source');
  requireField(input, 'transcriptHash');
  const tenantId = input.tenantId || defaultTenantId || 'default';
  const status = normalizeFinalizationStatus(input.status || 'pending');
  const mode = normalizeFinalizationMode(input.mode || 'handoff');
  const phase = input.phase || 'curated_memory_v1';
  const result = await pool.query(
    `INSERT INTO ${qi(schema)}.session_finalizations (
       tenant_id, session_row_id, source, host, agent_id, session_id,
       transcript_hash, phase, mode, status, finalizer_model, scope_kind,
       scope_key, context_key, topic_key, summary_row_id, memory_result,
       summary_text, structured_summary, human_review_text, session_start_text,
       error, metadata, claimed_at, finalized_at
     )
     VALUES (
       $1,$2,$3,COALESCE($4,'codex'),$5,$6,$7,COALESCE($8,'curated_memory_v1'),
       $9,$10,$11,$12,$13,$14,$15,$16,COALESCE($17::jsonb,'{}'::jsonb),
       $18,COALESCE($19::jsonb,'{}'::jsonb),$20,$21,
       $22,COALESCE($23::jsonb,'{}'::jsonb),$24,$25
     )
     ON CONFLICT (tenant_id, source, agent_id, session_id, transcript_hash, phase)
     DO UPDATE SET
       session_row_id = EXCLUDED.session_row_id,
       host = EXCLUDED.host,
       mode = EXCLUDED.mode,
       status = EXCLUDED.status,
       finalizer_model = COALESCE(EXCLUDED.finalizer_model, ${qi(schema)}.session_finalizations.finalizer_model),
       scope_kind = COALESCE(EXCLUDED.scope_kind, ${qi(schema)}.session_finalizations.scope_kind),
       scope_key = COALESCE(EXCLUDED.scope_key, ${qi(schema)}.session_finalizations.scope_key),
       context_key = COALESCE(EXCLUDED.context_key, ${qi(schema)}.session_finalizations.context_key),
       topic_key = COALESCE(EXCLUDED.topic_key, ${qi(schema)}.session_finalizations.topic_key),
       summary_row_id = COALESCE(EXCLUDED.summary_row_id, ${qi(schema)}.session_finalizations.summary_row_id),
       memory_result = COALESCE(NULLIF(EXCLUDED.memory_result, '{}'::jsonb), ${qi(schema)}.session_finalizations.memory_result),
       summary_text = COALESCE(EXCLUDED.summary_text, ${qi(schema)}.session_finalizations.summary_text),
       structured_summary = COALESCE(NULLIF(EXCLUDED.structured_summary, '{}'::jsonb), ${qi(schema)}.session_finalizations.structured_summary),
       human_review_text = COALESCE(EXCLUDED.human_review_text, ${qi(schema)}.session_finalizations.human_review_text),
       session_start_text = COALESCE(EXCLUDED.session_start_text, ${qi(schema)}.session_finalizations.session_start_text),
       error = EXCLUDED.error,
       metadata = COALESCE(NULLIF(EXCLUDED.metadata, '{}'::jsonb), ${qi(schema)}.session_finalizations.metadata),
       claimed_at = COALESCE(EXCLUDED.claimed_at, ${qi(schema)}.session_finalizations.claimed_at),
       finalized_at = COALESCE(EXCLUDED.finalized_at, ${qi(schema)}.session_finalizations.finalized_at),
       updated_at = now()
     RETURNING *`,
    [
      tenantId,
      input.sessionRowId,
      input.source,
      input.host || 'codex',
      input.agentId,
      input.sessionId,
      input.transcriptHash,
      phase,
      mode,
      status,
      input.finalizerModel || null,
      input.scopeKind || null,
      input.scopeKey || null,
      input.contextKey || null,
      input.topicKey || null,
      input.summaryRowId || null,
      toJson(input.memoryResult, {}),
      input.summaryText || null,
      toJson(input.structuredSummary, {}),
      input.humanReviewText || null,
      input.sessionStartText || null,
      input.error || null,
      toJson(input.metadata, {}),
      input.claimedAt || (status === 'processing' ? new Date().toISOString() : null),
      input.finalizedAt || (status === 'finalized' ? new Date().toISOString() : null),
    ]
  );
  return result.rows[0] || null;
}

async function getSessionFinalization(pool, input = {}, { schema, tenantId: defaultTenantId } = {}) {
  requireField(input, 'sessionId');
  requireField(input, 'agentId');
  requireField(input, 'source');
  requireField(input, 'transcriptHash');
  const tenantId = input.tenantId || defaultTenantId || 'default';
  const phase = input.phase || 'curated_memory_v1';
  const result = await pool.query(
    `SELECT *
       FROM ${qi(schema)}.session_finalizations
      WHERE tenant_id = $1
        AND source = $2
        AND agent_id = $3
        AND session_id = $4
        AND transcript_hash = $5
        AND phase = $6
      LIMIT 1`,
    [tenantId, input.source, input.agentId, input.sessionId, input.transcriptHash, phase]
  );
  return result.rows[0] || null;
}

async function updateSessionFinalizationStatus(pool, input = {}, { schema, tenantId: defaultTenantId } = {}) {
  const status = normalizeFinalizationStatus(input.status);
  const tenantId = input.tenantId || defaultTenantId || 'default';
  const params = [
    tenantId,
    status,
    input.error || null,
    input.finalizerModel || null,
    toJson(input.memoryResult, {}),
    toJson(input.metadata, {}),
  ];
  let where;
  if (input.id) {
    params.push(input.id);
    where = `id = $${params.length}`;
  } else {
    requireField(input, 'sessionId');
    requireField(input, 'agentId');
    requireField(input, 'source');
    requireField(input, 'transcriptHash');
    params.push(input.source, input.agentId, input.sessionId, input.transcriptHash, input.phase || 'curated_memory_v1');
    where = `source = $7 AND agent_id = $8 AND session_id = $9 AND transcript_hash = $10 AND phase = $11`;
  }
  const result = await pool.query(
    `UPDATE ${qi(schema)}.session_finalizations
        SET status = $2,
            error = $3,
            finalizer_model = COALESCE($4, finalizer_model),
            memory_result = COALESCE(NULLIF($5::jsonb, '{}'::jsonb), memory_result),
            metadata = COALESCE(NULLIF($6::jsonb, '{}'::jsonb), metadata),
            finalized_at = CASE WHEN $2 = 'finalized' THEN COALESCE(finalized_at, now()) ELSE finalized_at END,
            updated_at = now()
      WHERE tenant_id = $1 AND ${where}
      RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

async function listSessionFinalizations(pool, input = {}, { schema, tenantId: defaultTenantId } = {}) {
  const tenantId = input.tenantId || defaultTenantId || 'default';
  const params = [tenantId];
  const where = [`tenant_id = $1`];
  if (input.host) {
    params.push(input.host);
    where.push(`host = $${params.length}`);
  }
  if (input.status) {
    const statuses = Array.isArray(input.status) ? input.status : [input.status];
    for (const status of statuses) normalizeFinalizationStatus(status);
    params.push(statuses);
    where.push(`status = ANY($${params.length}::text[])`);
  }
  if (input.agentId) {
    params.push(input.agentId);
    where.push(`agent_id = $${params.length}`);
  }
  if (input.source) {
    params.push(input.source);
    where.push(`source = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(200, input.limit || 50)));
  const result = await pool.query(
    `SELECT *
       FROM ${qi(schema)}.session_finalizations
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

function candidateText(candidate = {}) {
  if (typeof candidate === 'string') return candidate.trim();
  const payload = candidate.payload && typeof candidate.payload === 'object' ? candidate.payload : null;
  for (const key of ['summary', 'title', 'decision', 'item', 'conclusion', 'statement', 'fact', 'text', 'note']) {
    const text = String(candidate[key] || '').trim();
    if (text) return text;
  }
  if (payload) {
    for (const key of ['summary', 'title', 'decision', 'item', 'conclusion', 'statement', 'fact', 'text', 'note']) {
      const text = String(payload[key] || '').trim();
      if (text) return text;
    }
  }
  return '';
}

async function upsertFinalizationCandidates(pool, rows = [], input = {}, { schema, tenantId: defaultTenantId } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  requireField(input, 'finalizationId');
  const tenantId = input.tenantId || defaultTenantId || 'default';
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const candidate = row.candidate || {};
    const memory = row.memory || {};
    const backingFact = row.backingFact || {};
    const evidenceRefs = candidate.evidenceRefs || candidate.evidence_refs || [];
    const result = await pool.query(
      `INSERT INTO ${qi(schema)}.finalization_candidates (
         tenant_id, finalization_id, session_id, candidate_index, action, reason,
         memory_type, canonical_key, summary, payload, provenance,
         memory_record_id, fact_assertion_id
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::jsonb,'{}'::jsonb),COALESCE($11::jsonb,'{}'::jsonb),$12,$13
       )
       ON CONFLICT (tenant_id, finalization_id, candidate_index)
       DO UPDATE SET
         action = EXCLUDED.action,
         reason = EXCLUDED.reason,
         memory_type = COALESCE(EXCLUDED.memory_type, ${qi(schema)}.finalization_candidates.memory_type),
         canonical_key = COALESCE(EXCLUDED.canonical_key, ${qi(schema)}.finalization_candidates.canonical_key),
         summary = COALESCE(EXCLUDED.summary, ${qi(schema)}.finalization_candidates.summary),
         payload = COALESCE(NULLIF(EXCLUDED.payload, '{}'::jsonb), ${qi(schema)}.finalization_candidates.payload),
         provenance = COALESCE(NULLIF(EXCLUDED.provenance, '{}'::jsonb), ${qi(schema)}.finalization_candidates.provenance),
         memory_record_id = COALESCE(EXCLUDED.memory_record_id, ${qi(schema)}.finalization_candidates.memory_record_id),
         fact_assertion_id = COALESCE(EXCLUDED.fact_assertion_id, ${qi(schema)}.finalization_candidates.fact_assertion_id),
         updated_at = now()
       RETURNING *`,
      [
        tenantId,
        input.finalizationId,
        input.sessionId || null,
        i,
        row.action || 'skipped',
        row.reason || null,
        candidate.memoryType || candidate.memory_type || memory.memory_type || memory.memoryType || null,
        candidate.canonicalKey || candidate.canonical_key || memory.canonical_key || memory.canonicalKey || null,
        candidateText(candidate) || candidateText(memory) || null,
        toJson(candidate.payload || candidate, {}),
        toJson({ evidenceRefs }, {}),
        memory.id || memory.memory_id || null,
        backingFact.id || memory.backing_fact_id || null,
      ]
    );
    out.push(result.rows[0] || null);
  }
  return out;
}

// ---------------------------------------------------------------------------
// extractUserTurns
// ---------------------------------------------------------------------------

function extractUserTurns(normalized) {
  if (!normalized || !Array.isArray(normalized)) return [];
  const turns = [];
  let turnIndex = 0;
  for (let i = 0; i < normalized.length; i++) {
    const msg = normalized[i];
    if (msg.role !== 'user') continue;

    let text;
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n');
    } else if (typeof msg.text === 'string') {
      text = msg.text;
    } else {
      text = '';
    }

    text = text.trim();
    if (text.length < MIN_TURN_CHARS) continue;
    if (TURN_NOISE_RE.some(re => re.test(text))) continue;

    turnIndex++;
    turns.push({
      turnIndex,
      messageIndex: i,
      text: Array.from(text).slice(0, MAX_TURN_CHARS).join(''),
    });
  }
  return turns;
}

// ---------------------------------------------------------------------------
// upsertTurnEmbeddings
// ---------------------------------------------------------------------------

async function upsertTurnEmbeddings(pool, sessionRowId, {
  schema,
  tenantId,
  sessionId,
  agentId,
  source,
  turns,
  vectors,
}) {
  if (!turns || turns.length === 0) return;
  if (turns.length !== vectors.length) {
    throw new Error(`turns.length (${turns.length}) !== vectors.length (${vectors.length})`);
  }

  // Batch insert: build multi-row VALUES clause
  const valueClauses = [];
  const params = [];

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const vec = vectors[i];
    if (!vec) continue;

    const contentHash = crypto.createHash('sha256').update(t.text).digest('hex').slice(0, 16);
    const off = params.length;
    params.push(
      sessionRowId, tenantId, sessionId, agentId, source || null,
      t.turnIndex, t.messageIndex,
      t.text, contentHash, vecToStr(vec),
    );
    valueClauses.push(
      `($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7},'user',$${off+8},$${off+9},$${off+10}::vector)`
    );
  }

  if (valueClauses.length === 0) return;

  await pool.query(
    `INSERT INTO ${qi(schema)}.turn_embeddings
      (session_row_id, tenant_id, session_id, agent_id, source,
       turn_index, message_index, role, content_text, content_hash, embedding)
    VALUES ${valueClauses.join(',\n')}
    ON CONFLICT (session_row_id, message_index) DO UPDATE SET
      content_text = EXCLUDED.content_text,
      content_hash = EXCLUDED.content_hash,
      embedding = CASE
        WHEN ${qi(schema)}.turn_embeddings.content_hash = EXCLUDED.content_hash
        THEN ${qi(schema)}.turn_embeddings.embedding
        ELSE EXCLUDED.embedding
      END`,
    params
  );
}

// ---------------------------------------------------------------------------
// searchTurnEmbeddings
// ---------------------------------------------------------------------------

async function searchTurnEmbeddings(pool, {
  schema,
  tenantId,
  queryVec,
  dateFrom,
  dateTo,
  agentId,
  agentIds: rawAgentIds,
  source,
  limit = 15,
}) {
  // HNSW index fires only on `ORDER BY embedding <=> $vec LIMIT N` without
  // additional predicates in the same query level. So the CTE does a plain
  // nearest-neighbor scan (uses idx_turn_emb_embedding_hnsw at scale), then
  // the outer SELECT applies tenant/agent/date/source filters and dedups.
  //
  // Filter narrowness may leave fewer than `limit` rows after post-filter;
  // NN_OVERFETCH trades extra vector work for filter survival headroom.
  const NN_OVERFETCH = 10;
  const nnLimit = Math.max(50, limit * NN_OVERFETCH);

  const where = ['s.tenant_id = $1'];
  const params = [tenantId];

  // Normalize agentId/agentIds
  const agentIds = rawAgentIds && rawAgentIds.length > 0
    ? rawAgentIds
    : (agentId ? [agentId] : null);

  if (dateFrom) {
    params.push(dateFrom);
    where.push(`s.started_at::date >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`s.started_at::date <= $${params.length}::date`);
  }
  if (agentIds) {
    params.push(agentIds);
    where.push(`s.agent_id = ANY($${params.length})`);
  }
  if (source) {
    params.push(source);
    where.push(`s.source = $${params.length}`);
  }

  params.push(`[${queryVec.join(',')}]`);
  const vecPos = params.length;
  params.push(nnLimit);
  const nnLimitPos = params.length;

  const result = await pool.query(
    `WITH nn AS (
      SELECT t.session_row_id, t.content_text, t.turn_index,
             (t.embedding <=> $${vecPos}::vector) AS turn_distance
      FROM ${qi(schema)}.turn_embeddings t
      ORDER BY t.embedding <=> $${vecPos}::vector ASC
      LIMIT $${nnLimitPos}
    )
    SELECT * FROM (
      SELECT DISTINCT ON (nn.session_row_id)
        s.session_id, s.id AS session_row_id, s.agent_id, s.source, s.started_at,
        ss.summary_text, ss.structured_summary, ss.access_count, ss.last_accessed_at,
        COALESCE(ss.trust_score, 0.5) AS trust_score,
        nn.content_text AS matched_turn_text, nn.turn_index AS matched_turn_index,
        nn.turn_distance
      FROM nn
      JOIN ${qi(schema)}.sessions s ON s.id = nn.session_row_id
      LEFT JOIN ${qi(schema)}.session_summaries ss ON ss.session_row_id = s.id
      WHERE ${where.join(' AND ')}
      ORDER BY nn.session_row_id, nn.turn_distance ASC
    ) dedup
    ORDER BY turn_distance ASC`,
    params
  );

  if (result.rows.length > 0) {
    return { rows: result.rows.slice(0, limit) };
  }

  // Fallback: HNSW-first path filtered out to nothing. This can happen when
  // tenant/agent filters are narrow enough to eliminate every NN candidate.
  // Pay the cost of a filter-first scan to guarantee we don't silently return
  // empty when qualifying rows exist. No HNSW on this path — slower, correct.
  const fallbackParams = params.slice(0, params.length - 1); // drop nnLimit
  fallbackParams.push(limit);
  const fallbackLimitPos = fallbackParams.length;
  const fallback = await pool.query(
    `SELECT DISTINCT ON (t.session_row_id)
      s.session_id, s.id AS session_row_id, s.agent_id, s.source, s.started_at,
      ss.summary_text, ss.structured_summary, ss.access_count, ss.last_accessed_at,
      COALESCE(ss.trust_score, 0.5) AS trust_score,
      t.content_text AS matched_turn_text, t.turn_index AS matched_turn_index,
      (t.embedding <=> $${vecPos}::vector) AS turn_distance
    FROM ${qi(schema)}.turn_embeddings t
    JOIN ${qi(schema)}.sessions s ON s.id = t.session_row_id
    LEFT JOIN ${qi(schema)}.session_summaries ss ON ss.session_row_id = s.id
    WHERE ${where.join(' AND ')}
    ORDER BY t.session_row_id, t.embedding <=> $${vecPos}::vector ASC
    LIMIT $${fallbackLimitPos}`,
    fallbackParams
  );
  return { rows: fallback.rows };
}

// ---------------------------------------------------------------------------
// searchSummaryEmbeddings — pgvector cosine search on session_summaries.embedding
// ---------------------------------------------------------------------------

async function searchSummaryEmbeddings(pool, {
  schema,
  tenantId,
  queryVec,
  agentId,
  agentIds: rawAgentIds,
  source,
  dateFrom,
  dateTo,
  candidateSessionIds,
  limit = 15,
} = {}) {
  const where = ['s.tenant_id = $1'];
  const params = [tenantId];

  params.push(`[${queryVec.join(',')}]`);
  const vecPos = params.length;

  const agentIds = rawAgentIds && rawAgentIds.length > 0
    ? rawAgentIds
    : (agentId ? [agentId] : null);

  if (dateFrom) {
    params.push(dateFrom);
    where.push(`s.started_at::date >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`s.started_at::date <= $${params.length}::date`);
  }
  if (agentIds) {
    params.push(agentIds);
    where.push(`s.agent_id = ANY($${params.length})`);
  }
  if (source) {
    params.push(source);
    where.push(`s.source = $${params.length}`);
  }
  if (candidateSessionIds && candidateSessionIds.length > 0) {
    params.push(candidateSessionIds);
    where.push(`s.session_id = ANY($${params.length})`);
  }

  params.push(limit);

  const result = await pool.query(
    `SELECT
      s.id, s.session_id, s.agent_id, s.source, s.started_at, s.last_message_at,
      ss.summary_text, ss.structured_summary, ss.access_count, ss.last_accessed_at,
      ss.trust_score,
      (ss.embedding <=> $${vecPos}::vector) AS distance
    FROM ${qi(schema)}.session_summaries ss
    JOIN ${qi(schema)}.sessions s ON s.id = ss.session_row_id
    WHERE ss.embedding IS NOT NULL
      AND ${where.join(' AND ')}
    ORDER BY distance ASC
    LIMIT $${params.length}`,
    params
  );

  return { rows: result.rows };
}

// ---------------------------------------------------------------------------
// recordFeedback — explicit trust feedback with audit trail
// ---------------------------------------------------------------------------

const TRUST_UP = 0.05;
const TRUST_DOWN = 0.10;

async function recordFeedback(pool, {
  schema,
  tenantId,
  sessionRowId,
  sessionId,
  agentId,
  verdict,
  note,
}) {
  if (verdict !== 'helpful' && verdict !== 'unhelpful') {
    throw new Error(`Invalid verdict: "${verdict}". Must be "helpful" or "unhelpful".`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query(
      `SELECT trust_score FROM ${qi(schema)}.session_summaries
      WHERE session_row_id = $1 FOR UPDATE`,
      [sessionRowId]
    );
    if (!current.rows[0]) {
      throw new Error(`Session not enriched: no summary for session_row_id=${sessionRowId}`);
    }

    const trustBefore = parseFloat(current.rows[0].trust_score);

    // Dedupe: the same (agent, verdict) applied more than once must not stack.
    // Audit row is still inserted so the sequence of feedback events is
    // preserved; only the trust_score delta is skipped.
    const prior = await client.query(
      `SELECT 1 FROM ${qi(schema)}.session_feedback
       WHERE session_row_id = $1 AND agent_id = $2 AND verdict = $3
       LIMIT 1`,
      [sessionRowId, agentId, verdict]
    );
    const isDup = prior.rows.length > 0;

    const trustAfter = isDup
      ? trustBefore
      : (verdict === 'helpful'
          ? Math.min(1.0, trustBefore + TRUST_UP)
          : Math.max(0.0, trustBefore - TRUST_DOWN));

    if (!isDup) {
      await client.query(
        `UPDATE ${qi(schema)}.session_summaries
        SET trust_score = $1, updated_at = now()
        WHERE session_row_id = $2`,
        [trustAfter, sessionRowId]
      );
    }

    await client.query(
      `INSERT INTO ${qi(schema)}.session_feedback
        (session_row_id, tenant_id, agent_id, session_id, verdict, note, trust_before, trust_after)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [sessionRowId, tenantId, agentId, sessionId, verdict, note || null, trustBefore, trustAfter]
    );

    await client.query('COMMIT');
    return { trustBefore, trustAfter, verdict, duplicate: isDup };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// getFeedbackStats — aggregate feedback and trust score metrics
// ---------------------------------------------------------------------------

async function getFeedbackStats(pool, { schema, tenantId, agentId, dateFrom, dateTo }) {
  const params = [tenantId];
  let sessionClause = '';
  if (agentId) {
    params.push(agentId);
    sessionClause += ` AND s.agent_id = $${params.length}`;
  }
  if (dateFrom) {
    params.push(dateFrom);
    sessionClause += ` AND s.started_at >= $${params.length}::date`;
  }
  if (dateTo) {
    params.push(dateTo);
    sessionClause += ` AND s.started_at < ($${params.length}::date + interval '1 day')`;
  }

  const fbQuery = `
    WITH scoped_sessions AS (
      SELECT s.id
      FROM ${qi(schema)}.sessions s
      WHERE s.tenant_id = $1${sessionClause}
    )
    SELECT
      COUNT(sf.*)::int AS total,
      COUNT(*) FILTER (WHERE sf.verdict = 'helpful')::int AS helpful,
      COUNT(*) FILTER (WHERE sf.verdict = 'unhelpful')::int AS unhelpful,
      COUNT(DISTINCT sf.session_row_id)::int AS rated_sessions
    FROM scoped_sessions ss
    LEFT JOIN ${qi(schema)}.session_feedback sf
      ON sf.session_row_id = ss.id`;

  const ssQuery = `
    WITH scoped_sessions AS (
      SELECT s.id
      FROM ${qi(schema)}.sessions s
      WHERE s.tenant_id = $1${sessionClause}
    )
    SELECT
      COUNT(scoped_sessions.id)::int AS total_sessions,
      ROUND(AVG(summary.trust_score)::numeric, 3) AS avg_ts,
      MIN(summary.trust_score) AS min_ts,
      MAX(summary.trust_score) AS max_ts
    FROM scoped_sessions
    LEFT JOIN ${qi(schema)}.session_summaries summary
      ON summary.session_row_id = scoped_sessions.id`;

  const [fbResult, ssResult] = await Promise.all([
    pool.query(fbQuery, params),
    pool.query(ssQuery, params),
  ]);

  const fb = fbResult.rows[0];
  const ss = ssResult.rows[0];

  return {
    totalFeedback: fb.total,
    helpfulCount: fb.helpful,
    unhelpfulCount: fb.unhelpful,
    feedbackSessions: fb.rated_sessions,
    totalSessions: ss.total_sessions,
    trustScoreAvg: (ss.avg_ts !== null && ss.avg_ts !== undefined) ? parseFloat(ss.avg_ts) : 0.5,
    trustScoreMin: (ss.min_ts !== null && ss.min_ts !== undefined) ? parseFloat(ss.min_ts) : 0.5,
    trustScoreMax: (ss.max_ts !== null && ss.max_ts !== undefined) ? parseFloat(ss.max_ts) : 0.5,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  upsertSession,
  upsertSummary,
  markStatus,
  getSession,
  getMessages,
  searchSessions,
  recordAccess,
  upsertSessionFinalization,
  getSessionFinalization,
  updateSessionFinalizationStatus,
  listSessionFinalizations,
  upsertFinalizationCandidates,
  extractUserTurns,
  upsertTurnEmbeddings,
  searchTurnEmbeddings,
  searchSummaryEmbeddings,
  recordFeedback,
  getFeedbackStats,
};
