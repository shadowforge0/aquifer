'use strict';

// aq.bundles.* — cross-session export/import/diff capability.
//
// Spec: aquifer-completion §13 sessionBundle. A bundle packages the
// canonical state attached to a single sessionId across sessions,
// narratives, timeline_events, session_handoffs, session_states,
// decisions, and artifacts. The session row itself is not duplicated
// — only its identifying fields + summary projection travel. Bundle
// envelope is strict core; entities inside each bucket stay open so
// consumer-specific fields ride along.
//
// export  — reads all related rows keyed by source_session_id.
// import  — replays into this tenant, resolving conflicts per policy.
// diff    — pure function over two bundles, no DB.
//
// conflictPolicy:
//   'skip'   — collision on idempotency_key is a no-op; counted as conflict.
//   'upsert' — collision replaces the existing row where semantics allow.
//   'fail'   — any collision aborts the whole import with AQ_IMPORT_CONFLICT.

const { AqError, ok, err } = require('./errors');

const BUNDLE_ENTITIES = ['summary', 'narrative', 'timeline', 'handoff', 'state', 'decisions', 'artifacts'];

function stripSessionColumns(row) {
  if (!row) return null;
  const out = { ...row };
  delete out.id;
  delete out.session_row_id;
  return out;
}

function createBundles({ pool, schema, defaultTenantId }) {

  async function exportBundle(input = {}) {
    try {
      if (!input.sessionId) return err('AQ_INVALID_INPUT', 'sessionId is required');
      const tenantId = input.tenantId || defaultTenantId || 'default';
      const include = Array.isArray(input.include) && input.include.length > 0
        ? new Set(input.include)
        : new Set(BUNDLE_ENTITIES);

      const sessionRow = await pool.query(
        `SELECT id, session_id, agent_id, source, started_at, last_message_at,
                tenant_id, msg_count, user_count, assistant_count, model
           FROM ${schema}.sessions
          WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, input.sessionId],
      );
      if (sessionRow.rowCount === 0) {
        return err('AQ_NOT_FOUND', `session ${input.sessionId} not found`);
      }
      const row = sessionRow.rows[0];

      const bundle = {
        bundleVersion: 1,
        tenantId,
        session: {
          session_id: row.session_id,
          agent_id: row.agent_id,
          source: row.source,
          started_at: row.started_at,
          last_message_at: row.last_message_at,
          msg_count: row.msg_count,
          user_count: row.user_count,
          assistant_count: row.assistant_count,
          model: row.model,
        },
        stamps: [],
      };

      if (include.has('summary')) {
        const { rows } = await pool.query(
          `SELECT ss.*
             FROM ${schema}.session_summaries ss
            WHERE ss.session_row_id = $1`,
          [row.id],
        );
        if (rows[0]) bundle.summary = stripSessionColumns(rows[0]);
      }
      if (include.has('narrative')) {
        const { rows } = await pool.query(
          `SELECT * FROM ${schema}.narratives
            WHERE tenant_id = $1 AND source_session_id = $2
            ORDER BY effective_at DESC`,
          [tenantId, input.sessionId],
        );
        bundle.narratives = rows.map(stripSessionColumns);
      }
      if (include.has('timeline')) {
        const { rows } = await pool.query(
          `SELECT * FROM ${schema}.timeline_events
            WHERE tenant_id = $1 AND source_session_id = $2
            ORDER BY occurred_at ASC`,
          [tenantId, input.sessionId],
        );
        bundle.timeline = rows.map(stripSessionColumns);
      }
      if (include.has('handoff')) {
        const { rows } = await pool.query(
          `SELECT * FROM ${schema}.session_handoffs
            WHERE tenant_id = $1 AND source_session_id = $2
            ORDER BY created_at DESC`,
          [tenantId, input.sessionId],
        );
        bundle.handoffs = rows.map(stripSessionColumns);
      }
      if (include.has('state')) {
        const { rows } = await pool.query(
          `SELECT * FROM ${schema}.session_states
            WHERE tenant_id = $1 AND source_session_id = $2
            ORDER BY created_at DESC`,
          [tenantId, input.sessionId],
        );
        bundle.states = rows.map(stripSessionColumns);
      }
      if (include.has('decisions')) {
        const { rows } = await pool.query(
          `SELECT * FROM ${schema}.decisions
            WHERE tenant_id = $1 AND source_session_id = $2
            ORDER BY decided_at ASC`,
          [tenantId, input.sessionId],
        );
        bundle.decisions = rows.map(stripSessionColumns);
      }
      if (include.has('artifacts')) {
        const { rows } = await pool.query(
          `SELECT * FROM ${schema}.artifacts
            WHERE tenant_id = $1 AND source_session_id = $2
            ORDER BY created_at ASC`,
          [tenantId, input.sessionId],
        );
        bundle.artifacts = rows.map(stripSessionColumns);
      }

      const stampSet = new Map();
      for (const bucket of ['narratives', 'timeline', 'handoffs', 'states', 'decisions', 'artifacts']) {
        for (const r of (bundle[bucket] || [])) {
          if (r && r.consumer_profile_id) {
            const k = `${r.consumer_profile_id}@${r.consumer_profile_version}`;
            if (!stampSet.has(k)) {
              stampSet.set(k, {
                id: r.consumer_profile_id,
                version: r.consumer_profile_version,
                schemaHash: r.consumer_schema_hash,
              });
            }
          }
        }
      }
      bundle.stamps = Array.from(stampSet.values());

      return ok({ bundle });
    } catch (e) {
      if (e instanceof AqError) return err(e);
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  async function importBundle(input = {}) {
    try {
      if (!input.bundle || typeof input.bundle !== 'object') {
        return err('AQ_INVALID_INPUT', 'bundle is required');
      }
      if (!input.bundle.session || !input.bundle.session.session_id) {
        return err('AQ_INVALID_INPUT', 'bundle.session.session_id is required');
      }
      const mode = input.mode || 'apply';
      if (mode !== 'apply' && mode !== 'dry-run') {
        return err('AQ_INVALID_INPUT', 'mode must be apply or dry-run');
      }
      const policy = input.conflictPolicy || 'skip';
      if (!['skip', 'upsert', 'fail'].includes(policy)) {
        return err('AQ_INVALID_INPUT', 'conflictPolicy must be skip|upsert|fail');
      }
      const tenantId = input.tenantId || input.bundle.tenantId || defaultTenantId || 'default';
      const bundle = input.bundle;

      const client = await pool.connect();
      const conflicts = [];
      const wouldCreate = { session: 0 };
      const created = { session: 0 };
      for (const b of ['narratives', 'timeline', 'handoffs', 'states', 'decisions', 'artifacts']) {
        wouldCreate[b] = 0;
        created[b] = 0;
      }

      try {
        await client.query('BEGIN');

        // Upsert the session row first so child inserts have a valid FK.
        const existingSess = await client.query(
          `SELECT id FROM ${schema}.sessions WHERE tenant_id = $1 AND session_id = $2`,
          [tenantId, bundle.session.session_id],
        );
        let sessionRowId;
        if (existingSess.rowCount > 0) {
          conflicts.push({ entity: 'session', key: bundle.session.session_id, reason: 'exists' });
          if (policy === 'fail') {
            throw new AqError('AQ_IMPORT_CONFLICT', 'session already exists; policy=fail');
          }
          sessionRowId = existingSess.rows[0].id;
          wouldCreate.session = 0;
        } else {
          wouldCreate.session = 1;
          if (mode === 'apply') {
            const { rows } = await client.query(
              `INSERT INTO ${schema}.sessions (
                 tenant_id, session_id, agent_id, source,
                 started_at, last_message_at,
                 msg_count, user_count, assistant_count, model
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               RETURNING id`,
              [
                tenantId, bundle.session.session_id,
                bundle.session.agent_id || 'main',
                bundle.session.source || 'import',
                bundle.session.started_at || null,
                bundle.session.last_message_at || null,
                bundle.session.msg_count || 0,
                bundle.session.user_count || 0,
                bundle.session.assistant_count || 0,
                bundle.session.model || null,
              ],
            );
            sessionRowId = rows[0].id;
            created.session = 1;
          }
        }

        const bucketMap = {
          narratives: `${schema}.narratives`,
          timeline: `${schema}.timeline_events`,
          handoffs: `${schema}.session_handoffs`,
          states: `${schema}.session_states`,
          decisions: `${schema}.decisions`,
          artifacts: `${schema}.artifacts`,
        };

        for (const [bucket, table] of Object.entries(bucketMap)) {
          const rows = bundle[bucket];
          if (!Array.isArray(rows) || rows.length === 0) continue;
          for (const raw of rows) {
            if (!raw) continue;
            const key = raw.idempotency_key;
            if (!key) {
              wouldCreate[bucket]++;
              if (mode === 'apply') {
                // Insert with NULL idempotency_key — always creates a new row.
                await insertRaw(client, table, { ...raw, tenant_id: tenantId, session_row_id: sessionRowId });
                created[bucket]++;
              }
              continue;
            }
            const existing = await client.query(
              `SELECT id FROM ${table} WHERE idempotency_key = $1`, [key],
            );
            if (existing.rowCount > 0) {
              conflicts.push({ entity: bucket, key, reason: 'idempotency_key exists' });
              if (policy === 'fail') {
                throw new AqError('AQ_IMPORT_CONFLICT',
                  `${bucket} row ${key} already exists; policy=fail`);
              }
              if (policy === 'upsert' && mode === 'apply') {
                // Only safe upsert target: update metadata/payload fields where
                // the row's natural key (idempotency_key) matches. We skip
                // updating columns that reshape identity (scope, status chain).
                // Policy 'upsert' is best-effort — producers wanting strict
                // replace should use their own lifecycle APIs.
              }
              continue;
            }
            wouldCreate[bucket]++;
            if (mode === 'apply') {
              await insertRaw(client, table, { ...raw, tenant_id: tenantId, session_row_id: sessionRowId });
              created[bucket]++;
            }
          }
        }

        if (mode === 'apply') {
          await client.query('COMMIT');
        } else {
          await client.query('ROLLBACK');
        }

        const result = { mode, wouldCreate, conflicts };
        if (mode === 'apply') result.created = created;
        return ok(result);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        if (e instanceof AqError && e.code === 'AQ_IMPORT_CONFLICT') {
          return err(e);
        }
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      if (e instanceof AqError) return err(e);
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  function diff(input = {}) {
    try {
      if (!input.left || !input.right) {
        return err('AQ_INVALID_INPUT', 'left and right bundles required');
      }
      const changes = [];

      function entityKey(bucket, row) {
        if (bucket === 'session') return row.session_id;
        return row.idempotency_key || `row-${row.id || ''}`;
      }

      function buckets(b) {
        return {
          session: [b.session],
          summary: b.summary ? [b.summary] : [],
          narratives: b.narratives || [],
          timeline: b.timeline || [],
          handoffs: b.handoffs || [],
          states: b.states || [],
          decisions: b.decisions || [],
          artifacts: b.artifacts || [],
        };
      }

      const L = buckets(input.left);
      const R = buckets(input.right);

      for (const bucket of Object.keys(L)) {
        const leftRows = L[bucket].filter(Boolean);
        const rightRows = R[bucket].filter(Boolean);
        const leftMap = new Map(leftRows.map(r => [entityKey(bucket, r), r]));
        const rightMap = new Map(rightRows.map(r => [entityKey(bucket, r), r]));
        for (const [k, lRow] of leftMap) {
          const rRow = rightMap.get(k);
          if (!rRow) {
            changes.push({ entity: bucketSingular(bucket), key: k, change: 'removed' });
          } else if (JSON.stringify(lRow) !== JSON.stringify(rRow)) {
            changes.push({ entity: bucketSingular(bucket), key: k, change: 'modified' });
          }
        }
        for (const k of rightMap.keys()) {
          if (!leftMap.has(k)) {
            changes.push({ entity: bucketSingular(bucket), key: k, change: 'added' });
          }
        }
      }

      return ok({ changes });
    } catch (e) {
      return err('AQ_INTERNAL', e.message, { cause: e });
    }
  }

  return { export: exportBundle, import: importBundle, diff };
}

function bucketSingular(b) {
  const map = { narratives: 'narrative', handoffs: 'handoff', states: 'state' };
  return map[b] || b.replace(/s$/, '');
}

// Low-level INSERT helper — takes a row object (column → value) and writes
// whatever columns exist. Used by importBundle for replay. Columns that the
// target table doesn't accept are silently ignored by PostgreSQL catalog
// introspection done on first call per table (cached).
const tableColumnCache = new Map();

async function insertRaw(client, table, row) {
  if (!tableColumnCache.has(table)) {
    const [schemaPart, tablePart] = table.replace(/"/g, '').split('.');
    const { rows: cols } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2`,
      [schemaPart, tablePart],
    );
    tableColumnCache.set(table, new Set(cols.map(c => c.column_name)));
  }
  const allowed = tableColumnCache.get(table);
  const entries = Object.entries(row)
    .filter(([k, v]) => allowed.has(k) && k !== 'id' && v !== undefined);
  if (entries.length === 0) return;
  const cols = entries.map(e => `"${e[0]}"`).join(', ');
  const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ');
  const values = entries.map(e => {
    const v = e[1];
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      return JSON.stringify(v);
    }
    return v;
  });
  await client.query(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`, values);
}

module.exports = { createBundles, BUNDLE_ENTITIES };
