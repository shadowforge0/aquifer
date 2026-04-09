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

const VALID_STATUSES = new Set(['pending', 'processing', 'succeeded', 'partial', 'failed']);

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
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),$14,'pending')
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
      ended_at = now(),
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
// upsertSegments
// ---------------------------------------------------------------------------

async function upsertSegments(pool, sessionRowId, segments, { schema } = {}) {
  if (!segments || segments.length === 0) return;
  for (const seg of segments) {
    await pool.query(
      `INSERT INTO ${qi(schema)}.session_segments
        (session_row_id, segment_no, start_msg_idx, end_msg_idx,
         started_at, ended_at, raw_msg_count, effective_msg_count,
         boundary_type, boundary_meta)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (session_row_id, segment_no) DO UPDATE SET
        start_msg_idx = EXCLUDED.start_msg_idx,
        end_msg_idx = EXCLUDED.end_msg_idx,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        raw_msg_count = EXCLUDED.raw_msg_count,
        effective_msg_count = EXCLUDED.effective_msg_count,
        boundary_type = EXCLUDED.boundary_type,
        boundary_meta = EXCLUDED.boundary_meta`,
      [
        sessionRowId,
        seg.segmentNo,
        seg.startMsgIdx !== null && seg.startMsgIdx !== undefined ? seg.startMsgIdx : null,
        seg.endMsgIdx !== null && seg.endMsgIdx !== undefined ? seg.endMsgIdx : null,
        seg.startedAt || null,
        seg.endedAt || null,
        seg.rawMsgCount || 0,
        seg.effectiveMsgCount || 0,
        seg.boundaryType || null,
        seg.boundaryMeta ? JSON.stringify(seg.boundaryMeta) : '{}',
      ]
    );
  }
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
       boundary_count, fresh_tail_count,
       started_at, ended_at, structured_summary, summary_text, embedding, updated_at)
    VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,0,0,$10,$11,COALESCE($12::jsonb,'{}'::jsonb),COALESCE($13,''),$14::vector,now())
    ON CONFLICT (session_row_id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      agent_id = EXCLUDED.agent_id,
      session_id = EXCLUDED.session_id,
      model = COALESCE(EXCLUDED.model, ${qi(schema)}.session_summaries.model),
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
      model || null, sourceHash || null,
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
// persistProcessingResults (@internal — prefer aquifer.enrich() for full pipeline)
// ---------------------------------------------------------------------------

async function persistProcessingResults(pool, sessionRowId, {
  schema,
  segments,
  summaryText,
  structuredSummary,
  agentId,
  sessionId,
  tenantId,
  model,
  sourceHash,
  msgCount,
  userCount,
  assistantCount,
  startedAt,
  endedAt,
  embedding,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (segments) await upsertSegments(client, sessionRowId, segments, { schema });
    await upsertSummary(client, sessionRowId, {
      schema, tenantId, agentId, sessionId, summaryText,
      structuredSummary, model, sourceHash,
      msgCount, userCount, assistantCount,
      startedAt, endedAt, embedding,
    });
    await markStatus(client, sessionRowId, 'succeeded', null, { schema });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    try {
      await markStatus(pool, sessionRowId, 'failed', err.message, { schema });
    } catch (_) { /* swallow */ }
    throw err;
  } finally {
    client.release();
  }
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
// getSessionFull
// ---------------------------------------------------------------------------

async function getSessionFull(pool, sessionId, agentId, { schema, tenantId } = {}) {
  const session = await getSession(pool, sessionId, agentId, { tenantId }, { schema, tenantId });
  if (!session) return null;

  const [segResult, sumResult] = await Promise.all([
    pool.query(
      `SELECT * FROM ${qi(schema)}.session_segments
      WHERE session_row_id = $1
      ORDER BY segment_no ASC`,
      [session.id]
    ),
    pool.query(
      `SELECT * FROM ${qi(schema)}.session_summaries
      WHERE session_row_id = $1
      LIMIT 1`,
      [session.id]
    ),
  ]);

  return {
    session,
    segments: segResult.rows,
    summary: sumResult.rows[0] || null,
  };
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
// searchSessions (FTS)
// ---------------------------------------------------------------------------

async function searchSessions(pool, query, {
  schema,
  tenantId,
  agentId,
  source,
  dateFrom,  // m1: add date filtering
  dateTo,
  limit = 20,
} = {}) {
  const clampedLimit = Math.max(1, Math.min(100, limit));
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
      ts_headline('simple', COALESCE(ss.summary_text, ''), plainto_tsquery('simple', $1)) AS summary_snippet,
      ts_rank(ss.search_tsv, plainto_tsquery('simple', $1)) AS fts_rank
    FROM ${qi(schema)}.sessions s
    LEFT JOIN ${qi(schema)}.session_summaries ss ON ss.session_row_id = s.id
    WHERE ss.search_tsv @@ plainto_tsquery('simple', $1)
      AND s.tenant_id = $2
      AND ($3::text IS NULL OR s.agent_id = $3)
      AND ($4::text IS NULL OR s.source = $4)
      AND ($5::date IS NULL OR s.started_at::date >= $5::date)
      AND ($6::date IS NULL OR s.started_at::date <= $6::date)
    ORDER BY fts_rank DESC, s.last_message_at DESC NULLS LAST
    LIMIT $7`,
    [query, tenantId, agentId || null, source || null, dateFrom || null, dateTo || null, clampedLimit]
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
    SET access_count = access_count + 1, last_accessed_at = now()
    WHERE session_row_id = ANY($1)`,
    [sessionRowIds]
  );
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

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const vec = vectors[i];
    if (!vec) continue;

    const contentHash = crypto.createHash('sha256').update(t.text).digest('hex').slice(0, 16);
    await pool.query(
      `INSERT INTO ${qi(schema)}.turn_embeddings
        (session_row_id, tenant_id, session_id, agent_id, source,
         turn_index, message_index, role, content_text, content_hash, embedding)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'user',$8,$9,$10::vector)
      ON CONFLICT (session_row_id, message_index) DO UPDATE SET
        content_text = EXCLUDED.content_text,
        content_hash = EXCLUDED.content_hash,
        embedding = CASE
          WHEN ${qi(schema)}.turn_embeddings.content_hash = EXCLUDED.content_hash
          THEN ${qi(schema)}.turn_embeddings.embedding
          ELSE EXCLUDED.embedding
        END`,
      [
        sessionRowId, tenantId, sessionId, agentId, source || null,
        t.turnIndex, t.messageIndex,
        t.text, contentHash, vecToStr(vec),
      ]
    );
  }
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
  source,
  limit = 15,
}) {
  const where = ['s.tenant_id = $1'];
  const params = [tenantId];

  if (dateFrom) {
    params.push(dateFrom);
    where.push(`($${params.length}::date IS NULL OR s.started_at::date >= $${params.length}::date)`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`($${params.length}::date IS NULL OR s.started_at::date <= $${params.length}::date)`);
  }
  if (agentId) {
    params.push(agentId);
    where.push(`t.agent_id = $${params.length}`);
  }
  if (source) {
    params.push(source);
    where.push(`t.source = $${params.length}`);
  }

  params.push(`[${queryVec.join(',')}]`);
  const vecPos = params.length;

  // m5: use subquery with LIMIT to avoid scanning all rows
  params.push(limit * 3); // fetch more than needed for DISTINCT ON dedup
  const innerLimitPos = params.length;

  const result = await pool.query(
    `SELECT * FROM (
      SELECT DISTINCT ON (t.session_row_id)
        s.session_id, s.id AS session_row_id, s.agent_id, s.source, s.started_at,
        ss.summary_text, ss.structured_summary, ss.access_count, ss.last_accessed_at,
        t.content_text AS matched_turn_text, t.turn_index AS matched_turn_index,
        (t.embedding <=> $${vecPos}::vector) AS turn_distance
      FROM ${qi(schema)}.turn_embeddings t
      JOIN ${qi(schema)}.sessions s ON s.id = t.session_row_id
      LEFT JOIN ${qi(schema)}.session_summaries ss ON ss.session_row_id = s.id
      WHERE ${where.join(' AND ')}
      ORDER BY t.session_row_id, turn_distance ASC
    ) sub
    ORDER BY turn_distance ASC
    LIMIT $${innerLimitPos}`,
    params
  );

  return { rows: result.rows.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  upsertSession,
  upsertSegments,
  upsertSummary,
  markStatus,
  persistProcessingResults,
  getSession,
  getSessionFull,
  getMessages,
  searchSessions,
  recordAccess,
  extractUserTurns,
  upsertTurnEmbeddings,
  searchTurnEmbeddings,
};
