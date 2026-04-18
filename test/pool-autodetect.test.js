'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAquifer } = require('../index');

function withEnv(envPatch, fn) {
  const keys = ['DATABASE_URL', 'AQUIFER_DB_URL', 'AQUIFER_SCHEMA', 'AQUIFER_TENANT_ID'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(envPatch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('createAquifer — pool autodetect from env', () => {
  it('picks up DATABASE_URL when config.db omitted', () => {
    withEnv({ DATABASE_URL: 'postgresql://localhost/env_db' }, () => {
      const aq = createAquifer();
      assert.ok(aq.migrate);
      aq.close();
    });
  });

  it('picks up AQUIFER_DB_URL when DATABASE_URL absent', () => {
    withEnv({ AQUIFER_DB_URL: 'postgresql://localhost/aq_db' }, () => {
      const aq = createAquifer();
      assert.ok(aq.migrate);
      aq.close();
    });
  });

  it('DATABASE_URL wins over AQUIFER_DB_URL when both set', () => {
    withEnv({
      DATABASE_URL: 'postgresql://localhost/db1',
      AQUIFER_DB_URL: 'postgresql://localhost/db2',
    }, () => {
      const aq = createAquifer();
      assert.ok(aq);
      aq.close();
    });
  });

  it('explicit config.db beats env', () => {
    withEnv({ DATABASE_URL: 'postgresql://localhost/ignored' }, () => {
      const aq = createAquifer({ db: 'postgresql://localhost/explicit' });
      assert.ok(aq);
      aq.close();
    });
  });

  it('throws with clear message when nothing set', () => {
    withEnv({}, () => {
      assert.throws(
        () => createAquifer(),
        /DATABASE_URL|AQUIFER_DB_URL|database/i
      );
    });
  });

  it('AQUIFER_SCHEMA env drives default schema', () => {
    withEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      AQUIFER_SCHEMA: 'from_env',
    }, () => {
      const aq = createAquifer();
      assert.equal(aq.getConfig().schema, 'from_env');
      aq.close();
    });
  });

  it('explicit config.schema beats AQUIFER_SCHEMA env', () => {
    withEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      AQUIFER_SCHEMA: 'env_schema',
    }, () => {
      const aq = createAquifer({ schema: 'explicit_schema' });
      assert.equal(aq.getConfig().schema, 'explicit_schema');
      aq.close();
    });
  });

  it('AQUIFER_TENANT_ID env drives default tenant', () => {
    withEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      AQUIFER_TENANT_ID: 'jenny',
    }, () => {
      const aq = createAquifer();
      assert.equal(aq.getConfig().tenantId, 'jenny');
      aq.close();
    });
  });
});
