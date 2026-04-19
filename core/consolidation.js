'use strict';

// aq.consolidation.* — session-level multi-phase orchestration.
//
// Spec: aquifer-completion §3 consolidationOrchestration. State lives in
// sessions.consolidation_phases JSONB keyed by phase name. 10 phases cover
// the post-session pipeline: summary_extract, entity_extract, fact_extract,
// fact_consolidation, narrative_refresh, decision_write, handoff_write,
// session_state_write, timeline_write, artifact_dispatch.
//
// Status vocabulary: pending|claimed|running|succeeded|failed|skipped.
// State transitions (enforced by transitionPhase):
//   pending  → claimed
//   claimed  → running|failed|skipped|claimed (stale reclaim only)
//   running  → succeeded|failed|claimed (stale reclaim only)
//   failed   → claimed (retry)
//   succeeded|skipped → non-terminal requires forceReplay=true
//
// Advisory lock (pg_advisory_xact_lock on session_row_id) wraps the
// read-modify-write in a transaction so two workers can't claim the same
// session phase simultaneously.

const crypto = require('crypto');
const { AqError, ok, err } = require('./errors');

const PHASES = Object.freeze([
  'summary_extract',
  'entity_extract',
  'fact_extract',
  'fact_consolidation',
  'narrative_refresh',
  'decision_write',
  'handoff_write',
  'session_state_write',
  'timeline_write',
  'artifact_dispatch',
]);
const PHASE_SET = new Set(PHASES);

const STATUSES = Object.freeze([
  'pending', 'claimed', 'running', 'succeeded', 'failed', 'skipped',
]);
const STATUS_SET = new Set(STATUSES);

const TERMINAL = new Set(['succeeded', 'skipped']);

// Valid transitions. Caller must specify fromStatus to guard against races.
const VALID_TRANSITIONS = {
  pending: new Set(['claimed']),
  claimed: new Set(['running', 'failed', 'skipped', 'claimed']),
  running: new Set(['succeeded', 'failed', 'claimed']),
  failed: new Set(['claimed']),
  succeeded: new Set([]),
  skipped: new Set([]),
};

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function emptyPhaseState() {
  return { status: 'pending', attempts: 0 };
}

function fillDefaults(phasesJson) {
  const out = { ...(phasesJson || {}) };
  for (const phase of PHASES) {
    if (!out[phase]) out[phase] = emptyPhaseState();
  }
  return out;
}

function isStale(phaseState, staleAfterSeconds) {
  if (phaseState.status !== 'claimed' && phaseState.status !== 'running') return false;
  const startedAt = phaseState.startedAt;
  if (!startedAt) return true;
  const ageMs = Date.now() - new Date(startedAt).getTime();
  return ageMs > staleAfterSeconds * 1000;
}

function newClaimToken() {
  return crypto.randomBytes(12).toString('hex');
}

function advisoryLockKey(sessionRowId) {
  // Map bigint-ish id to signed int4 range for pg_advisory_xact_lock.
  const id = Number(sessionRowId);
  return (id ^ 0x9e3779b9) & 0x7fffffff;
}

function createConsolidation({ pool, schema, defaultTenantId }) {

  async function claimNext(input = {}) {
    try {
      if (!input.workerId) return err('AQ_INVALID_INPUT', 'workerId is required');
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const phases = Array.isArray(input.phases) && input.phases.length > 0
        ? input.phases.filter(p => PHASE_SET.has(p))
        : PHASES;
      if (phases.length === 0) {
        return err('AQ_INVALID_INPUT', 'phases filter produced empty list');
      }
      const staleAfterSeconds = Number.isFinite(input.staleAfterSeconds)
        ? Math.max(10, input.staleAfterSeconds)
        : 600;

      // Look at candidate sessions with at least one non-terminal phase,
      // then iterate under advisory lock to claim atomically.
      const candidates = await pool.query(
        `SELECT id AS session_row_id, session_id, agent_id, processing_status,
                consolidation_phases
           FROM ${schema}.sessions
          WHERE tenant_id = $1
          ORDER BY id ASC
          LIMIT 200`,
        [tenantId],
      );

      for (const row of candidates.rows) {
        const current = fillDefaults(row.consolidation_phases);
        let targetPhase = null;
        for (const p of phases) {
          const st = current[p];
          if (st.status === 'pending' || st.status === 'failed') {
            targetPhase = p; break;
          }
          if ((st.status === 'claimed' || st.status === 'running')
              && isStale(st, staleAfterSeconds)) {
            targetPhase = p; break;
          }
        }
        if (!targetPhase) continue;

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock($1)',
            [advisoryLockKey(row.session_row_id)]);

          // Re-read under lock — another worker may have claimed in between.
          const { rows: freshRows } = await client.query(
            `SELECT consolidation_phases FROM ${schema}.sessions WHERE id = $1`,
            [row.session_row_id],
          );
          const fresh = fillDefaults(freshRows[0] && freshRows[0].consolidation_phases);
          const freshState = fresh[targetPhase];
          const eligible =
            freshState.status === 'pending'
            || freshState.status === 'failed'
            || ((freshState.status === 'claimed' || freshState.status === 'running')
                && isStale(freshState, staleAfterSeconds));
          if (!eligible) {
            await client.query('ROLLBACK');
            client.release();
            continue;
          }

          const claimToken = newClaimToken();
          const attempts = (freshState.attempts || 0) + 1;
          fresh[targetPhase] = {
            ...freshState,
            status: 'claimed',
            claimToken,
            workerId: input.workerId,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            attempts,
            errorCode: null,
            errorMessage: null,
          };

          await client.query(
            `UPDATE ${schema}.sessions SET consolidation_phases = $1
              WHERE id = $2`,
            [JSON.stringify(fresh), row.session_row_id],
          );
          await client.query('COMMIT');
          client.release();

          return ok({
            session: {
              sessionRowId: toNumber(row.session_row_id),
              sessionId: row.session_id,
              agentId: row.agent_id,
              processingStatus: row.processing_status,
              phases: fresh,
            },
            claimToken,
            claimedPhase: targetPhase,
          });
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          client.release();
          throw e;
        }
      }

      return ok({ session: null, claimToken: null, claimedPhase: null });
    } catch (e) {
      if (e instanceof AqError) return err(e);
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  async function transitionPhase(input = {}) {
    try {
      if (!input.sessionId) return err('AQ_INVALID_INPUT', 'sessionId is required');
      if (!input.phase || !PHASE_SET.has(input.phase)) {
        return err('AQ_INVALID_INPUT', `phase must be one of ${PHASES.join(', ')}`);
      }
      if (!input.fromStatus || !STATUS_SET.has(input.fromStatus)) {
        return err('AQ_INVALID_INPUT', 'valid fromStatus is required');
      }
      if (!input.toStatus || !STATUS_SET.has(input.toStatus)) {
        return err('AQ_INVALID_INPUT', 'valid toStatus is required');
      }
      const tenantId = input.tenantId || defaultTenantId || 'default';

      const sessionRow = await pool.query(
        `SELECT id FROM ${schema}.sessions WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, input.sessionId],
      );
      if (sessionRow.rowCount === 0) {
        return err('AQ_NOT_FOUND', `session ${input.sessionId} not found`);
      }
      const sessionRowId = sessionRow.rows[0].id;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)',
          [advisoryLockKey(sessionRowId)]);

        const { rows } = await client.query(
          `SELECT consolidation_phases FROM ${schema}.sessions WHERE id = $1`,
          [sessionRowId],
        );
        const phases = fillDefaults(rows[0] && rows[0].consolidation_phases);
        const current = phases[input.phase];

        // Guard: fromStatus must match current.
        if (current.status !== input.fromStatus) {
          await client.query('ROLLBACK');
          return err('AQ_PHASE_CLAIM_CONFLICT',
            `phase ${input.phase} currently ${current.status}, not ${input.fromStatus}`);
        }

        // Guard: claimToken must match when transitioning from claimed/running.
        if ((input.fromStatus === 'claimed' || input.fromStatus === 'running')
            && input.claimToken && current.claimToken !== input.claimToken) {
          await client.query('ROLLBACK');
          return err('AQ_PHASE_CLAIM_CONFLICT',
            `claimToken mismatch for phase ${input.phase}`);
        }

        // Validate transition.
        const allowed = VALID_TRANSITIONS[input.fromStatus] || new Set();
        if (!allowed.has(input.toStatus)) {
          // Terminal → non-terminal requires forceReplay.
          const leavingTerminal = TERMINAL.has(input.fromStatus);
          if (!(leavingTerminal && input.forceReplay === true)) {
            await client.query('ROLLBACK');
            return err('AQ_PHASE_TRANSITION_INVALID',
              `cannot transition ${input.phase} from ${input.fromStatus} to ${input.toStatus}`);
          }
        }

        const next = { ...current, status: input.toStatus };
        if (input.toStatus === 'running') {
          next.startedAt = current.startedAt || new Date().toISOString();
        }
        if (input.toStatus === 'succeeded' || input.toStatus === 'failed'
            || input.toStatus === 'skipped') {
          next.finishedAt = new Date().toISOString();
          if (input.toStatus === 'succeeded' || input.toStatus === 'skipped') {
            next.errorCode = null;
            next.errorMessage = null;
          }
        }
        if (input.toStatus === 'failed' && input.error) {
          next.errorCode = input.error.code || 'AQ_INTERNAL';
          next.errorMessage = input.error.message || '';
        }
        if (input.retryAfter) next.retryAfter = input.retryAfter;
        if (input.idempotencyKey) next.idempotencyKey = input.idempotencyKey;
        if (input.outputRef) next.outputRef = { ...(current.outputRef || {}), ...input.outputRef };

        phases[input.phase] = next;

        await client.query(
          `UPDATE ${schema}.sessions SET consolidation_phases = $1 WHERE id = $2`,
          [JSON.stringify(phases), sessionRowId],
        );
        await client.query('COMMIT');

        return ok({
          sessionId: input.sessionId,
          phase: input.phase,
          state: next,
        });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      if (e instanceof AqError) return err(e);
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  async function getState(input = {}) {
    try {
      if (!input.sessionId) return err('AQ_INVALID_INPUT', 'sessionId is required');
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const { rows } = await pool.query(
        `SELECT processing_status, consolidation_phases
           FROM ${schema}.sessions
          WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, input.sessionId],
      );
      if (rows.length === 0) {
        return err('AQ_NOT_FOUND', `session ${input.sessionId} not found`);
      }
      return ok({
        processingStatus: rows[0].processing_status,
        phases: fillDefaults(rows[0].consolidation_phases),
      });
    } catch (e) {
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  return { claimNext, transitionPhase, getState, PHASES, STATUSES };
}

module.exports = { createConsolidation, PHASES, STATUSES };
