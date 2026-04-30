'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_RE = /^[a-zA-Z_]\w{0,62}$/;

function validateSchema(schema) {
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`Invalid schema name: "${schema}". Must match /^[a-zA-Z_]\\w{0,62}$/`);
  }
}

function qi(identifier) {
  return `"${identifier}"`;
}

function loadSql(filename, schema) {
  const filePath = path.join(__dirname, '..', 'schema', filename);
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.replace(/\$\{schema\}/g, qi(schema));
}

const MIGRATION_PLAN = [
  { id: '001-base',                file: '001-base.sql',                always: true, signature: 'sessions' },
  { id: '002-entities',            file: '002-entities.sql',            gate: 'entities', signature: 'entities' },
  { id: '003-trust-feedback',      file: '003-trust-feedback.sql',      always: true, signature: 'session_feedback' },
  { id: '004-facts',               file: '004-facts.sql',               gate: 'facts', signature: 'facts' },
  { id: '004-completion',          file: '004-completion.sql',          always: true, signature: 'narratives' },
  { id: '005-entity-state-history',file: '005-entity-state-history.sql',gate: 'entities', signature: 'entity_state_history' },
  { id: '006-insights',            file: '006-insights.sql',            always: true, signature: 'insights' },
  { id: '007-v1-foundation',       file: '007-v1-foundation.sql',       always: true, signature: 'memory_records' },
  { id: '008-session-finalizations',file: '008-session-finalizations.sql',always: true, signature: 'session_finalizations' },
  { id: '009-v1-assertion-plane',  file: '009-v1-assertion-plane.sql',  always: true, signature: 'fact_assertions_v1' },
  { id: '010-v1-finalization-review',file: '010-v1-finalization-review.sql',always: true, signature: 'finalization_candidates' },
  { id: '011-v1-compaction-claim', file: '011-v1-compaction-claim.sql', always: true, signature: { table: 'compaction_runs', column: 'apply_token' } },
  { id: '012-v1-compaction-lease', file: '012-v1-compaction-lease.sql', always: true, signature: { table: 'compaction_runs', column: 'lease_expires_at' } },
  { id: '013-v1-compaction-lineage', file: '013-v1-compaction-lineage.sql', always: true, signature: 'compaction_candidates' },
  {
    id: '014-v1-checkpoint-runs',
    file: '014-v1-checkpoint-runs.sql',
    always: true,
    signature: [
      { table: 'session_finalizations', column: 'scope_snapshot' },
      { table: 'checkpoint_runs', column: 'scope_id' },
      { table: 'checkpoint_run_sources', column: 'finalization_id' },
    ],
  },
  {
    id: '015-v1-evidence-items',
    file: '015-v1-evidence-items.sql',
    always: true,
    signature: [
      'evidence_items',
      { table: 'evidence_refs', column: 'evidence_item_id' },
    ],
  },
  {
    id: '016-v1-evidence-ref-multi-item',
    file: '016-v1-evidence-ref-multi-item.sql',
    always: true,
    signature: [
      { index: 'idx_evidence_refs_source_dedupe' },
      { index: 'idx_evidence_refs_evidence_item_dedupe' },
    ],
  },
  {
    id: '017-v1-memory-record-embeddings',
    file: '017-v1-memory-record-embeddings.sql',
    always: true,
    signature: [
      { table: 'memory_records', column: 'embedding' },
    ],
  },
];

function createPostgresMigrationRuntime(opts = {}) {
  const {
    pool,
    schema,
    migrations = {},
    getEntitiesEnabled = () => false,
    getFactsEnabled = () => false,
    initialFtsConfig = null,
  } = opts;

  let migrated = false;
  let migratePromise = null;
  let ftsConfig = initialFtsConfig;

  const migrationsMode = (() => {
    const raw = migrations.mode;
    if (raw === 'apply' || raw === 'check' || raw === 'off') return raw;
    if (raw === undefined || raw === null) return 'apply';
    throw new Error(`config.migrations.mode must be 'apply' | 'check' | 'off' (got ${JSON.stringify(raw)})`);
  })();
  const migrationLockTimeoutMs = Number.isFinite(migrations.lockTimeoutMs)
    ? Math.max(0, migrations.lockTimeoutMs) : 30000;
  const migrationStartupTimeoutMs = Number.isFinite(migrations.startupTimeoutMs)
    ? Math.max(0, migrations.startupTimeoutMs) : 60000;
  const migrationOnEvent = typeof migrations.onEvent === 'function' ? migrations.onEvent : null;

  function emitMigrationEvent(name, payload) {
    if (!migrationOnEvent) return;
    try {
      migrationOnEvent({ name, schema, ...payload });
    } catch (err) {
      console.warn(`[aquifer] migrations.onEvent handler threw: ${err.message}`);
    }
  }

  function requiredMigrations() {
    return MIGRATION_PLAN
      .filter(m => m.always
        || (m.gate === 'entities' && getEntitiesEnabled())
        || (m.gate === 'facts' && getFactsEnabled()))
      .map(m => m.id);
  }

  async function readAppliedMigrations(queryRunner) {
    const required = MIGRATION_PLAN.filter(m => m.always
      || (m.gate === 'entities' && getEntitiesEnabled())
      || (m.gate === 'facts' && getFactsEnabled()));
    const normalizedSignatures = required.flatMap((m) => {
      if (Array.isArray(m.signature)) return m.signature;
      return [m.signature];
    });
    const tableSignatures = normalizedSignatures
      .filter(signature => typeof signature === 'string');
    const columnSignatures = normalizedSignatures
      .filter(signature => signature && typeof signature === 'object' && signature.table && signature.column);
    const indexSignatures = normalizedSignatures
      .filter(signature => signature && typeof signature === 'object' && signature.index);
    const presentTables = new Set();
    const presentColumns = new Set();
    const presentIndexes = new Set();
    if (tableSignatures.length > 0) {
      const r = await queryRunner.query(
        `SELECT tablename FROM pg_tables
           WHERE schemaname = $1 AND tablename = ANY($2::text[])`,
        [schema, tableSignatures]
      );
      for (const row of r.rows) presentTables.add(row.tablename);
    }
    if (columnSignatures.length > 0) {
      const tables = [...new Set(columnSignatures.map(signature => signature.table))];
      const r = await queryRunner.query(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
        [schema, tables]
      );
      for (const row of r.rows) presentColumns.add(`${row.table_name}.${row.column_name}`);
    }
    if (indexSignatures.length > 0) {
      const indexes = indexSignatures.map(signature => signature.index);
      const r = await queryRunner.query(
        `SELECT indexname FROM pg_indexes
           WHERE schemaname = $1 AND indexname = ANY($2::text[])`,
        [schema, indexes]
      );
      for (const row of r.rows) presentIndexes.add(row.indexname);
    }
    return required
      .filter(m => {
        const signatures = Array.isArray(m.signature) ? m.signature : [m.signature];
        return signatures.every((signature) => {
          if (typeof signature === 'string') return presentTables.has(signature);
          if (signature && signature.index) return presentIndexes.has(signature.index);
          return presentColumns.has(`${signature.table}.${signature.column}`);
        });
      })
      .map(m => m.id);
  }

  async function buildMigrationPlan(queryRunner) {
    const required = requiredMigrations();
    const applied = await readAppliedMigrations(queryRunner);
    const appliedSet = new Set(applied);
    const pending = required.filter(id => !appliedSet.has(id));
    return { required, applied, pending };
  }

  async function ensureMigrated() {
    if (migrated) return;
    if (migratePromise) return migratePromise;
    if (migrationsMode === 'off') {
      migrated = true;
      return;
    }
    if (migrationsMode === 'check') {
      const plan = await buildMigrationPlan(pool).catch(() => null);
      if (plan && plan.pending.length === 0) migrated = true;
      return;
    }
    migratePromise = migrate().finally(() => { migratePromise = null; });
    return migratePromise;
  }

  async function migrate() {
    const t0 = Date.now();
    const lockKey = Buffer.from(`aquifer:${schema}`).reduce((h, b) => (h * 31 + b) & 0x7fffffff, 0);

    emitMigrationEvent('init_started', { mode: migrationsMode });

    const supportsCheckout = typeof pool.connect === 'function';
    const client = supportsCheckout ? await pool.connect() : pool;
    const releasesClient = supportsCheckout && typeof client.release === 'function';
    const notices = [];
    const onNotice = (n) => {
      notices.push({ severity: n.severity || 'NOTICE', message: n.message || String(n) });
    };
    const hasEvents = typeof client.on === 'function' && typeof client.off === 'function';
    if (hasEvents) client.on('notice', onNotice);

    const ddlExecuted = [];
    let lockAcquired = false;

    try {
      const planBefore = await buildMigrationPlan(client).catch(() => null);
      emitMigrationEvent('check_completed', {
        required: planBefore ? planBefore.required : requiredMigrations(),
        applied:  planBefore ? planBefore.applied  : [],
        pending:  planBefore ? planBefore.pending  : requiredMigrations(),
      });

      const lockDeadline = Date.now() + migrationLockTimeoutMs;
      const pollMs = 250;
      while (true) {
        const r = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [lockKey]);
        const row = r && r.rows ? r.rows[0] : null;
        if (row && row.ok === false) {
          if (Date.now() >= lockDeadline) break;
          await new Promise(res => setTimeout(res, pollMs));
          continue;
        }
        lockAcquired = true;
        break;
      }
      if (!lockAcquired) {
        const err = new Error(`aquifer: failed to acquire migration advisory lock within ${migrationLockTimeoutMs}ms for schema "${schema}"`);
        err.code = 'AQ_MIGRATION_LOCK_TIMEOUT';
        err.failedAt = 'acquire_lock';
        throw err;
      }

      emitMigrationEvent('apply_started', {
        pending: planBefore ? planBefore.pending : requiredMigrations(),
      });

      try {
        await client.query(loadSql('001-base.sql', schema));
        ddlExecuted.push('001-base');

        if (getEntitiesEnabled()) {
          await client.query(loadSql('002-entities.sql', schema));
          ddlExecuted.push('002-entities');
        }

        await client.query(loadSql('003-trust-feedback.sql', schema));
        ddlExecuted.push('003-trust-feedback');

        if (getFactsEnabled()) {
          await client.query(loadSql('004-facts.sql', schema));
          ddlExecuted.push('004-facts');
        }

        await client.query(loadSql('004-completion.sql', schema));
        ddlExecuted.push('004-completion');

        if (getEntitiesEnabled()) {
          await client.query(loadSql('005-entity-state-history.sql', schema));
          ddlExecuted.push('005-entity-state-history');
        }

        for (const migration of [
          ['006-insights.sql', '006-insights'],
          ['007-v1-foundation.sql', '007-v1-foundation'],
          ['008-session-finalizations.sql', '008-session-finalizations'],
          ['009-v1-assertion-plane.sql', '009-v1-assertion-plane'],
          ['010-v1-finalization-review.sql', '010-v1-finalization-review'],
          ['011-v1-compaction-claim.sql', '011-v1-compaction-claim'],
          ['012-v1-compaction-lease.sql', '012-v1-compaction-lease'],
          ['013-v1-compaction-lineage.sql', '013-v1-compaction-lineage'],
          ['014-v1-checkpoint-runs.sql', '014-v1-checkpoint-runs'],
          ['015-v1-evidence-items.sql', '015-v1-evidence-items'],
          ['016-v1-evidence-ref-multi-item.sql', '016-v1-evidence-ref-multi-item'],
          ['017-v1-memory-record-embeddings.sql', '017-v1-memory-record-embeddings'],
        ]) {
          await client.query(loadSql(migration[0], schema));
          ddlExecuted.push(migration[1]);
        }

        migrated = true;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch((err) => {
          console.warn(`[aquifer] failed to release migration advisory lock for schema "${schema}": ${err.message}`);
        });
      }
    } catch (err) {
      err.notices = Array.isArray(err.notices) ? err.notices : notices.slice();
      err.failedAt = err.failedAt || 'apply_ddl';
      emitMigrationEvent('apply_failed', {
        error: { code: err.code || null, message: err.message },
        failedAt: err.failedAt,
        notices: err.notices,
        durationMs: Date.now() - t0,
      });
      throw err;
    } finally {
      if (hasEvents) client.off('notice', onNotice);
      if (releasesClient) client.release();
    }

    for (const n of notices) {
      const sev = (n.severity || 'NOTICE').toUpperCase();
      const msg = n.message || '';
      const line = `[aquifer] migration ${sev.toLowerCase()}: ${msg}`;
      if (sev === 'WARNING' || sev === 'ERROR') {
        console.warn(line);
      } else if (sev === 'NOTICE' && msg.startsWith('[aquifer]')) {
        process.stderr.write(line + '\n');
      }
    }

    if (!ftsConfig) {
      try {
        const r = await pool.query(
          `SELECT 1 FROM pg_ts_config
             WHERE cfgname = 'zhcfg' AND cfgnamespace = 'public'::regnamespace
             LIMIT 1`);
        ftsConfig = r.rowCount > 0 ? 'zhcfg' : 'simple';
      } catch {
        ftsConfig = 'simple';
      }
    }

    try {
      const f = await pool.query(`
        SELECT
          EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_jieba')   AS have_jieba,
          EXISTS(SELECT 1 FROM pg_extension WHERE extname='zhparser')   AS have_zhparser,
          (SELECT p.prsname FROM pg_ts_config c
             JOIN pg_ts_parser p ON c.cfgparser = p.oid
             WHERE c.cfgname='zhcfg' AND c.cfgnamespace='public'::regnamespace
             LIMIT 1)                                                    AS zhcfg_parser
      `);
      const row = f.rows[0] || {};
      const backend = row.zhcfg_parser
        ? `zhcfg(parser=${row.zhcfg_parser})`
        : `simple (no zhcfg in public namespace)`;

      let warmupMs = null;
      if (row.zhcfg_parser) {
        const t0Warmup = Date.now();
        await pool.query(`SELECT to_tsvector('zhcfg', $1)`, ['warmup 記憶系統 aquifer'])
          .catch(() => {});
        warmupMs = Date.now() - t0Warmup;
      }

      const warmupNote = warmupMs !== null ? ` warmup=${warmupMs}ms` : '';
      process.stderr.write(
        `[aquifer] FTS post-flight: backend=${backend} ` +
        `jieba=${row.have_jieba} zhparser=${row.have_zhparser} ` +
        `selected=${ftsConfig}${warmupNote}\n`
      );
      if (warmupMs !== null && warmupMs > 500) {
        process.stderr.write(
          `[aquifer] Note: first FTS call paid ~${warmupMs}ms for tokenizer init ` +
          `(dictionary mmap). Subsequent calls on the same backend are cached.\n`
        );
      }
    } catch (err) {
      console.warn(`[aquifer] FTS post-flight check failed: ${err.message}`);
    }

    const durationMs = Date.now() - t0;
    emitMigrationEvent('apply_succeeded', {
      ddlExecuted,
      durationMs,
      notices: notices.slice(),
    });
    return { ok: true, durationMs, notices: notices.slice(), ddlExecuted };
  }

  async function listPendingMigrations() {
    const plan = await buildMigrationPlan(pool);
    return { ...plan, lastRunAt: null };
  }

  async function init() {
    const t0 = Date.now();
    const mode = migrationsMode;

    let deadlineTimer = null;
    const startupDeadline = migrationStartupTimeoutMs > 0
      ? new Promise((_, reject) => {
          deadlineTimer = setTimeout(() => {
            const err = new Error(`aquifer: init() exceeded startupTimeoutMs=${migrationStartupTimeoutMs}ms`);
            err.code = 'AQ_MIGRATION_STARTUP_TIMEOUT';
            reject(err);
          }, migrationStartupTimeoutMs);
          if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
        })
      : null;
    const withDeadline = (p) => startupDeadline ? Promise.race([p, startupDeadline]) : p;
    const clearDeadline = () => {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
    };

    try {
      let plan;
      try {
        plan = await withDeadline(buildMigrationPlan(pool));
      } catch (err) {
        const durationMs = Date.now() - t0;
        emitMigrationEvent('apply_failed', {
          error: { code: err.code || null, message: err.message },
          failedAt: 'plan_probe',
          notices: [],
          durationMs,
        });
        return {
          ready: false,
          memoryMode: 'off',
          migrationMode: mode,
          pendingMigrations: [],
          appliedMigrations: [],
          error: { code: err.code || 'AQ_MIGRATION_PROBE_FAILED', message: err.message },
          durationMs,
        };
      }

      if (mode === 'off') {
        return {
          ready: true,
          memoryMode: 'rw',
          migrationMode: mode,
          pendingMigrations: plan.pending,
          appliedMigrations: plan.applied,
          error: null,
          durationMs: Date.now() - t0,
        };
      }

      if (mode === 'check') {
        const ready = plan.pending.length === 0;
        if (ready) migrated = true;
        return {
          ready,
          memoryMode: ready ? 'rw' : 'ro',
          migrationMode: mode,
          pendingMigrations: plan.pending,
          appliedMigrations: plan.applied,
          error: null,
          durationMs: Date.now() - t0,
        };
      }

      if (plan.pending.length === 0) {
        migrated = true;
        return {
          ready: true,
          memoryMode: 'rw',
          migrationMode: mode,
          pendingMigrations: [],
          appliedMigrations: plan.applied,
          error: null,
          durationMs: Date.now() - t0,
        };
      }

      try {
        const result = await withDeadline(migrate());
        const planAfter = await buildMigrationPlan(pool).catch(() => null);
        return {
          ready: true,
          memoryMode: 'rw',
          migrationMode: mode,
          pendingMigrations: planAfter ? planAfter.pending : [],
          appliedMigrations: planAfter ? planAfter.applied : plan.required,
          error: null,
          durationMs: result.durationMs || (Date.now() - t0),
        };
      } catch (err) {
        return {
          ready: false,
          memoryMode: 'ro',
          migrationMode: mode,
          pendingMigrations: plan.pending,
          appliedMigrations: plan.applied,
          error: { code: err.code || 'AQ_MIGRATION_FAILED', message: err.message },
          durationMs: Date.now() - t0,
        };
      }
    } finally {
      clearDeadline();
    }
  }

  return {
    buildMigrationPlan,
    ensureMigrated,
    getFtsConfig: () => ftsConfig,
    init,
    isMigrated: () => migrated,
    listPendingMigrations,
    loadSql: filename => loadSql(filename, schema),
    migrate,
    requiredMigrations,
  };
}

module.exports = {
  MIGRATION_PLAN,
  createPostgresMigrationRuntime,
  loadSql,
  qi,
  validateSchema,
};
