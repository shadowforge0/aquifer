'use strict';

// Integration tests for the C2 gateway migrate handshake (1.5.7):
//   - aquifer.init() returns a StartupEnvelope
//   - apply mode drives pending DDL to empty
//   - check mode reports pending without running DDL
//   - off mode never touches the schema
//   - listPendingMigrations reflects planner state
//   - pg_try_advisory_lock + lockTimeoutMs surfaces AQ_MIGRATION_LOCK_TIMEOUT
//   - onEvent fires at expected lifecycle points
//
// Gated on AQUIFER_TEST_DB_URL — requires a real PG that can create extensions.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');

const DB_URL = process.env.AQUIFER_TEST_DB_URL;
if (!DB_URL) {
  console.error('AQUIFER_TEST_DB_URL not set. Skipping migration handshake integration tests.');
  process.exit(0);
}

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

const makeAquifer = (schema, extra = {}) => createAquifer({
  db: DB_URL,
  schema,
  tenantId: 'default',
  embed: { fn: async () => [[0]], dim: 1 },
  ...extra,
});

async function dropSchema(pool, schema) {
  try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch {}
}

describe('aquifer.init() — apply mode (default)', () => {
  const schema = randomSchema();
  let pool;
  let aquifer;

  before(() => {
    pool = new Pool({ connectionString: DB_URL });
  });
  after(async () => {
    await dropSchema(pool, schema);
    if (aquifer) await aquifer.close?.().catch(() => {});
    await pool.end().catch(() => {});
  });

  it('fresh schema: pending drains to empty, ready=true, rw mode', async () => {
    aquifer = makeAquifer(schema);
    const envelope = await aquifer.init();
    assert.equal(envelope.ready, true, 'ready must be true after apply');
    assert.equal(envelope.memoryMode, 'rw');
    assert.equal(envelope.migrationMode, 'apply');
    assert.equal(envelope.pendingMigrations.length, 0, 'no pending after init()');
    assert.ok(envelope.appliedMigrations.includes('001-base'), '001-base must be applied');
    assert.equal(envelope.error, null);
    assert.ok(typeof envelope.durationMs === 'number' && envelope.durationMs >= 0);
  });

  it('second init() on same schema is a no-op (pending already empty)', async () => {
    const env2 = await aquifer.init();
    assert.equal(env2.ready, true);
    assert.equal(env2.pendingMigrations.length, 0);
  });
});

describe('aquifer.init() — check mode', () => {
  const schema = randomSchema();
  let pool;
  let aquifer;

  before(() => {
    pool = new Pool({ connectionString: DB_URL });
  });
  after(async () => {
    await dropSchema(pool, schema);
    if (aquifer) await aquifer.close?.().catch(() => {});
    await pool.end().catch(() => {});
  });

  it('reports pending without running DDL', async () => {
    aquifer = makeAquifer(schema, { migrations: { mode: 'check' } });
    const envelope = await aquifer.init();
    assert.equal(envelope.migrationMode, 'check');
    assert.equal(envelope.ready, false, 'ready must be false when DDL not applied');
    assert.equal(envelope.memoryMode, 'ro');
    assert.ok(envelope.pendingMigrations.length > 0, 'should report pending on fresh schema');
    // Schema should not be created
    const r = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = 'sessions'`,
      [schema]
    );
    assert.equal(r.rowCount, 0, 'check mode must not create tables');
  });
});

describe('aquifer.init() — off mode', () => {
  const schema = randomSchema();
  let pool;
  let aquifer;

  before(() => {
    pool = new Pool({ connectionString: DB_URL });
  });
  after(async () => {
    await dropSchema(pool, schema);
    if (aquifer) await aquifer.close?.().catch(() => {});
    await pool.end().catch(() => {});
  });

  it('returns ready=true without any DDL or check side effects', async () => {
    aquifer = makeAquifer(schema, { migrations: { mode: 'off' } });
    const envelope = await aquifer.init();
    assert.equal(envelope.migrationMode, 'off');
    assert.equal(envelope.ready, true);
    assert.equal(envelope.memoryMode, 'rw');
    const r = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = 'sessions'`,
      [schema]
    );
    assert.equal(r.rowCount, 0, 'off mode must not create tables');
  });
});

describe('aquifer.listPendingMigrations() / getMigrationStatus()', () => {
  const schema = randomSchema();
  let pool;
  let aquifer;

  before(async () => {
    pool = new Pool({ connectionString: DB_URL });
    aquifer = makeAquifer(schema);
  });
  after(async () => {
    await dropSchema(pool, schema);
    await aquifer.close?.().catch(() => {});
    await pool.end().catch(() => {});
  });

  it('fresh schema: all required migrations pending', async () => {
    const status = await aquifer.listPendingMigrations();
    assert.ok(status.required.length >= 3, 'required should include at least 001/003/004-completion/006');
    assert.equal(status.applied.length, 0);
    assert.deepEqual(status.pending, status.required);
  });

  it('after init(): pending empty, applied equals required', async () => {
    await aquifer.init();
    const status = await aquifer.getMigrationStatus();
    assert.equal(status.pending.length, 0);
    assert.deepEqual(status.applied.sort(), status.required.sort());
  });
});

describe('aquifer.init() — lock timeout', () => {
  const schema = randomSchema();
  let pool;
  let holderClient;
  let aquifer;

  before(async () => {
    pool = new Pool({ connectionString: DB_URL });
    // First init the schema so a second init() needs the lock but finds
    // pending=[] and short-circuits before hitting the try-lock. We instead
    // force pending=true by hand-dropping the insights table after init.
    const bootstrap = makeAquifer(schema);
    await bootstrap.init();
    await bootstrap.close?.().catch(() => {});
    await pool.query(`DROP TABLE IF EXISTS ${schema}.insights CASCADE`);
    holderClient = await pool.connect();
    const lockKey = Buffer.from(`aquifer:${schema}`).reduce((h, b) => (h * 31 + b) & 0x7fffffff, 0);
    await holderClient.query('SELECT pg_advisory_lock($1)', [lockKey]);
  });
  after(async () => {
    try {
      const lockKey = Buffer.from(`aquifer:${schema}`).reduce((h, b) => (h * 31 + b) & 0x7fffffff, 0);
      await holderClient.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    } catch {}
    holderClient.release();
    await dropSchema(pool, schema);
    if (aquifer) await aquifer.close?.().catch(() => {});
    await pool.end().catch(() => {});
  });

  it('returns ready=false with AQ_MIGRATION_LOCK_TIMEOUT when lock is held', async () => {
    aquifer = makeAquifer(schema, { migrations: { mode: 'apply', lockTimeoutMs: 800, startupTimeoutMs: 5000 } });
    const envelope = await aquifer.init();
    assert.equal(envelope.ready, false);
    assert.equal(envelope.memoryMode, 'ro');
    assert.ok(envelope.error, 'error must be set');
    assert.equal(envelope.error.code, 'AQ_MIGRATION_LOCK_TIMEOUT');
  });
});

describe('aquifer.init() — onEvent observability', () => {
  const schema = randomSchema();
  let pool;
  let aquifer;
  const events = [];

  before(() => {
    pool = new Pool({ connectionString: DB_URL });
  });
  after(async () => {
    await dropSchema(pool, schema);
    if (aquifer) await aquifer.close?.().catch(() => {});
    await pool.end().catch(() => {});
  });

  it('fires init_started → check_completed → apply_started → apply_succeeded on fresh schema', async () => {
    aquifer = makeAquifer(schema, { migrations: { onEvent: (e) => events.push(e.name) } });
    await aquifer.init();
    const required = ['init_started', 'check_completed', 'apply_started', 'apply_succeeded'];
    for (const name of required) {
      assert.ok(events.includes(name), `expected event ${name} in ${JSON.stringify(events)}`);
    }
  });
});
