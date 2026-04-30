'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const storage = require('../core/storage');

function makePool(captured, rows = [{ session_row_id: 1, model: 'stored-model' }]) {
  return {
    query: async (sql, params) => {
      captured.push({ sql, params });
      return { rows };
    },
  };
}

describe('storage.upsertSummary model handling', () => {
  it('uses unknown as insert fallback without overwriting an existing model on conflict', async () => {
    const captured = [];
    const row = await storage.upsertSummary(makePool(captured), 1, {
      schema: 'aquifer',
      tenantId: 'default',
      agentId: 'main',
      sessionId: 's1',
      summaryText: 'summary',
      structuredSummary: {},
      msgCount: 1,
      userCount: 1,
      assistantCount: 0,
    });

    assert.equal(row.model, 'stored-model');
    assert.equal(captured.length, 1);

    const { sql, params } = captured[0];
    assert.match(sql, /NULLIF\(EXCLUDED\.model, 'unknown'\)/);
    assert.match(sql, /COALESCE\(NULLIF\(EXCLUDED\.model, 'unknown'\), "aquifer"\.session_summaries\.model\)/);
    assert.equal(params[4], 'unknown');
  });

  it('passes through explicit model values', async () => {
    const captured = [];
    await storage.upsertSummary(makePool(captured), 1, {
      schema: 'aquifer',
      tenantId: 'default',
      agentId: 'main',
      sessionId: 's1',
      summaryText: 'summary',
      structuredSummary: {},
      model: 'gpt-test',
    });

    assert.equal(captured[0].params[4], 'gpt-test');
  });
});

describe('storage.searchSessions quality filter', () => {
  it('excludes obvious placeholder summaries from public legacy recall SQL', async () => {
    const captured = [];
    await storage.searchSessions(makePool(captured, []), 'Aquifer', {
      schema: 'aquifer',
      tenantId: 'default',
      limit: 5,
      ftsConfig: 'simple',
    });

    assert.match(captured[0].sql, /summary_text/);
    assert.match(captured[0].sql, /空測試會話/);
    assert.match(captured[0].sql, /placeholder/);
  });
});

describe('base schema summary model contract', () => {
  it('keeps session_summaries.model nullable for older and new installs', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'schema', '001-base.sql'), 'utf8');

    assert.match(sql, /model\s+TEXT,/);
    assert.match(sql, /ALTER TABLE \$\{schema\}\.session_summaries\s+ALTER COLUMN model DROP NOT NULL;/);
  });
});
