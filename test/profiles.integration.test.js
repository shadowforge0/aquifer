'use strict';

// P2-2b — aq.profiles.* integration tests.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');
const { requireTestDb } = require('./helpers/require-test-db');

const DB_URL = requireTestDb('profiles integration tests');

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

if (DB_URL) {
describe('aq.profiles capability', () => {
  const schema = randomSchema();
  let pool;
  let aquifer;

  before(async () => {
    pool = new Pool({ connectionString: DB_URL });
    aquifer = createAquifer({
      db: DB_URL, schema, tenantId: 'default',
      embed: { fn: async () => [[0]], dim: 1 },
    });
    await aquifer.migrate();
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await aquifer.close();
    await pool.end();
  });

  it('rejects input without consumerId / version / profile', async () => {
    const r1 = await aquifer.profiles.register({ consumerId: 'x', version: 1 });
    assert.equal(r1.ok, false);
    const r2 = await aquifer.profiles.register({ profile: {}, version: 1 });
    assert.equal(r2.ok, false);
    const r3 = await aquifer.profiles.register({ consumerId: 'x', profile: {}, version: 0 });
    assert.equal(r3.ok, false);
  });

  it('register inserts new profile and computes hash', async () => {
    const r = await aquifer.profiles.register({
      consumerId: 'miranda', version: 1,
      profile: { sessionState: { schema: 'v1' } },
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.inserted, true);
    assert.ok(r.data.schemaHash.match(/^[a-f0-9]{64}$/));
  });

  it('re-registering identical profile+version is idempotent', async () => {
    const r = await aquifer.profiles.register({
      consumerId: 'miranda', version: 1,
      profile: { sessionState: { schema: 'v1' } },
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.inserted, false);
  });

  it('same version with different profile returns AQ_CONFLICT', async () => {
    const r = await aquifer.profiles.register({
      consumerId: 'miranda', version: 1,
      profile: { sessionState: { schema: 'v1-different' } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_CONFLICT');
  });

  it('load latest returns highest version', async () => {
    await aquifer.profiles.register({
      consumerId: 'miranda', version: 2,
      profile: { sessionState: { schema: 'v2' } },
    });
    const r = await aquifer.profiles.load({ consumerId: 'miranda' });
    assert.equal(r.ok, true);
    assert.equal(r.data.version, 2);
    assert.deepEqual(r.data.profile, { sessionState: { schema: 'v2' } });
  });

  it('load specific version', async () => {
    const r = await aquifer.profiles.load({ consumerId: 'miranda', version: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.data.version, 1);
  });

  it('load missing consumer returns AQ_PROFILE_NOT_FOUND', async () => {
    const r = await aquifer.profiles.load({ consumerId: 'ghost' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AQ_PROFILE_NOT_FOUND');
  });

  it('deprecated profile is excluded from latest', async () => {
    await aquifer.profiles.register({
      consumerId: 'depr', version: 1, profile: { x: 1 },
    });
    await aquifer.profiles.register({
      consumerId: 'depr', version: 2, profile: { x: 2 },
    });
    await pool.query(
      `UPDATE ${schema}.consumer_profiles
          SET deprecated_at = now()
        WHERE consumer_id = 'depr' AND version = 2`,
    );
    const r = await aquifer.profiles.load({ consumerId: 'depr' });
    assert.equal(r.ok, true);
    assert.equal(r.data.version, 1);
  });
});
}
