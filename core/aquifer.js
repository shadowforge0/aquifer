'use strict';

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const storage = require('./storage');
const entity = require('./entity');
const { hybridRank } = require('./hybrid-rank');
const { summarize } = require('../pipeline/summarize');
const { extractEntities } = require('../pipeline/extract-entities');

// ---------------------------------------------------------------------------
// Schema name validation
// ---------------------------------------------------------------------------

const SCHEMA_RE = /^[a-zA-Z_]\w{0,62}$/;

function validateSchema(schema) {
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`Invalid schema name: "${schema}". Must match /^[a-zA-Z_]\\w{0,62}$/`);
  }
}

// C1 fix: quote identifiers to handle reserved words safely
function qi(identifier) { return `"${identifier}"`; }

// ---------------------------------------------------------------------------
// SQL file loader — replaces ${schema} placeholders
// ---------------------------------------------------------------------------

function loadSql(filename, schema) {
  const filePath = path.join(__dirname, '..', 'schema', filename);
  const raw = fs.readFileSync(filePath, 'utf8');
  // C1: use quoted identifier for safety
  return raw.replace(/\$\{schema\}/g, qi(schema));
}

// ---------------------------------------------------------------------------
// createAquifer
// ---------------------------------------------------------------------------

function createAquifer(config) {
  if (!config || !config.db) {
    throw new Error('config.db (pg.Pool or connection string) is required');
  }

  const schema = config.schema || 'aquifer';
  validateSchema(schema);

  if (config.tenantId === '') throw new Error('config.tenantId must not be empty');
  const tenantId = config.tenantId || 'default';

  // Pool management
  let pool;
  let ownsPool = false;
  if (typeof config.db === 'string') {
    pool = new Pool({ connectionString: config.db });
    ownsPool = true;
  } else {
    pool = config.db;
  }

  // Embed config (lazy — only required for recall/enrich)
  const embedFn = config.embed && typeof config.embed.fn === 'function' ? config.embed.fn : null;
  let embedDim = config.embed ? (config.embed.dim || null) : null;

  function requireEmbed(op) {
    if (!embedFn) throw new Error(`Aquifer.${op}() requires config.embed.fn (async (texts) => number[][])`);
  }

  // LLM config (optional — only needed for enrich with built-in summarize)
  const llmFn = config.llm && typeof config.llm.fn === 'function' ? config.llm.fn : null;

  // Summarize config
  const summarizePromptFn = config.summarize && config.summarize.prompt ? config.summarize.prompt : null;

  // Entity config
  let entitiesEnabled = config.entities && config.entities.enabled === true;
  const mergeCall = config.entities && config.entities.mergeCall !== undefined ? config.entities.mergeCall : true;
  const entityPromptFn = config.entities && config.entities.prompt ? config.entities.prompt : null;
  const entityScope = (config.entities && config.entities.scope) || 'default';

  // FTS config (default: 'simple'; set to 'zhcfg' for Chinese tokenization)
  const ftsConfig = config.ftsConfig || 'simple';

  // Rank weights
  const rankWeights = {
    rrf: 0.65,
    timeDecay: 0.25,
    access: 0.10,
    entityBoost: 0.18,
    ...(config.rank || {}),
  };

  // Source registry (in-memory)
  const sources = new Map();

  // Track if migrate was called
  let migrated = false;
  let migratePromise = null;

  async function ensureMigrated() {
    if (migrated) return;
    if (migratePromise) return migratePromise;
    migratePromise = aquifer.migrate().finally(() => { migratePromise = null; });
    return migratePromise;
  }

  // --- Helper: embed search on summaries ---
  async function embeddingSearchSummaries(queryVec, opts) {
    const { agentId, source, dateFrom, dateTo, limit = 20 } = opts;
    const where = [`s.tenant_id = $1`];
    const params = [tenantId];

    params.push(`[${queryVec.join(',')}]`);
    const vecPos = params.length;

    if (dateFrom) {
      params.push(dateFrom);
      where.push(`($${params.length}::date IS NULL OR s.started_at::date >= $${params.length}::date)`);
    }
    if (dateTo) {
      params.push(dateTo);
      where.push(`($${params.length}::date IS NULL OR s.started_at::date <= $${params.length}::date)`);
    }
    if (agentId) {
      params.push(agentId);
      where.push(`s.agent_id = $${params.length}`);
    }
    if (source) {
      params.push(source);
      where.push(`s.source = $${params.length}`);
    }

    params.push(limit);

    const result = await pool.query(
      `SELECT
        s.id, s.session_id, s.agent_id, s.source, s.started_at, s.last_message_at,
        ss.summary_text, ss.structured_summary, ss.access_count, ss.last_accessed_at,
        ss.trust_score,
        (ss.embedding <=> $${vecPos}::vector) AS distance
      FROM ${qi(schema)}.session_summaries ss
      JOIN ${qi(schema)}.sessions s ON s.id = ss.session_row_id
      WHERE ss.embedding IS NOT NULL
        AND ${where.join(' AND ')}
      ORDER BY distance ASC
      LIMIT $${params.length}`,
      params
    );

    return result.rows;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  const aquifer = {
    // --- lifecycle ---

    async migrate() {
      // 1. Run base DDL
      const baseSql = loadSql('001-base.sql', schema);
      await pool.query(baseSql);

      // 2. If entities enabled, run entity DDL
      if (entitiesEnabled) {
        const entitySql = loadSql('002-entities.sql', schema);
        await pool.query(entitySql);
      }

      // 3. Trust + feedback (always, not gated by entities)
      const trustSql = loadSql('003-trust-feedback.sql', schema);
      await pool.query(trustSql);

      migrated = true;
    },

    async close() {
      if (ownsPool) {
        await pool.end();
      }
    },

    // --- source registration ---

    registerSource(name, opts = {}) {
      sources.set(name, {
        type: opts.type || 'custom',
        search: opts.search || null,
        weight: opts.weight !== null && opts.weight !== undefined ? opts.weight : 1.0,
      });
    },

    async enableEntities() {
      entitiesEnabled = true;
      // M4: if already migrated, run entity DDL now
      if (migrated) {
        const entitySql = loadSql('002-entities.sql', schema);
        await pool.query(entitySql);
      }
    },

    // --- write path ---

    async commit(sessionId, messages, opts = {}) {
      if (!sessionId) throw new Error('sessionId is required');
      if (!messages || !Array.isArray(messages)) throw new Error('messages must be an array');
      await ensureMigrated();

      const agentId = opts.agentId || 'agent';
      const source = opts.source || 'api';

      // Count messages
      let msgCount = messages.length;
      let userCount = 0;
      let assistantCount = 0;
      for (const m of messages) {
        if (m.role === 'user') userCount++;
        else if (m.role === 'assistant') assistantCount++;
      }

      // rawMessages: pass through a pre-built messages payload without wrapping
      const messagesPayload = opts.rawMessages || { normalized: messages };

      const result = await storage.upsertSession(pool, {
        schema,
        tenantId,
        sessionId,
        sessionKey: opts.sessionKey || null,
        agentId,
        source,
        messages: messagesPayload,
        msgCount,
        userCount,
        assistantCount,
        model: opts.model || null,
        tokensIn: opts.tokensIn || 0,
        tokensOut: opts.tokensOut || 0,
        startedAt: opts.startedAt || null,
        lastMessageAt: opts.lastMessageAt || null,
      });

      return {
        id: result.id,
        sessionId: result.sessionId,
        isNew: result.isNew,
      };
    },

    // --- enrichment ---

    async enrich(sessionId, opts = {}) {
      await ensureMigrated();
      const agentId = opts.agentId || 'agent';
      const skipSummary = opts.skipSummary || false;
      const skipTurnEmbed = opts.skipTurnEmbed || false;
      const skipEntities = opts.skipEntities || false;

      // Custom hooks: let callers bring their own summarize/entity pipeline
      const customSummaryFn = opts.summaryFn || null;      // async (messages) => { summaryText, structuredSummary, entityRaw?, extra? }
      const customEntityParseFn = opts.entityParseFn || null; // (text) => [{ name, normalizedName, aliases, type }]

      // Post-commit hook: runs after tx commit + client release. Best-effort, at-most-once.
      const postProcess = opts.postProcess || null;  // async (ctx) => void
      const optModel = 'model' in opts ? opts.model : undefined; // undefined = no override

      // 1. Optimistic lock: claim session for processing
      //    Also reclaim stale 'processing' sessions (stuck > 10 min = likely killed process)
      const STALE_MINUTES = 10;
      const claimResult = await pool.query(
        `UPDATE ${qi(schema)}.sessions
        SET processing_status = 'processing', processing_started_at = NOW()
        WHERE session_id = $1 AND agent_id = $2 AND tenant_id = $3
          AND (processing_status IN ('pending', 'failed')
               OR (processing_status = 'processing' AND (processing_started_at IS NULL OR processing_started_at < NOW() - INTERVAL '${STALE_MINUTES} minutes')))
        RETURNING *`,
        [sessionId, agentId, tenantId]
      );
      const session = claimResult.rows[0];
      if (!session) {
        // Check if session exists but is already processing/succeeded
        const existing = await storage.getSession(pool, sessionId, agentId, {}, { schema, tenantId });
        if (!existing) throw new Error(`Session not found: ${sessionId} (agentId=${agentId})`);
        if (existing.processing_status === 'processing') throw new Error(`Session ${sessionId} is already being enriched`);
        if (existing.processing_status === 'succeeded') throw new Error(`Session ${sessionId} is already enriched. Re-commit to reset.`);
        throw new Error(`Session ${sessionId} has unexpected status: ${existing.processing_status}`);
      }

      const rawMessages = session.messages;
      const messages = rawMessages
        ? (typeof rawMessages === 'string' ? JSON.parse(rawMessages) : rawMessages)
        : null;
      const normalized = messages ? (messages.normalized || messages) : [];

      // 2. Extract user turns
      const turns = storage.extractUserTurns(normalized);

      // 3. Summarize (custom or built-in)
      let summaryResult = null;
      let entityRaw = null;
      let extra = null;

      if (!skipSummary && normalized.length > 0) {
        if (customSummaryFn) {
          // Custom pipeline: caller handles LLM call and parsing
          summaryResult = await customSummaryFn(normalized);
          if (summaryResult.entityRaw) entityRaw = summaryResult.entityRaw;
          if (summaryResult.extra) extra = summaryResult.extra;
        } else {
          // Built-in pipeline
          const doMergeEntities = entitiesEnabled && mergeCall && !skipEntities;
          summaryResult = await summarize(normalized, {
            llmFn,
            promptFn: summarizePromptFn,
            mergeEntities: doMergeEntities,
          });
          if (summaryResult.entityRaw) {
            entityRaw = summaryResult.entityRaw;
          }
        }
      }

      // 4. Pre-compute all LLM/embed results BEFORE opening transaction
      //    (avoids holding pool connection during slow LLM/embed calls)
      const warnings = [];
      let summaryEmbedding = null;
      let turnVectors = null;
      let parsedEntities = [];

      // 4a. Summary embedding
      if (summaryResult && summaryResult.summaryText) {
        try {
          const embResult = await embedFn([summaryResult.summaryText]);
          summaryEmbedding = embResult[0] || null;
        } catch (e) { warnings.push(`summary embed failed: ${e.message}`); }
      }

      // 4b. Turn embeddings
      if (!skipTurnEmbed && turns.length > 0) {
        try {
          turnVectors = await embedFn(turns.map(t => t.text));
        } catch (e) { warnings.push(`turn embed failed: ${e.message}`); }
      }

      // 4c. Entity extraction (custom parser or built-in)
      if (entitiesEnabled && !skipEntities) {
        try {
          if (entityRaw && customEntityParseFn) {
            parsedEntities = customEntityParseFn(entityRaw);
          } else if (entityRaw) {
            parsedEntities = entity.parseEntityOutput(entityRaw);
          } else if (llmFn && !customSummaryFn) {
            parsedEntities = await extractEntities(normalized, { llmFn, promptFn: entityPromptFn });
          }
        } catch (e) { warnings.push(`entity extraction failed: ${e.message}`); }
      }

      // 5. Now open transaction — only DB writes, no external calls
      const client = await pool.connect();
      let turnsEmbedded = 0;
      let entitiesFound = 0;

      try {
        await client.query('BEGIN');

        // 5a. Upsert summary
        if (summaryResult && summaryResult.summaryText) {
          await storage.upsertSummary(client, session.id, {
            schema, tenantId, agentId, sessionId,
            summaryText: summaryResult.summaryText,
            structuredSummary: summaryResult.structuredSummary,
            model: (optModel !== undefined ? optModel : session.model) || null, sourceHash: null,
            msgCount: normalized.length,
            userCount: turns.length,
            assistantCount: normalized.filter(m => m.role === 'assistant').length,
            startedAt: session.started_at, endedAt: session.ended_at,
            embedding: summaryEmbedding,
          });
        }

        // 5b. Turn embeddings
        if (turnVectors && turns.length > 0) {
          try {
            await storage.upsertTurnEmbeddings(client, session.id, {
              schema, tenantId, sessionId, agentId,
              source: session.source, turns, vectors: turnVectors,
            });
            turnsEmbedded = turns.length;
          } catch (e) { warnings.push(`turn upsert failed: ${e.message}`); }
        }

        // 5c. Entity upsert chain (extraction already done in step 4c)
        if (parsedEntities.length > 0) {
          const entityIds = [];
          for (const ent of parsedEntities) {
            try {
              const { id } = await entity.upsertEntity(client, {
                schema,
                tenantId,
                name: ent.name,
                normalizedName: ent.normalizedName,
                aliases: ent.aliases,
                type: ent.type,
                agentId,
                entityScope,
                createdBy: 'aquifer',
                occurredAt: session.started_at ? new Date(session.started_at).toISOString() : null,
              });
              entityIds.push(id);

              // Upsert mention
              await entity.upsertEntityMention(client, {
                schema,
                entityId: id,
                sessionRowId: session.id,
                source: session.source,
                mentionText: ent.name,
                occurredAt: session.started_at ? new Date(session.started_at).toISOString() : null,
              });

              // Upsert entity-session link
              await entity.upsertEntitySession(client, {
                schema,
                entityId: id,
                sessionRowId: session.id,
                occurredAt: session.started_at ? new Date(session.started_at).toISOString() : null,
              });
            } catch (e) { warnings.push(`entity upsert failed: ${e.message}`); }
          }

          // Entity relations: all pairs
          if (entityIds.length > 1) {
            const pairs = [];
            for (let i = 0; i < entityIds.length; i++) {
              for (let j = i + 1; j < entityIds.length; j++) {
                pairs.push({ srcEntityId: entityIds[i], dstEntityId: entityIds[j] });
              }
            }
            try {
              await entity.upsertEntityRelations(client, {
                schema,
                pairs,
                occurredAt: session.started_at ? new Date(session.started_at).toISOString() : null,
              });
            } catch (e) { warnings.push(`entity relations failed: ${e.message}`); }
          }

          entitiesFound = entityIds.length;
        }

        // 8. Mark status + commit (M5: use 'partial' if warnings)
        const finalStatus = warnings.length > 0 ? 'partial' : 'succeeded';
        await storage.markStatus(client, session.id, finalStatus, warnings.length > 0 ? warnings.join('; ') : null, { schema });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        try {
          await storage.markStatus(pool, session.id, 'failed', err.message, { schema });
        } catch (_) { /* swallow */ }
        throw err;
      } finally {
        client.release();
      }

      // Post-commit hook: best-effort, at-most-once, no retry.
      // Runs after tx commit + client release. Failure does not affect session status.
      const effectiveModel = (optModel !== undefined ? optModel : session.model) || null;
      let postProcessError = null;
      if (postProcess) {
        try {
          await postProcess({
            session: {
              id: session.id,
              sessionId,
              agentId,
              model: session.model || null,
              source: session.source || null,
              startedAt: session.started_at || null,
              endedAt: session.ended_at || null,
            },
            effectiveModel,
            summary: summaryResult
              ? { summaryText: summaryResult.summaryText, structuredSummary: summaryResult.structuredSummary }
              : null,
            embedding: summaryEmbedding,
            turnVectors,
            extra,
            normalized,
            parsedEntities,
            skipped: { summary: skipSummary, entities: skipEntities, turns: skipTurnEmbed },
            turnsEmbedded,
            entitiesFound,
            warnings: [...warnings],  // defensive copy — caller cannot mutate enrich warnings
          });
        } catch (e) {
          postProcessError = e;
        }
      }

      return {
        summary: summaryResult ? summaryResult.summaryText : null,
        structuredSummary: summaryResult ? summaryResult.structuredSummary : null,
        turnsEmbedded,
        entitiesFound,
        warnings,
        extra,
        session: {
          id: session.id,
          sessionId,
          agentId,
          model: session.model || null,
          source: session.source || null,
        },
        effectiveModel,
        postProcessError,
      };
    },

    // --- read path ---

    async recall(query, opts = {}) {
      if (!query) return [];
      requireEmbed('recall');

      const {
        agentId,
        source,
        dateFrom,
        dateTo,
        limit = 5,
        weights: overrideWeights,
        entities: explicitEntities,
        entityMode = 'any',
      } = opts;

      // Validate before touching DB
      if (explicitEntities && explicitEntities.length > 0 && !entitiesEnabled) {
        throw new Error('Entities are not enabled');
      }

      await ensureMigrated();

      const fetchLimit = limit * 4;

      // 1. Embed query
      const queryVecResult = await embedFn([query]);
      const queryVec = queryVecResult[0];
      if (!queryVec || !queryVec.length) return []; // m3: guard empty array too

      // 2. Entity intersection pre-filter (when entityMode === 'all')
      let candidateSessionIds = null; // null = no filter
      let entityScoreBySession = new Map();

      if (explicitEntities && explicitEntities.length > 0) {

        const resolved = await entity.resolveEntities(pool, {
          schema, tenantId, names: explicitEntities, entityScope,
        });

        if (resolved.length === 0) return [];

        // Guard: if 'all' mode but fewer entities resolved than requested,
        // return [] — partial resolution would silently weaken the AND constraint
        if (entityMode === 'all' && resolved.length < new Set(explicitEntities.map(n => entity.normalizeEntityName(n))).size) {
          return [];
        }

        const entityIds = resolved.map(r => r.entityId);

        if (entityMode === 'all') {
          // Hard filter: only sessions with ALL entities
          const intersectionRows = await entity.getSessionsByEntityIntersection(pool, {
            schema, entityIds, tenantId, agentId, source, dateFrom, dateTo, limit: fetchLimit,
          });

          if (intersectionRows.length === 0) return [];

          candidateSessionIds = new Set(intersectionRows.map(r => r.session_id));
          for (const row of intersectionRows) {
            entityScoreBySession.set(row.session_id, 1.0);
          }
        } else {
          // 'any' mode with explicit entities: use resolved IDs for boost
          const esResult = await pool.query(
            `SELECT es.session_row_id, s.session_id, COUNT(*) AS entity_count
            FROM ${qi(schema)}.entity_sessions es
            JOIN ${qi(schema)}.sessions s ON s.id = es.session_row_id
            WHERE es.entity_id = ANY($1)
            GROUP BY es.session_row_id, s.session_id`,
            [entityIds]
          );

          const maxCount = Math.max(1, ...esResult.rows.map(r => parseInt(r.entity_count)));
          for (const row of esResult.rows) {
            entityScoreBySession.set(row.session_id, parseInt(row.entity_count) / maxCount);
          }
        }
      } else if (entitiesEnabled) {
        // No explicit entities: existing query-text-based entity boost
        try {
          const matchedEntities = await entity.searchEntities(pool, {
            schema, tenantId, query, entityScope, limit: 10,
          });

          if (matchedEntities.length > 0) {
            const entityIds = matchedEntities.map(e => e.id);
            const esResult = await pool.query(
              `SELECT es.session_row_id, s.session_id, COUNT(*) AS entity_count
              FROM ${qi(schema)}.entity_sessions es
              JOIN ${qi(schema)}.sessions s ON s.id = es.session_row_id
              WHERE es.entity_id = ANY($1)
              GROUP BY es.session_row_id, s.session_id`,
              [entityIds]
            );

            const maxCount = Math.max(1, ...esResult.rows.map(r => parseInt(r.entity_count)));
            for (const row of esResult.rows) {
              entityScoreBySession.set(row.session_id, parseInt(row.entity_count) / maxCount);
            }
          }
        } catch (_) { /* entity search failure non-fatal */ }
      }

      // 3. Run 3 search paths in parallel
      const [ftsRows, embRows, turnResult] = await Promise.all([
        storage.searchSessions(pool, query, {
          schema, tenantId, agentId, source, dateFrom, dateTo, limit: fetchLimit, ftsConfig,
        }).catch(() => []),
        embeddingSearchSummaries(queryVec, {
          agentId, source, dateFrom, dateTo, limit: fetchLimit,
        }).catch(() => []),
        storage.searchTurnEmbeddings(pool, {
          schema, tenantId, queryVec, dateFrom, dateTo, agentId, source, limit: fetchLimit,
        }).catch(() => ({ rows: [] })),
      ]);

      const turnRows = turnResult.rows || [];

      // 3b. Apply candidate filter (entityMode 'all')
      const filterFn = candidateSessionIds
        ? (rows) => rows.filter(r => candidateSessionIds.has(r.session_id || String(r.id)))
        : (rows) => rows;

      const filteredFts = filterFn(ftsRows);
      const filteredEmb = filterFn(embRows);
      const filteredTurn = filterFn(turnRows);

      if (filteredFts.length === 0 && filteredEmb.length === 0 && filteredTurn.length === 0) {
        return [];
      }

      // 4. Open-loop set extraction
      const openLoopSet = new Set();
      for (const r of [...filteredFts, ...filteredEmb, ...filteredTurn]) {
        const sid = r.session_id || String(r.id);
        const ss = typeof r.structured_summary === 'string'
          ? (() => { try { return JSON.parse(r.structured_summary); } catch (_) { return null; } })()
          : r.structured_summary;
        if (ss && Array.isArray(ss.open_loops) && ss.open_loops.length > 0) {
          openLoopSet.add(sid);
        }
      }

      // 5. Run external source searches (parallel + timeout)
      const EXTERNAL_TIMEOUT = 10000;
      const externalRows = [];
      const externalPromises = [];
      for (const [, sourceConfig] of sources) {
        if (typeof sourceConfig.search === 'function') {
          const w = sourceConfig.weight !== null && sourceConfig.weight !== undefined ? sourceConfig.weight : 1.0;
          externalPromises.push(
            Promise.race([
              sourceConfig.search(query, opts),
              new Promise((_, rej) => setTimeout(() => rej(new Error('external source timeout')), EXTERNAL_TIMEOUT)),
            ]).then(results => {
              if (Array.isArray(results)) {
                for (const r of results) {
                  if (r && r.session_id) externalRows.push({ ...r, _externalWeight: w });
                }
              }
            }).catch(() => { /* external source failure/timeout non-fatal */ })
          );
        }
      }
      if (externalPromises.length > 0) await Promise.all(externalPromises);

      // 6. Hybrid rank
      const mergedWeights = { ...rankWeights, ...overrideWeights };
      const ranked = hybridRank(
        filteredFts,
        [...filteredEmb, ...filterFn(externalRows)],
        filteredTurn,
        {
          limit,
          weights: mergedWeights,
          entityScoreBySession,
          openLoopSet,
        },
      );

      // 7. Record access
      const sessionRowIds = ranked
        .map(r => r.id || r.session_row_id)
        .filter(Boolean);

      if (sessionRowIds.length > 0) {
        try {
          await storage.recordAccess(pool, sessionRowIds, { schema });
        } catch (_) { /* access recording non-fatal */ }
      }

      // 8. Format results
      return ranked.map(r => ({
        sessionId: r.session_id,
        agentId: r.agent_id,
        source: r.source,
        startedAt: r.started_at,
        summaryText: r.summary_text || null,
        structuredSummary: r.structured_summary || null,
        summarySnippet: r.summary_snippet || null,
        matchedTurnText: r.matched_turn_text || null,
        matchedTurnIndex: r.matched_turn_index || null,
        score: r._score,
        trustScore: r._trustScore ?? 0.5,
        _debug: {
          rrf: r._rrf,
          timeDecay: r._timeDecay,
          access: r._access,
          entityScore: r._entityScore,
          trustScore: r._trustScore,
          trustMultiplier: r._trustMultiplier,
          openLoopBoost: r._openLoopBoost,
        },
      }));
    },

    // --- feedback ---

    async feedback(sessionId, opts = {}) {
      const agentId = opts.agentId || 'agent';
      const verdict = opts.verdict;
      if (!verdict) throw new Error('opts.verdict is required ("helpful" or "unhelpful")');
      await ensureMigrated();

      const session = await storage.getSession(pool, sessionId, agentId, {}, { schema, tenantId });
      if (!session) throw new Error(`Session not found: ${sessionId} (agentId=${agentId})`);

      return storage.recordFeedback(pool, {
        schema,
        tenantId,
        sessionRowId: session.id,
        sessionId,
        agentId,
        verdict,
        note: opts.note || null,
      });
    },

    // --- admin ---

    async getSession(sessionId, opts = {}) {
      const agentId = opts.agentId || 'agent';
      return storage.getSession(pool, sessionId, agentId, opts, { schema, tenantId });
    },

    async getSessionFull(sessionId) {
      // Try to find the session across agents by querying directly
      const result = await pool.query(
        `SELECT * FROM ${qi(schema)}.sessions
        WHERE session_id = $1 AND tenant_id = $2
        LIMIT 1`,
        [sessionId, tenantId]
      );
      const session = result.rows[0];
      if (!session) return null;

      const [segResult, sumResult] = await Promise.all([
        pool.query(
          `SELECT * FROM ${qi(schema)}.session_segments
          WHERE session_row_id = $1
          ORDER BY segment_no ASC`,
          [session.id]
        ),
        pool.query(
          `SELECT * FROM ${qi(schema)}.session_summaries
          WHERE session_row_id = $1
          LIMIT 1`,
          [session.id]
        ),
      ]);

      return {
        session,
        segments: segResult.rows,
        summary: sumResult.rows[0] || null,
      };
    },
  };

  return aquifer;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { createAquifer };
