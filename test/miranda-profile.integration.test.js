'use strict';

// P3-c — Miranda default profile smoke test.
//
// Validates that consumers/miranda/profile.json can be registered via
// aq.profiles.register and loaded back with matching hash, proving the
// shipped profile is structurally valid and round-trip safe.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { createAquifer } = require('../index');

const DB_URL = process.env.AQUIFER_TEST_DB_URL;
if (!DB_URL) {
  console.error('AQUIFER_TEST_DB_URL not set. Skipping miranda profile test.');
  process.exit(0);
}

const MIRANDA_PROFILE_PATH = path.join(__dirname, '..', 'consumers', 'miranda', 'profile.json');

function randomSchema() {
  return `aquifer_test_${crypto.randomBytes(4).toString('hex')}`;
}

describe('Miranda default profile', () => {
  const schema = randomSchema();
  let pool;
  let aquifer;
  let profile;

  before(async () => {
    profile = JSON.parse(fs.readFileSync(MIRANDA_PROFILE_PATH, 'utf8'));
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

  it('profile.json declares required top-level fields', () => {
    assert.equal(profile.consumer_profile_id, 'miranda');
    assert.ok(Number.isInteger(profile.version));
    assert.ok(profile.schemas);
    assert.ok(profile.schemas['default.session_state.v1']);
    assert.ok(profile.schemas['default.session_handoff.v1']);
    assert.ok(profile.schemas['default.decision_log.v1']);
    assert.ok(profile.schemas['default.timeline.v1']);
    assert.ok(Array.isArray(profile.schemas['default.timeline.v1'].category_vocabulary));
    assert.ok(profile.artifacts.producers.length >= 1);
  });

  it('registers via aq.profiles.register', async () => {
    const r = await aquifer.profiles.register({
      consumerId: profile.consumer_profile_id,
      version: profile.version,
      profile,
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.inserted, true);
    assert.ok(r.data.schemaHash.match(/^[a-f0-9]{64}$/));
  });

  it('load latest returns the same profile', async () => {
    const r = await aquifer.profiles.load({
      consumerId: profile.consumer_profile_id,
    });
    assert.equal(r.ok, true);
    assert.equal(r.data.version, profile.version);
    assert.deepEqual(r.data.profile, profile);
  });

  it('timeline category vocabulary lines up with miranda defaults', () => {
    const cats = profile.schemas['default.timeline.v1'].category_vocabulary;
    for (const required of ['focus', 'todo', 'mood', 'handoff', 'narrative']) {
      // mood was folded into the session_state affect bucket; verify either
      // mood is in the vocabulary OR affect exists in session_state schema.
      if (required === 'mood') {
        const hasMoodInVocab = cats.includes('mood');
        const hasAffect = !!profile.schemas['default.session_state.v1']
          .json_schema.properties.affect;
        assert.ok(hasMoodInVocab || hasAffect,
          'mood must be a timeline category or live under session_state.affect');
      } else {
        assert.ok(cats.includes(required), `timeline missing ${required}`);
      }
    }
  });
});
