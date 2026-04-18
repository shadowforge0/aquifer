'use strict';

// ---------------------------------------------------------------------------
// Consolidation apply — executes a batch of fact-lifecycle actions in one tx.
//
// Actions (each object in the array):
//   { action: 'promote',   factId }                          candidate → active
//   { action: 'create',    subject, statement, importance? } new active fact
//   { action: 'update',    factId, statement }               refresh active statement
//   { action: 'confirm',   factId }                          bump last_confirmed_at
//   { action: 'stale',     factId }                          active → stale
//   { action: 'discard',   factId }                          candidate → archived
//   { action: 'merge',     factId, targetId }                candidate archived, target confirmed
//   { action: 'supersede', factId, targetId }                active → superseded by target
//
// All mutations scoped to (tenantId, agentId). The caller is responsible for
// providing a normalizer for subject_key (fall back to raw subject if absent).
// ---------------------------------------------------------------------------

function qi(identifier) { return `"${identifier}"`; }

async function applyConsolidation(pool, {
  actions,
  agentId,
  sessionId,
  schema,
  tenantId = 'default',
  normalizeSubject = null,
  recapOverview = '',
} = {}) {
  if (!pool) throw new Error('pool is required');
  if (!schema) throw new Error('schema is required');
  if (!agentId) throw new Error('agentId is required');
  if (!Array.isArray(actions)) throw new Error('actions must be an array');

  const tbl = `${qi(schema)}.facts`;
  const summary = {
    promote: 0, create: 0, update: 0, confirm: 0,
    stale: 0, discard: 0, merge: 0, supersede: 0,
    skipped: 0,
  };

  if (actions.length === 0) return summary;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const act of actions) {
      switch (act.action) {
        case 'promote': {
          const r = await client.query(
            `UPDATE ${tbl} SET status = 'active', last_confirmed_at = now()
             WHERE id = $1 AND status = 'candidate' AND agent_id = $2 AND tenant_id = $3`,
            [act.factId, agentId, tenantId],
          );
          summary.promote += r.rowCount;
          if (r.rowCount === 0) summary.skipped++;
          break;
        }

        case 'create': {
          const subjectLabel = act.subject ? String(act.subject).slice(0, 200) : '';
          const subjectKey = normalizeSubject ? normalizeSubject(subjectLabel) : subjectLabel.trim().toLowerCase();
          if (!subjectKey) { summary.skipped++; break; }
          const statement = act.statement ? String(act.statement).slice(0, 2000) : '';
          if (!statement) { summary.skipped++; break; }
          const importance = Number.isFinite(act.importance) ? act.importance : 7;
          const evidence = JSON.stringify([{
            type: 'session_ref',
            session_id: sessionId || null,
            excerpt: (recapOverview || '').slice(0, 200),
          }]);
          const r = await client.query(
            `INSERT INTO ${tbl}
             (tenant_id, subject_key, subject_label, statement, status, importance,
              source_session_id, agent_id, evidence)
             VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8::jsonb)
             ON CONFLICT DO NOTHING`,
            [tenantId, subjectKey, subjectLabel, statement, importance, sessionId || null, agentId, evidence],
          );
          summary.create += r.rowCount;
          if (r.rowCount === 0) summary.skipped++;
          break;
        }

        case 'update': {
          const statement = act.statement ? String(act.statement).slice(0, 2000) : '';
          if (!statement) { summary.skipped++; break; }
          const r = await client.query(
            `UPDATE ${tbl} SET statement = $1, last_confirmed_at = now()
             WHERE id = $2 AND status = 'active' AND agent_id = $3 AND tenant_id = $4`,
            [statement, act.factId, agentId, tenantId],
          );
          summary.update += r.rowCount;
          if (r.rowCount === 0) summary.skipped++;
          break;
        }

        case 'confirm': {
          const r = await client.query(
            `UPDATE ${tbl} SET last_confirmed_at = now()
             WHERE id = $1 AND status = 'active' AND agent_id = $2 AND tenant_id = $3`,
            [act.factId, agentId, tenantId],
          );
          summary.confirm += r.rowCount;
          if (r.rowCount === 0) summary.skipped++;
          break;
        }

        case 'stale': {
          const r = await client.query(
            `UPDATE ${tbl} SET status = 'stale'
             WHERE id = $1 AND status = 'active' AND agent_id = $2 AND tenant_id = $3`,
            [act.factId, agentId, tenantId],
          );
          summary.stale += r.rowCount;
          if (r.rowCount === 0) summary.skipped++;
          break;
        }

        case 'discard': {
          const r = await client.query(
            `UPDATE ${tbl} SET status = 'archived'
             WHERE id = $1 AND status = 'candidate' AND agent_id = $2 AND tenant_id = $3`,
            [act.factId, agentId, tenantId],
          );
          summary.discard += r.rowCount;
          if (r.rowCount === 0) summary.skipped++;
          break;
        }

        case 'merge': {
          const r1 = await client.query(
            `UPDATE ${tbl} SET last_confirmed_at = now()
             WHERE id = $1 AND status = 'active' AND tenant_id = $2`,
            [act.targetId, tenantId],
          );
          const r2 = await client.query(
            `UPDATE ${tbl} SET status = 'archived'
             WHERE id = $1 AND status = 'candidate' AND tenant_id = $2`,
            [act.factId, tenantId],
          );
          summary.merge += Math.min(r1.rowCount, r2.rowCount);
          if (r1.rowCount === 0 || r2.rowCount === 0) summary.skipped++;
          break;
        }

        case 'supersede': {
          const r = await client.query(
            `UPDATE ${tbl} SET status = 'superseded', superseded_by = $1
             WHERE id = $2 AND status = 'active' AND tenant_id = $3`,
            [act.targetId, act.factId, tenantId],
          );
          summary.supersede += r.rowCount;
          if (r.rowCount === 0) summary.skipped++;
          break;
        }

        default:
          summary.skipped++;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return summary;
}

module.exports = { applyConsolidation };
