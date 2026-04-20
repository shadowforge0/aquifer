'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createAquifer } = require('../index');

const DB_URL = process.env.AQUIFER_TEST_DB_URL;
if (!DB_URL) {
  console.error('AQUIFER_TEST_DB_URL not set. Skipping insights semantic dedup integration tests.');
  process.exit(0);
}

const schema = `aquifer_test_dedup_${crypto.randomBytes(4).toString('hex')}`;
const SEED_WINDOW = '[2026-04-01T00:00:00Z,2026-04-10T00:00:00Z)';

let pool;

function makeVec(alpha, axis) {
  const v = new Float32Array(1024);
  v[0] = 1;
  if (alpha > 0) v[axis] = alpha;

  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);

  const out = new Array(1024);
  for (let i = 0; i < 1024; i++) out[i] = v[i] / norm;
  return out;
}

function vecLiteral(v) {
  return Array.isArray(v) ? `[${v.join(',')}]` : null;
}

function normalizeText(text) {
  if (typeof text !== 'string') return '';
  let s = text.normalize('NFKC');
  s = s.toLowerCase();
  s = s.replace(/\s+/g, ' ');
  s = s.trim();
  s = s.replace(/^[\s\-_.,;:!?'"()\[\]{}]+/, '');
  s = s.replace(/[\s\-_.,;:!?'"()\[\]{}]+$/, '');
  return s;
}

function truncate(input, limit) {
  if (typeof input !== 'string') return '';
  return input.length <= limit ? input : input.slice(0, limit);
}

function truncateNormalized(input, limit) {
  return truncate(normalizeText(input), limit);
}

function baseInput(overrides = {}) {
  return {
    agentId: 'main',
    type: 'preference',
    title: 'Test incoming title',
    body: 'Test incoming body content',
    sourceSessionIds: ['sess-incoming-1'],
    evidenceWindow: {
      from: '2026-04-15T00:00:00Z',
      to: '2026-04-20T00:00:00Z',
    },
    importance: 0.7,
    ...overrides,
  };
}

function makeAquifer({ mode, embedFn, cosineThreshold = 0.88, closeBandFrom = 0.85, tenantId = 'default' }) {
  return createAquifer({
    db: pool,
    schema,
    tenantId,
    embed: { fn: embedFn, dim: 1024 },
    insights: {
      dedup: { mode, cosineThreshold, closeBandFrom },
    },
  });
}

async function seedRow(db, {
  id,
  agentId = 'main',
  tenantId = 'default',
  type = 'preference',
  title,
  body = 'b',
  canonicalKey = null,
  embedding = null,
  status = 'active',
}) {
  await db.query(
    `INSERT INTO "${schema}".insights
      (id, tenant_id, agent_id, insight_type, title, body,
       source_session_ids, evidence_window, embedding, importance, status,
       canonical_key_v2, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,
             ARRAY['seed'], $7::tstzrange, $8::vector, 0.5, $9, $10, $11::jsonb)`,
    [
      id,
      tenantId,
      agentId,
      type,
      title,
      body,
      SEED_WINDOW,
      vecLiteral(embedding),
      status,
      canonicalKey,
      JSON.stringify({}),
    ]
  );
}

async function resetSeedData() {
  await pool.query(`TRUNCATE TABLE "${schema}".insights RESTART IDENTITY CASCADE`);

  const longCandidateBody = 'Candidate body   with   spacing and punctuation!!! '.repeat(8);

  await seedRow(pool, {
    id: 1,
    title: 'Seed 1 title',
    body: 'Seed 1 body',
    canonicalKey: 'canon-1',
    embedding: makeVec(99, 5),
  });
  await seedRow(pool, {
    id: 2,
    title: 'Seed 2 title',
    body: longCandidateBody,
    canonicalKey: 'canon-2',
    embedding: makeVec(0.3, 1),
  });
  await seedRow(pool, {
    id: 3,
    title: 'Seed 3 title',
    body: 'Seed 3 body',
    canonicalKey: 'canon-3',
    embedding: makeVec(0.48, 1),
  });
  await seedRow(pool, {
    id: 4,
    title: 'Seed 4 title',
    body: 'Seed 4 close band body',
    canonicalKey: 'canon-4',
    embedding: makeVec(1.8, 3),
  });
  await seedRow(pool, {
    id: 5,
    title: 'Seed 5 title',
    body: 'Seed 5 body',
    canonicalKey: 'canon-5',
    embedding: makeVec(99, 2),
  });
  await seedRow(pool, {
    id: 6,
    type: 'pattern',
    title: 'Seed 6 pattern title',
    body: 'Seed 6 pattern body',
    canonicalKey: 'canon-6',
    embedding: makeVec(0, 0),
  });
  await seedRow(pool, {
    id: 7,
    title: 'Seed 7 legacy null canonical',
    body: 'Seed 7 body',
    canonicalKey: null,
    embedding: makeVec(0.4, 1),
  });
  await seedRow(pool, {
    id: 8,
    title: 'Seed 8 no embedding',
    body: 'Seed 8 body',
    canonicalKey: 'canon-8',
    embedding: null,
  });
  await seedRow(pool, {
    id: 9,
    title: 'Seed 9 superseded',
    body: 'Seed 9 body',
    canonicalKey: 'canon-9',
    embedding: makeVec(0, 0),
    status: 'superseded',
  });
  await seedRow(pool, {
    id: 10,
    agentId: 'life',
    title: 'Seed 10 life agent',
    body: 'Seed 10 body',
    canonicalKey: 'canon-10',
    embedding: makeVec(99, 4),
  });

  await pool.query(
    'SELECT setval($1::regclass, $2, true)',
    [`"${schema}".insights_id_seq`, 100]
  );
}

async function fetchInsight(id) {
  const r = await pool.query(`SELECT * FROM "${schema}".insights WHERE id = $1`, [id]);
  assert.equal(r.rowCount, 1, `expected insight ${id} to exist`);
  return r.rows[0];
}

describe('insights semantic dedup integration (real PG)', () => {
  before(async () => {
    const boot = createAquifer({
      db: DB_URL,
      schema,
      tenantId: 'default',
      embed: { fn: async () => [new Array(1024).fill(0)], dim: 1024 },
    });
    await boot.init();
    await boot.close?.().catch(() => {});

    pool = new Pool({ connectionString: DB_URL });
  });

  after(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await pool.end().catch(() => {});
    }
  });

  it('T1 enforce: supersedes the top semantic candidate (#2)', async () => {
    await resetSeedData();

    const aq = makeAquifer({ mode: 'enforce', embedFn: async () => [makeVec(0, 0)] });
    try {
      const r = await aq.insights.commitInsight(baseInput());
      assert.equal(r.ok, true);
      assert.equal(r.data.duplicate, false);

      const newRow = await fetchInsight(r.data.insight.id);
      const oldRow = await fetchInsight(2);

      assert.equal(oldRow.status, 'superseded');
      assert.equal(Number(oldRow.superseded_by), r.data.insight.id);
      assert.equal(newRow.status, 'active');
      assert.equal(newRow.metadata.dedupVia, 'semantic');
      assert.equal(newRow.metadata.dedupCandidate.id, 2);
      assert.ok(
        Math.abs(newRow.metadata.dedupCandidate.cosine - 0.958) < 0.005,
        `cosine should be ~0.958, got ${newRow.metadata.dedupCandidate.cosine}`
      );
    } finally {
      await aq.close?.().catch(() => {});
    }
  });

  it('T2 enforce: threshold-edge match supersedes row #3', async () => {
    await resetSeedData();

    const aq = makeAquifer({
      mode: 'enforce',
      cosineThreshold: 0.90,
      embedFn: async () => [makeVec(1.25, 1)],
    });
    try {
      const r = await aq.insights.commitInsight(baseInput({
        title: 'Threshold incoming title',
        body: 'Threshold incoming body content',
      }));
      assert.equal(r.ok, true);
      assert.equal(r.data.duplicate, false);

      const newRow = await fetchInsight(r.data.insight.id);
      const oldRow = await fetchInsight(3);

      assert.equal(oldRow.status, 'superseded');
      assert.equal(Number(oldRow.superseded_by), r.data.insight.id);
      assert.equal(newRow.metadata.dedupVia, 'semantic');
      assert.equal(newRow.metadata.dedupCandidate.id, 3);
      assert.ok(
        Math.abs(newRow.metadata.dedupCandidate.cosine - 0.901) < 0.01,
        `cosine should be ~0.901, got ${newRow.metadata.dedupCandidate.cosine}`
      );
    } finally {
      await aq.close?.().catch(() => {});
    }
  });

  it('T3 enforce: close-band metadata lands on row #4 without superseding', async () => {
    await resetSeedData();

    const aq = makeAquifer({
      mode: 'enforce',
      cosineThreshold: 0.88,
      closeBandFrom: 0.85,
      embedFn: async () => [makeVec(0.6, 3)],
    });
    try {
      const r = await aq.insights.commitInsight(baseInput({
        title: 'Close band incoming title',
        body: 'Close band incoming body content',
      }));
      assert.equal(r.ok, true);
      assert.equal(r.data.duplicate, false);

      const newRow = await fetchInsight(r.data.insight.id);
      const candidate = await fetchInsight(4);

      assert.equal(candidate.status, 'active');
      assert.equal(candidate.superseded_by, null);
      assert.ok(newRow.metadata.dedupNear);
      assert.equal(newRow.metadata.dedupNear.candidateId, 4);
      assert.equal(newRow.metadata.dedupVia, undefined);
      assert.ok(
        Math.abs(newRow.metadata.dedupNear.cosine - 0.867) < 0.01,
        `cosine should be ~0.867, got ${newRow.metadata.dedupNear.cosine}`
      );
    } finally {
      await aq.close?.().catch(() => {});
    }
  });

  it('T4 shadow: records shadowMatch but leaves candidate #2 untouched', async () => {
    await resetSeedData();

    const preSnap = await pool.query(
      `SELECT status, superseded_by, updated_at FROM "${schema}".insights WHERE id = 2`
    );

    const aq = makeAquifer({ mode: 'shadow', embedFn: async () => [makeVec(0, 0)] });
    try {
      const r = await aq.insights.commitInsight(baseInput({
        title: 'Shadow incoming title',
        body: 'Shadow incoming body content',
      }));
      assert.ok(r.ok && !r.data.duplicate);

      const postSnap = await pool.query(
        `SELECT status, superseded_by, updated_at FROM "${schema}".insights WHERE id = 2`
      );
      assert.deepEqual(preSnap.rows[0], postSnap.rows[0]);

      const newRow = await fetchInsight(r.data.insight.id);
      const meta = newRow.metadata;
      assert.ok(meta.shadowMatch);
      assert.equal(meta.shadowMatch.candidateId, 2);
      assert.ok(meta.shadowMatch.wouldSupersede);
      assert.ok(Math.abs(meta.shadowMatch.cosine - 0.958) < 0.005);
      assert.equal(meta.dedupVia, undefined);
      assert.equal(meta.dedupCandidate, undefined);
      assert.equal(meta.shadowMatch.candidateTitle, truncate('Seed 2 title', 200));
      assert.equal(meta.shadowMatch.candidateBody, truncateNormalized(preSnap.rows[0] ? (await fetchInsight(2)).body : '', 200));
      assert.ok(typeof meta.shadowMatch.ranAt === 'string' && meta.shadowMatch.ranAt.length > 0);
    } finally {
      await aq.close?.().catch(() => {});
    }
  });

  it('T5 enforce: distant vector inserts cleanly without dedup metadata', async () => {
    await resetSeedData();

    const aq = makeAquifer({ mode: 'enforce', embedFn: async () => [makeVec(99, 6)] });
    try {
      const r = await aq.insights.commitInsight(baseInput({
        title: 'Distant incoming title',
        body: 'Distant incoming body content',
      }));
      assert.equal(r.ok, true);
      assert.equal(r.data.duplicate, false);

      const newRow = await fetchInsight(r.data.insight.id);
      const row2 = await fetchInsight(2);

      assert.deepEqual(newRow.metadata, { dedupQuality: 'title_fallback' });
      assert.equal(row2.status, 'active');
      assert.equal(row2.superseded_by, null);
    } finally {
      await aq.close?.().catch(() => {});
    }
  });

  it('T6 enforce: embed failure marks dedupSkipped and skips semantic lookup', async () => {
    await resetSeedData();

    const originalQuery = pool.query.bind(pool);
    let semanticLookupCount = 0;
    pool.query = async function patchedQuery(text, params) {
      const sql = typeof text === 'string' ? text : text && text.text;
      if (typeof sql === 'string' && /embedding <=>/.test(sql)) semanticLookupCount += 1;
      return originalQuery(text, params);
    };

    const aq = makeAquifer({
      mode: 'enforce',
      embedFn: async () => { throw new Error('embed failed'); },
    });

    try {
      const r = await aq.insights.commitInsight(baseInput({
        title: 'Embed failure incoming title',
        body: 'Embed failure incoming body content',
      }));
      assert.equal(r.ok, true);
      assert.equal(r.data.duplicate, false);

      const newRow = await fetchInsight(r.data.insight.id);
      assert.equal(newRow.metadata.dedupSkipped, 'embed_failed');
      assert.equal(newRow.metadata.dedupVia, undefined);
      assert.equal(semanticLookupCount, 0);
    } finally {
      pool.query = originalQuery;
      await aq.close?.().catch(() => {});
    }
  });

  it('T7 enforce: cross-agent rows do not merge with main-agent candidates', async () => {
    await resetSeedData();

    const aq = makeAquifer({ mode: 'enforce', embedFn: async () => [makeVec(0, 0)] });
    try {
      const r = await aq.insights.commitInsight(baseInput({
        agentId: 'life',
        title: 'Life incoming title',
        body: 'Life incoming body content',
      }));
      assert.equal(r.ok, true);
      assert.equal(r.data.duplicate, false);

      const newRow = await fetchInsight(r.data.insight.id);
      const mainRow = await fetchInsight(2);
      const lifeRow = await fetchInsight(10);

      assert.equal(newRow.agent_id, 'life');
      assert.deepEqual(newRow.metadata, { dedupQuality: 'title_fallback' });
      assert.equal(mainRow.status, 'active');
      assert.equal(lifeRow.status, 'active');
      assert.equal(lifeRow.superseded_by, null);
    } finally {
      await aq.close?.().catch(() => {});
    }
  });

  it('T8 enforce: cross-type isolation still allows pattern row #6 to supersede', async () => {
    await resetSeedData();

    const aq = makeAquifer({ mode: 'enforce', embedFn: async () => [makeVec(0, 0)] });
    try {
      const r = await aq.insights.commitInsight(baseInput({
        type: 'pattern',
        title: 'Pattern incoming title',
        body: 'Pattern incoming body content',
      }));
      assert.equal(r.ok, true);
      assert.equal(r.data.duplicate, false);

      const newRow = await fetchInsight(r.data.insight.id);
      const patternRow = await fetchInsight(6);
      const preferenceRow = await fetchInsight(2);

      assert.equal(patternRow.status, 'superseded');
      assert.equal(Number(patternRow.superseded_by), r.data.insight.id);
      assert.equal(preferenceRow.status, 'active');
      assert.equal(newRow.metadata.dedupVia, 'semantic');
      assert.equal(newRow.metadata.dedupCandidate.id, 6);
      assert.ok(Math.abs(newRow.metadata.dedupCandidate.cosine - 1) < 0.001);
    } finally {
      await aq.close?.().catch(() => {});
    }
  });

  it('T10 enforce: cross-tenant rows stay isolated even on exact cosine match', async () => {
    await resetSeedData();

    await seedRow(pool, {
      id: 11,
      tenantId: 'tenant-a',
      title: 'Tenant A seed title',
      body: 'Tenant A seed body',
      canonicalKey: 'canon-tenant-a',
      embedding: makeVec(0, 0),
    });

    const preA = await fetchInsight(11);

    const aq = makeAquifer({
      mode: 'enforce',
      tenantId: 'tenant-b',
      embedFn: async () => [makeVec(0, 0)],
    });
    try {
      const r = await aq.insights.commitInsight(baseInput({
        title: 'Tenant B incoming title',
        body: 'Tenant B incoming body content',
      }));
      assert.equal(r.ok, true);
      assert.equal(r.data.duplicate, false);

      const newRow = await fetchInsight(r.data.insight.id);
      const postA = await fetchInsight(11);

      assert.equal(newRow.tenant_id, 'tenant-b');
      assert.deepEqual(newRow.metadata, { dedupQuality: 'title_fallback' });
      assert.equal(postA.status, 'active');
      assert.equal(postA.superseded_by, null);
      assert.equal(postA.tenant_id, preA.tenant_id);
      assert.equal(postA.updated_at.toISOString(), preA.updated_at.toISOString());
    } finally {
      await aq.close?.().catch(() => {});
    }
  });

  it('T11 shadow: cross-tenant seed must not produce shadowMatch', async () => {
    await resetSeedData();

    await seedRow(pool, {
      id: 12,
      tenantId: 'tenant-a',
      title: 'Tenant A shadow seed title',
      body: 'Tenant A shadow seed body',
      canonicalKey: 'canon-tenant-a-shadow',
      embedding: makeVec(0, 0),
    });

    const aq = makeAquifer({
      mode: 'shadow',
      tenantId: 'tenant-b',
      embedFn: async () => [makeVec(0, 0)],
    });
    try {
      const r = await aq.insights.commitInsight(baseInput({
        title: 'Tenant B shadow incoming title',
        body: 'Tenant B shadow incoming body content',
      }));
      assert.ok(r.ok && !r.data.duplicate);

      const newRow = await fetchInsight(r.data.insight.id);
      assert.equal(newRow.tenant_id, 'tenant-b');
      assert.equal(newRow.metadata.shadowMatch, undefined,
        'shadowMatch must be undefined when no same-tenant candidate exists');
      assert.equal(newRow.metadata.dedupQuality, 'title_fallback');

      const tenantARow = await fetchInsight(12);
      assert.equal(tenantARow.status, 'active');
      assert.equal(tenantARow.superseded_by, null);
    } finally {
      await aq.close?.().catch(() => {});
    }
  });

  it('T9 enforce: semantic dedup catches legacy NULL canonical row #7', async () => {
    await resetSeedData();

    const aq = makeAquifer({ mode: 'enforce', embedFn: async () => [makeVec(0.4, 1)] });
    try {
      const r = await aq.insights.commitInsight(baseInput({
        title: 'Legacy null canonical incoming title',
        body: 'Legacy null canonical incoming body content',
      }));
      assert.equal(r.ok, true);
      assert.equal(r.data.duplicate, false);

      const newRow = await fetchInsight(r.data.insight.id);
      const legacyRow = await fetchInsight(7);

      assert.equal(legacyRow.canonical_key_v2, null);
      assert.equal(legacyRow.status, 'superseded');
      assert.equal(Number(legacyRow.superseded_by), r.data.insight.id);
      assert.equal(newRow.metadata.dedupVia, 'semantic');
      assert.equal(newRow.metadata.dedupCandidate.id, 7);
      assert.ok(Math.abs(newRow.metadata.dedupCandidate.cosine - 1) < 0.001);
    } finally {
      await aq.close?.().catch(() => {});
    }
  });
});
