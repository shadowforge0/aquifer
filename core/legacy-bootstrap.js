'use strict';

const { qi } = require('./postgres-migrations');

function normalizeSessionRow(row = {}) {
  const ss = row.structured_summary || {};
  const hasStructuredSummary = ss.title || ss.overview;
  const summaryText = row.summary_text || '';
  return {
    sessionId: row.session_id,
    agentId: row.agent_id,
    source: row.source,
    startedAt: row.started_at,
    title: ss.title || (hasStructuredSummary ? null : summaryText.slice(0, 60).trim() || null),
    overview: ss.overview || (hasStructuredSummary ? null : summaryText.slice(0, 200).trim() || null),
    topics: Array.isArray(ss.topics) ? ss.topics : [],
    decisions: Array.isArray(ss.decisions) ? ss.decisions : [],
    openLoops: Array.isArray(ss.open_loops) ? ss.open_loops : [],
    importantFacts: Array.isArray(ss.important_facts) ? ss.important_facts : [],
  };
}

function collectOpenLoops(sessions = []) {
  const sentinels = new Set(['無', 'none', 'n/a', 'na', 'done', '']);
  const seen = new Set();
  const openLoops = [];

  for (const session of sessions) {
    for (const loop of session.openLoops) {
      const raw = typeof loop === 'string' ? loop : (loop.item || '');
      const normalized = raw.trim().replace(/\s+/g, ' ').toLowerCase();
      if (sentinels.has(normalized) || !normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      openLoops.push({
        item: raw.trim(),
        fromSession: session.sessionId,
        latestStartedAt: session.startedAt,
      });
    }
  }

  return openLoops;
}

function collectRecentDecisions(sessions = []) {
  const seen = new Set();
  const recentDecisions = [];

  for (const session of sessions) {
    for (const decision of session.decisions) {
      const raw = typeof decision === 'string' ? decision : (decision.decision || '');
      const normalized = raw.trim().replace(/\s+/g, ' ').toLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      recentDecisions.push({
        decision: raw.trim(),
        reason: decision.reason || null,
        fromSession: session.sessionId,
      });
    }
  }

  return recentDecisions;
}

function createLegacyBootstrap({ pool, schema, tenantId, formatBootstrapText }) {
  const qSchema = qi(schema);
  const visibleSummary = `NOT (
    COALESCE(ss.summary_text, '') ~* '(空測試會話|x 字元填充|placeholder)'
    OR COALESCE(ss.structured_summary::text, '') ~* '(空測試會話|x 字元填充|placeholder)'
  )`;

  return async function legacyBootstrap(opts = {}) {
    const agentId = opts.agentId || null;
    const source = opts.source || null;
    const limit = Math.max(1, Math.min(20, opts.limit || 5));
    const lookbackDays = opts.lookbackDays || 14;
    const maxChars = opts.maxChars || 4000;
    const format = opts.format || 'structured';

    // 'partial' sessions have a summary plus enrich warnings; they are
    // user-visible content, unlike pending/processing sessions.
    const where = [
      `s.tenant_id = $1`,
      `s.processing_status IN ('succeeded', 'partial')`,
      visibleSummary,
    ];
    const params = [tenantId];

    if (agentId) {
      params.push(agentId);
      where.push(`s.agent_id = $${params.length}`);
    }
    if (source) {
      params.push(source);
      where.push(`s.source = $${params.length}`);
    }

    params.push(lookbackDays);
    // upsertSession sets ended_at on every commit; started_at/last_message_at
    // can be absent when callers did not supply explicit timestamps.
    where.push(`COALESCE(s.last_message_at, s.ended_at, s.started_at) > now() - ($${params.length} || ' days')::interval`);

    params.push(limit);

    const result = await pool.query(
      `SELECT s.session_id, s.agent_id, s.source, s.started_at, s.msg_count,
              ss.summary_text, ss.structured_summary
       FROM ${qSchema}.sessions s
       JOIN ${qSchema}.session_summaries ss ON ss.session_row_id = s.id
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(s.last_message_at, s.ended_at, s.started_at) DESC
       LIMIT $${params.length}`,
      params
    );

    const sessions = result.rows.map(normalizeSessionRow);
    const structured = {
      sessions,
      openLoops: collectOpenLoops(sessions),
      recentDecisions: collectRecentDecisions(sessions),
      meta: { lookbackDays, count: sessions.length, maxChars, truncated: false },
    };

    if (format === 'text' || format === 'both') {
      const textResult = formatBootstrapText(structured, maxChars);
      structured.text = textResult.text;
      structured.meta.truncated = textResult.truncated;
    }

    return structured;
  };
}

module.exports = {
  collectOpenLoops,
  collectRecentDecisions,
  createLegacyBootstrap,
  normalizeSessionRow,
};
