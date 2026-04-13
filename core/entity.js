'use strict';

// C1: quote identifier for SQL safety
function qi(identifier) { return `"${identifier}"`; }

function vecToStr(vec) {
  if (!vec || !Array.isArray(vec) || vec.length === 0) return null;
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) throw new Error(`Vector contains non-finite value at index ${i}`);
  }
  return `[${vec.join(',')}]`;
}

// ---------------------------------------------------------------------------
// Entity type enum
// ---------------------------------------------------------------------------

const ENTITY_TYPES = new Set([
  'person', 'project', 'concept', 'tool', 'metric', 'org',
  'place', 'event', 'doc', 'task', 'topic', 'other',
]);

// ---------------------------------------------------------------------------
// Homoglyph mapping for normalizeEntityName
// ---------------------------------------------------------------------------

const HOMOGLYPH_MAP = {
  '\u3010': '[', '\u3011': ']',  // 【】
  '\u300C': '[', '\u300D': ']',  // 「」
  '\u2014': '-', '\u2013': '-',  // em-dash, en-dash
  '\u2015': '-',                  // horizontal bar
  '\u00B7': '.', '\u30FB': '.',  // middle dots
  '\uFF01': '!', '\uFF02': '"', '\uFF03': '#', '\uFF04': '$',
  '\uFF05': '%', '\uFF06': '&', '\uFF07': "'", '\uFF08': '(',
  '\uFF09': ')', '\uFF0A': '*', '\uFF0B': '+', '\uFF0C': ',',
  '\uFF0D': '-', '\uFF0E': '.', '\uFF0F': '/',
  '\uFF10': '0', '\uFF11': '1', '\uFF12': '2', '\uFF13': '3',
  '\uFF14': '4', '\uFF15': '5', '\uFF16': '6', '\uFF17': '7',
  '\uFF18': '8', '\uFF19': '9',
  '\uFF1A': ':', '\uFF1B': ';', '\uFF1C': '<', '\uFF1D': '=',
  '\uFF1E': '>', '\uFF1F': '?', '\uFF20': '@',
  '\uFF21': 'A', '\uFF22': 'B', '\uFF23': 'C', '\uFF24': 'D',
  '\uFF25': 'E', '\uFF26': 'F', '\uFF27': 'G', '\uFF28': 'H',
  '\uFF29': 'I', '\uFF2A': 'J', '\uFF2B': 'K', '\uFF2C': 'L',
  '\uFF2D': 'M', '\uFF2E': 'N', '\uFF2F': 'O', '\uFF30': 'P',
  '\uFF31': 'Q', '\uFF32': 'R', '\uFF33': 'S', '\uFF34': 'T',
  '\uFF35': 'U', '\uFF36': 'V', '\uFF37': 'W', '\uFF38': 'X',
  '\uFF39': 'Y', '\uFF3A': 'Z',
  '\uFF41': 'a', '\uFF42': 'b', '\uFF43': 'c', '\uFF44': 'd',
  '\uFF45': 'e', '\uFF46': 'f', '\uFF47': 'g', '\uFF48': 'h',
  '\uFF49': 'i', '\uFF4A': 'j', '\uFF4B': 'k', '\uFF4C': 'l',
  '\uFF4D': 'm', '\uFF4E': 'n', '\uFF4F': 'o', '\uFF50': 'p',
  '\uFF51': 'q', '\uFF52': 'r', '\uFF53': 's', '\uFF54': 't',
  '\uFF55': 'u', '\uFF56': 'v', '\uFF57': 'w', '\uFF58': 'x',
  '\uFF59': 'y', '\uFF5A': 'z',
};

// Build regex for homoglyph replacement
const HOMOGLYPH_RE = new RegExp('[' + Object.keys(HOMOGLYPH_MAP).join('') + ']', 'g');

// ---------------------------------------------------------------------------
// normalizeEntityName
// ---------------------------------------------------------------------------

function normalizeEntityName(input) {
  if (!input) return '';

  let s = input.normalize('NFKC');
  s = s.toLowerCase();
  s = s.replace(HOMOGLYPH_RE, ch => HOMOGLYPH_MAP[ch] || ch);
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^[\s\-_.,;:!?'"()\[\]{}]+/, '');
  s = s.replace(/[\s\-_.,;:!?'"()\[\]{}]+$/, '');

  return s;
}

// ---------------------------------------------------------------------------
// parseEntityOutput
// ---------------------------------------------------------------------------

function parseEntityOutput(text) {
  if (!text) return [];

  const marker = '[ENTITIES]';
  const idx = text.indexOf(marker);
  if (idx === -1) return [];

  const entitySection = text.slice(idx + marker.length).trim();
  if (!entitySection || entitySection.startsWith('(none)')) return [];

  const blocks = entitySection.split(/^---$/m);
  const entities = [];

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    let name = '';
    let type = 'other';
    let aliases = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('name:')) {
        name = trimmed.slice(5).trim();
      } else if (trimmed.startsWith('type:')) {
        const t = trimmed.slice(5).trim().toLowerCase();
        if (ENTITY_TYPES.has(t)) type = t;
      } else if (trimmed.startsWith('aliases:')) {
        const raw = trimmed.slice(8).trim();
        if (raw) {
          aliases = raw.split(',')
            .map(a => a.trim())
            .filter(Boolean)
            .map(a => normalizeEntityName(a))
            .filter(Boolean);
        }
      }
    }

    if (!name) continue;

    const normalizedName = normalizeEntityName(name);
    if (!normalizedName) continue;

    entities.push({ name, normalizedName, type, aliases });
  }

  return entities;
}

// ---------------------------------------------------------------------------
// upsertEntity
// ---------------------------------------------------------------------------

async function upsertEntity(pool, {
  schema,
  tenantId = 'default',
  name,
  normalizedName,
  aliases = [],
  type = 'other',
  status = 'active',
  agentId = 'main',
  entityScope,
  createdBy,
  metadata = {},
  embedding,
  occurredAt,
}) {
  const scope = entityScope || agentId || 'default';
  const normalizedAliases = aliases.map(a => normalizeEntityName(a)).filter(Boolean);
  const embStr = embedding ? vecToStr(embedding) : null;
  const ts = occurredAt || new Date().toISOString();

  const result = await pool.query(
    `INSERT INTO ${qi(schema)}.entities
      (tenant_id, name, normalized_name, aliases, type, status, agent_id, entity_scope,
       created_by, metadata, embedding, first_seen_at, last_seen_at, frequency)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::vector, $12, $12, 1)
    ON CONFLICT (tenant_id, normalized_name, entity_scope) DO UPDATE SET
      frequency    = ${qi(schema)}.entities.frequency + 1,
      aliases      = ARRAY(SELECT DISTINCT unnest(${qi(schema)}.entities.aliases || EXCLUDED.aliases)),
      last_seen_at = GREATEST(${qi(schema)}.entities.last_seen_at, EXCLUDED.last_seen_at),
      embedding    = COALESCE(EXCLUDED.embedding, ${qi(schema)}.entities.embedding),
      metadata     = COALESCE(NULLIF(EXCLUDED.metadata, '{}'::jsonb), ${qi(schema)}.entities.metadata)
    RETURNING id, (xmax = 0) AS is_new`,
    [
      tenantId, name, normalizedName, normalizedAliases,
      type, status, agentId, scope,
      createdBy || null,
      JSON.stringify(metadata),
      embStr,
      ts,
    ]
  );

  const row = result.rows[0];
  if (!row) throw new Error('upsertEntity returned no row');
  return { id: row.id, isNew: row.is_new };
}

// ---------------------------------------------------------------------------
// upsertEntityMention
// ---------------------------------------------------------------------------

async function upsertEntityMention(pool, {
  schema,
  entityId,
  sessionRowId,
  turnEmbeddingId,
  source,
  mentionText,
  confidence = 1.0,
  occurredAt,
}) {
  const result = await pool.query(
    `INSERT INTO ${qi(schema)}.entity_mentions
      (entity_id, session_row_id, turn_embedding_id, source, mention_text, confidence, occurred_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (entity_id, session_row_id) DO NOTHING
    RETURNING id`,
    [
      entityId, sessionRowId,
      turnEmbeddingId || null,
      source || null,
      mentionText || null,
      confidence,
      occurredAt || new Date().toISOString(),
    ]
  );
  return result.rows[0] ? result.rows[0].id : null;
}

// ---------------------------------------------------------------------------
// upsertEntityRelations
// ---------------------------------------------------------------------------

async function upsertEntityRelations(pool, {
  schema,
  pairs,
  occurredAt,
}) {
  if (!pairs || pairs.length === 0) return { upserted: 0 };
  const ts = occurredAt || new Date().toISOString();
  let upserted = 0;

  for (const { srcEntityId, dstEntityId } of pairs) {
    if (!srcEntityId || !dstEntityId || srcEntityId === dstEntityId) continue;

    const lo = Math.min(srcEntityId, dstEntityId);
    const hi = Math.max(srcEntityId, dstEntityId);

    await pool.query(
      `INSERT INTO ${qi(schema)}.entity_relations
        (src_entity_id, dst_entity_id, co_occurrence_count, first_seen_at, last_seen_at)
      VALUES ($1, $2, 1, $3, $3)
      ON CONFLICT (src_entity_id, dst_entity_id) DO UPDATE SET
        co_occurrence_count = ${qi(schema)}.entity_relations.co_occurrence_count + 1,
        last_seen_at        = GREATEST(${qi(schema)}.entity_relations.last_seen_at, EXCLUDED.last_seen_at)`,
      [lo, hi, ts]
    );
    upserted++;
  }

  return { upserted };
}

// ---------------------------------------------------------------------------
// upsertEntitySession
// ---------------------------------------------------------------------------

async function upsertEntitySession(pool, {
  schema,
  entityId,
  sessionRowId,
  occurredAt,
}) {
  await pool.query(
    `INSERT INTO ${qi(schema)}.entity_sessions
      (entity_id, session_row_id, mention_count, occurred_at)
    VALUES ($1, $2, 1, $3)
    ON CONFLICT (entity_id, session_row_id) DO UPDATE SET
      mention_count = ${qi(schema)}.entity_sessions.mention_count + 1`,
    [entityId, sessionRowId, occurredAt || new Date().toISOString()]
  );
}

// ---------------------------------------------------------------------------
// searchEntities
// ---------------------------------------------------------------------------

function _escapeIlike(str) {
  return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

async function searchEntities(pool, {
  schema,
  tenantId,
  query,
  agentId,
  entityScope,
  limit = 10,
  similarityThreshold = 0.1,
}) {
  const clampedLimit = Math.max(1, Math.min(100, limit));
  const normQ = normalizeEntityName(query);
  if (!normQ) return [];

  const escaped = _escapeIlike(normQ);
  // Use entityScope if provided, fall back to agentId for backward compat
  const scopeFilter = entityScope || agentId || null;

  const result = await pool.query(
    `SELECT
      id, name, normalized_name, aliases, type, status, frequency, agent_id,
      entity_scope, last_seen_at, metadata,
      similarity(normalized_name, $1) AS name_sim
    FROM ${qi(schema)}.entities
    WHERE status = 'active'
      AND tenant_id = $2
      AND (
        similarity(normalized_name, $1) >= $3
        OR normalized_name ILIKE '%' || $4 || '%' ESCAPE '\\'
        OR $5 = ANY(aliases)
      )
      AND ($6::text IS NULL OR entity_scope = $6)
    ORDER BY name_sim DESC, frequency DESC
    LIMIT $7`,
    [normQ, tenantId, similarityThreshold, escaped, normQ, scopeFilter, clampedLimit]
  );

  return result.rows;
}

// ---------------------------------------------------------------------------
// getEntityRelations
// ---------------------------------------------------------------------------

async function getEntityRelations(pool, {
  schema,
  entityId,
  limit = 20,
}) {
  const clampedLimit = Math.max(1, Math.min(100, limit));

  const result = await pool.query(
    `SELECT
      r.id,
      r.src_entity_id,
      r.dst_entity_id,
      r.co_occurrence_count,
      r.last_seen_at,
      CASE WHEN r.src_entity_id = $1 THEN r.dst_entity_id ELSE r.src_entity_id END AS related_entity_id,
      e.name AS related_name,
      e.type AS related_type,
      e.frequency AS related_frequency
    FROM ${qi(schema)}.entity_relations r
    JOIN ${qi(schema)}.entities e ON e.id = CASE
      WHEN r.src_entity_id = $1 THEN r.dst_entity_id
      ELSE r.src_entity_id
    END
    WHERE (r.src_entity_id = $1 OR r.dst_entity_id = $1)
      AND e.status = 'active'
    ORDER BY r.co_occurrence_count DESC
    LIMIT $2`,
    [entityId, clampedLimit]
  );

  return result.rows;
}

// ---------------------------------------------------------------------------
// resolveEntities — map raw names to entity IDs with dedup
// ---------------------------------------------------------------------------

async function resolveEntities(pool, {
  schema,
  tenantId,
  names,
  agentId = null,
  entityScope,
  threshold = 0.1,
}) {
  if (!names || names.length === 0) return [];
  // Use entityScope if provided, fall back to agentId for backward compat
  const scopeFilter = entityScope || agentId || null;

  const seen = new Map();
  const results = [];

  for (const rawName of names) {
    const normQ = normalizeEntityName(rawName);
    if (!normQ || seen.has(normQ)) continue;
    seen.set(normQ, true);

    const escaped = _escapeIlike(normQ);
    const result = await pool.query(
      `SELECT id, name, normalized_name
      FROM ${qi(schema)}.entities
      WHERE status = 'active'
        AND tenant_id = $1
        AND (
          similarity(normalized_name, $2) >= $3
          OR normalized_name = $2
          OR $2 = ANY(aliases)
        )
        AND ($4::text IS NULL OR entity_scope = $4)
      ORDER BY similarity(normalized_name, $2) DESC, frequency DESC
      LIMIT 1`,
      [tenantId, normQ, threshold, scopeFilter]
    );

    if (result.rows[0]) {
      const row = result.rows[0];
      if (!results.some(r => r.entityId === row.id)) {
        results.push({
          entityId: row.id,
          name: row.name,
          normalizedName: row.normalized_name,
          inputName: rawName,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// getSessionsByEntityIntersection — sessions containing ALL specified entities
// ---------------------------------------------------------------------------

async function getSessionsByEntityIntersection(pool, {
  schema,
  entityIds,
  tenantId,
  agentId = null,
  source = null,
  dateFrom = null,
  dateTo = null,
  limit = 100,
}) {
  if (!entityIds || entityIds.length === 0) return [];

  const where = ['s.tenant_id = $2'];
  const params = [entityIds, tenantId];

  if (agentId) {
    params.push(agentId);
    where.push(`s.agent_id = $${params.length}`);
  }
  if (source) {
    params.push(source);
    where.push(`s.source = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    where.push(`s.started_at::date >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`s.started_at::date <= $${params.length}::date`);
  }

  params.push(entityIds.length);
  const havingPos = params.length;

  params.push(Math.max(1, Math.min(500, limit)));
  const limitPos = params.length;

  const result = await pool.query(
    `SELECT es.session_row_id, s.session_id,
            COUNT(DISTINCT es.entity_id) AS matched_count,
            SUM(es.mention_count) AS mention_weight
    FROM ${qi(schema)}.entity_sessions es
    JOIN ${qi(schema)}.sessions s ON s.id = es.session_row_id
    WHERE es.entity_id = ANY($1)
      AND ${where.join(' AND ')}
    GROUP BY es.session_row_id, s.session_id
    HAVING COUNT(DISTINCT es.entity_id) >= $${havingPos}
    ORDER BY matched_count DESC, mention_weight DESC
    LIMIT $${limitPos}`,
    params
  );

  return result.rows;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  normalizeEntityName,
  parseEntityOutput,
  upsertEntity,
  upsertEntityMention,
  upsertEntityRelations,
  upsertEntitySession,
  searchEntities,
  getEntityRelations,
  resolveEntities,
  getSessionsByEntityIntersection,
};
