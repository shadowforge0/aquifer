'use strict';

const { Pool } = require('pg');

const storage = require('./storage');
const entity = require('./entity');
const { hybridRank } = require('./hybrid-rank');
const { summarize } = require('../pipeline/summarize');
const { extractEntities } = require('../pipeline/extract-entities');
const { applyEnrichSafetyGate, sanitizeSummaryResult } = require('./memory-safety-gate');
const { backendCapabilities, normalizeBackendKind } = require('./backends/capabilities');
const { createPostgresMigrationRuntime, qi, validateSchema } = require('./postgres-migrations');
const { createMemoryServingRuntime } = require('./memory-serving');
const { createLegacyBootstrap } = require('./legacy-bootstrap');
const { buildRerankDocument, resolveEmbedFn, shouldAutoRerank } = require('./recall-runtime');
const { filterPublicPlaceholderSessionRows } = require('./public-session-filter');

// ---------------------------------------------------------------------------
// createAquifer
// ---------------------------------------------------------------------------

function createAquifer(config = {}) {
  const backendKind = normalizeBackendKind(config.backend?.kind || config.storage?.backend || 'postgres');
  if (backendKind !== 'postgres') {
    throw new Error(`createAquifer() only constructs the PostgreSQL backend. Use createAquiferFromConfig() for backend "${backendKind}".`);
  }
  const backendInfo = backendCapabilities(backendKind);

  // v1.2.0: db falls back to DATABASE_URL / AQUIFER_DB_URL env so hosts can
  // call createAquifer() with zero args for install-and-go.
  const dbInput = config.db !== undefined
    ? config.db
    : (process.env.DATABASE_URL || process.env.AQUIFER_DB_URL || null);

  if (!dbInput) {
    throw new Error(
      'Aquifer requires a database: pass config.db (pg.Pool or connection string), '
      + 'or set DATABASE_URL / AQUIFER_DB_URL in the environment.'
    );
  }

  const schema = config.schema || process.env.AQUIFER_SCHEMA || 'aquifer';
  validateSchema(schema);

  if (config.tenantId === '') throw new Error('config.tenantId must not be empty');
  const tenantId = config.tenantId || process.env.AQUIFER_TENANT_ID || 'default';

  // Pool management
  let pool;
  let ownsPool = false;
  if (typeof dbInput === 'string') {
    pool = new Pool({ connectionString: dbInput });
    ownsPool = true;
  } else {
    pool = dbInput;
    ownsPool = !!config.ownsPool;  // allow factory to claim ownership
  }

  // Embed config (lazy — only required for recall/enrich)
  // v1.2.0 fallback chain:
  //   1. config.embed.fn (explicit function)
  //   2. config.embed.provider (build via createEmbedder)
  //   3. EMBED_PROVIDER env + provider-specific key (zero-arg install-and-go)
  //   4. null — defer to requireEmbed() at call time
  const embedFn = resolveEmbedFn(config.embed, process.env);
  function requireEmbed(op) {
    if (!embedFn) throw new Error(`Aquifer.${op}() requires config.embed.fn or EMBED_PROVIDER env (async (texts) => number[][])`);
  }

  // LLM config (optional — only needed for enrich with built-in summarize)
  // v1.2.0: falls back to AQUIFER_LLM_PROVIDER env + provider-specific key.
  const { resolveLlmFn } = require('../consumers/shared/llm-autodetect');
  const llmFn = resolveLlmFn(config.llm, process.env);

  // Summarize config
  const summarizePromptFn = config.summarize && config.summarize.prompt ? config.summarize.prompt : null;

  // Enrich stale-claim window: a 'processing' session older than this is
  // reclaimable by a concurrent enrich() caller (covers crashed workers).
  const staleEnrichMinutes = Number.isFinite(config.staleEnrichMinutes)
    ? Math.max(1, Math.floor(config.staleEnrichMinutes))
    : 10;

  // Entity config
  let entitiesEnabled = config.entities && config.entities.enabled === true;

  // Facts config (opt-in consolidation lifecycle)
  let factsEnabled = config.facts && config.facts.enabled === true;
  const mergeCall = config.entities && config.entities.mergeCall !== undefined ? config.entities.mergeCall : true;
  const entityPromptFn = config.entities && config.entities.prompt ? config.entities.prompt : null;
  const entityScope = (config.entities && config.entities.scope) || 'default';

  // Rank weights
  const rankWeights = {
    rrf: 0.65,
    timeDecay: 0.25,
    access: 0.10,
    entityBoost: 0.18,
    ...(config.rank || {}),
  };

  // Reranker config (optional)
  const rerankConfig = config.rerank || null;
  let reranker = null;
  if (rerankConfig) {
    const { createReranker } = require('../pipeline/rerank');
    reranker = createReranker(rerankConfig);
  }
  const defaultRerankTopK = rerankConfig ? Math.max(1, rerankConfig.topK || 20) : 0;
  const rerankMaxChars = rerankConfig ? Math.max(200, rerankConfig.maxChars || 1600) : 0;

  // Auto-trigger gate for rerank: when reranker is configured but caller didn't
  // explicitly pass opts.rerank, decide per-call whether the cost is worth it.
  // Defaults aim for "rerank when shortlist is dense enough to benefit, query
  // is non-trivial, and either signals are mixed (hybrid) or FTS returned a
  // wide candidate set worth narrowing semantically."
  const autoTriggerCfg = (rerankConfig && rerankConfig.autoTrigger) || {};
  const autoTrigger = {
    enabled: autoTriggerCfg.enabled !== false,  // default true when reranker exists
    modes: autoTriggerCfg.modes || ['hybrid'],
    minQueryChars: autoTriggerCfg.minQueryChars ?? 6,
    minQueryTokens: autoTriggerCfg.minQueryTokens ?? 2,
    minResults: autoTriggerCfg.minResults ?? 2,
    maxResults: autoTriggerCfg.maxResults ?? 12,
    maxTopScoreGap: autoTriggerCfg.maxTopScoreGap ?? 0.08,
    alwaysWhenEntities: autoTriggerCfg.alwaysWhenEntities !== false,  // default true
    ftsMinResults: autoTriggerCfg.ftsMinResults ?? 5,  // FTS-only mode triggers when results > this
  };

  // Source registry (in-memory)
  const sources = new Map();

  const memoryServing = createMemoryServingRuntime(config.memory || {}, process.env);
  const legacyBootstrap = createLegacyBootstrap({ pool, schema, tenantId, formatBootstrapText });

  const stateChangesCfg = config.stateChanges || {};
  const stateChangesEnabled = stateChangesCfg.enabled === true;
  const stateChangesWhitelist = new Set(
    (Array.isArray(stateChangesCfg.whitelist) ? stateChangesCfg.whitelist : [])
      .map(s => String(s).toLowerCase())
  );
  const stateChangesPromptFn = stateChangesCfg.promptFn || null;
  const stateChangesConfThreshold = Number.isFinite(stateChangesCfg.confidenceThreshold)
    ? stateChangesCfg.confidenceThreshold : 0.7;
  const stateChangesTimeoutMs = Number.isFinite(stateChangesCfg.timeoutMs)
    ? stateChangesCfg.timeoutMs : 10000;
  const stateChangesMaxOutputTokens = Number.isFinite(stateChangesCfg.maxOutputTokens)
    ? stateChangesCfg.maxOutputTokens : 600;

  const migrationRuntime = createPostgresMigrationRuntime({
    pool,
    schema,
    migrations: config.migrations || {},
    getEntitiesEnabled: () => entitiesEnabled,
    getFactsEnabled: () => factsEnabled,
    initialFtsConfig: config.ftsConfig || null,
  });

  function ensureMigrated() {
    return migrationRuntime.ensureMigrated();
  }

  // =========================================================================
  // Public API
  // =========================================================================

  const aquifer = {
    // --- lifecycle ---

    async ensureMigrated() {
      return ensureMigrated();
    },

    async migrate() {
      return migrationRuntime.migrate();
    },

    async listPendingMigrations() {
      return migrationRuntime.listPendingMigrations();
    },

    async getMigrationStatus() {
      return this.listPendingMigrations();
    },

    async init() {
      return migrationRuntime.init();
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
        weight: opts.weight !== undefined && opts.weight !== undefined ? opts.weight : 1.0,
      });
    },

    async enableEntities() {
      entitiesEnabled = true;
      // M4: if already migrated, run entity DDL now
      if (migrationRuntime.isMigrated()) {
        const entitySql = migrationRuntime.loadSql('002-entities.sql');
        await pool.query(entitySql);
      }
    },

    async enableFacts() {
      factsEnabled = true;
      // Run the facts DDL (idempotent — all CREATE/ALTER use IF NOT EXISTS).
      // Safe to call repeatedly; also safe to call before migrate() (will no-op
      // until base schema exists, which enrich/commit will materialize).
      await ensureMigrated();
      const factsSql = migrationRuntime.loadSql('004-facts.sql');
      await pool.query(factsSql);
    },

    async consolidate(sessionId, opts = {}) {
      if (!factsEnabled) throw new Error('aquifer.consolidate() requires enableFacts() first');
      await ensureMigrated();
      const { applyConsolidation } = require('../pipeline/consolidation');
      const agentId = opts.agentId || 'agent';
      return applyConsolidation(pool, {
        actions: opts.actions || [],
        agentId,
        sessionId,
        schema,
        tenantId,
        normalizeSubject: opts.normalizeSubject || null,
        recapOverview: opts.recapOverview || '',
      });
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

      // 1. Optimistic lock: claim session for processing.
      //    Also reclaim stale 'processing' sessions (likely killed worker).
      //    Stale window is config.staleEnrichMinutes (default 10).
      const claimResult = await pool.query(
        `UPDATE ${qi(schema)}.sessions
        SET processing_status = 'processing', processing_started_at = NOW()
        WHERE session_id = $1 AND agent_id = $2 AND tenant_id = $3
          AND (processing_status IN ('pending', 'failed')
               OR (processing_status = 'processing'
                   AND (processing_started_at IS NULL
                        OR processing_started_at < NOW() - make_interval(mins => $4))))
        RETURNING *`,
        [sessionId, agentId, tenantId, staleEnrichMinutes]
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
      const safety = applyEnrichSafetyGate(normalized);
      const safeNormalized = safety.messages;
      const safetyGate = safety.meta;

      // 2. Extract user turns
      const turns = storage.extractUserTurns(safeNormalized);

      // Collected across pre-tx and tx phases; any non-empty warnings demote
      // the final status from 'succeeded' to 'partial' (see step 8 below).
      const warnings = [];

      // 3. Summarize (custom or built-in)
      let summaryResult = null;
      let entityRaw = null;
      let extra = null;

      if (!skipSummary && safeNormalized.length > 0) {
        // Pre-transaction failures (customSummaryFn / summarize throws) would
        // otherwise bubble out and leave the session stuck in 'processing'
        // until stale reclaim. Capture as a warning so status ends 'partial',
        // keeping parity with how embed/entity-extract failures are treated.
        try {
          if (customSummaryFn) {
            // Custom pipeline: caller handles LLM call and parsing
            summaryResult = await customSummaryFn(safeNormalized);
            if (summaryResult && summaryResult.entityRaw) entityRaw = summaryResult.entityRaw;
            if (summaryResult && summaryResult.extra) extra = summaryResult.extra;
          } else {
            // Built-in pipeline
            const doMergeEntities = entitiesEnabled && mergeCall && !skipEntities;
            summaryResult = await summarize(safeNormalized, {
              llmFn,
              promptFn: summarizePromptFn,
              mergeEntities: doMergeEntities,
            });
            if (summaryResult.entityRaw) {
              entityRaw = summaryResult.entityRaw;
            }
          }
        } catch (e) {
          warnings.push(`summary step failed: ${e.message}`);
          summaryResult = null;
        }
        if (summaryResult) {
          const sanitizedSummary = sanitizeSummaryResult(summaryResult);
          summaryResult = sanitizedSummary.summaryResult;
          safetyGate.summary = sanitizedSummary.meta;
        }
      }

      // 4. Pre-compute all LLM/embed results BEFORE opening transaction
      //    (avoids holding pool connection during slow LLM/embed calls)
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
            parsedEntities = await extractEntities(safeNormalized, { llmFn, promptFn: entityPromptFn });
          }
        } catch (e) { warnings.push(`entity extraction failed: ${e.message}`); }
      }

      // 4d. State-change extraction (Q3) — only if enabled, entities available,
      // and at least one parsed entity matches whitelist. Returns changes with
      // entity_name (not id); resolution happens in tx after entity upsert.
      let parsedStateChanges = [];
      if (stateChangesEnabled && entitiesEnabled && !skipEntities && parsedEntities.length > 0 && llmFn) {
        const scopedEntities = stateChangesWhitelist.size === 0
          ? parsedEntities  // empty whitelist == all parsed entities in scope
          : parsedEntities.filter(e => stateChangesWhitelist.has(String(e.name).toLowerCase()));
        if (scopedEntities.length > 0) {
          try {
            const { extractStateChanges } = require('../pipeline/extract-state-changes');
            const result = await extractStateChanges(safeNormalized, {
              llmFn,
              promptFn: stateChangesPromptFn,
              entities: scopedEntities.map(e => ({ name: e.name, aliases: e.aliases || [] })),
              sessionStartedAt: session.started_at ? new Date(session.started_at).toISOString() : null,
              evidenceSessionId: sessionId,
              confidenceThreshold: stateChangesConfThreshold,
              timeoutMs: stateChangesTimeoutMs,
              maxOutputTokens: stateChangesMaxOutputTokens,
              logger: { warn: (m) => warnings.push(`state-change: ${m}`) },
            });
            parsedStateChanges = result.changes || [];
            for (const w of (result.warnings || [])) warnings.push(`state-change: ${w}`);
          } catch (e) { warnings.push(`state-change extraction failed: ${e.message}`); }
        }
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
            msgCount: safeNormalized.length,
            userCount: turns.length,
            assistantCount: safeNormalized.filter(m => m.role === 'assistant').length,
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

          // 5d. Apply state changes (Q3) inside SAVEPOINT so a CONFLICT or
          // CHECK violation can't poison the parent transaction.
          if (parsedStateChanges.length > 0) {
            // Build name→id map from upserted entities (parsedEntities aligned
            // with entityIds by index).
            const nameToId = new Map();
            for (let i = 0; i < parsedEntities.length && i < entityIds.length; i++) {
              const ent = parsedEntities[i];
              if (!ent || entityIds[i] === null || entityIds[i] === undefined) continue;
              nameToId.set(String(ent.name).toLowerCase(), entityIds[i]);
              for (const a of (ent.aliases || [])) {
                if (typeof a === 'string') nameToId.set(a.toLowerCase(), entityIds[i]);
              }
            }
            const resolved = [];
            for (const ch of parsedStateChanges) {
              const id = nameToId.get(String(ch.entityName || '').toLowerCase());
              if (id === null || id === undefined) continue;
              const { entityName: _drop, ...rest } = ch;
              void _drop;
              resolved.push({ ...rest, entityId: id, sessionRowId: session.id });
            }
            if (resolved.length > 0) {
              try {
                await client.query('SAVEPOINT state_changes');
                const r = await aquifer.entityState.applyChanges(client, {
                  agentId,
                  sessionRowId: session.id,
                  changes: resolved,
                });
                if (!r.ok) {
                  warnings.push(`state-change apply failed: ${r.error.code} ${r.error.message}`);
                  await client.query('ROLLBACK TO SAVEPOINT state_changes');
                } else {
                  await client.query('RELEASE SAVEPOINT state_changes');
                }
              } catch (e) {
                warnings.push(`state-change savepoint error: ${e.message}`);
                try { await client.query('ROLLBACK TO SAVEPOINT state_changes'); } catch { /* ignore */ }
              }
            }
          }
        }

        // 8. Mark status + commit (M5: use 'partial' if warnings)
        const finalStatus = warnings.length > 0 ? 'partial' : 'succeeded';
        await storage.markStatus(client, session.id, finalStatus, warnings.length > 0 ? warnings.join('; ') : null, { schema });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        try {
          await storage.markStatus(pool, session.id, 'failed', err.message, { schema });
        } catch (markErr) {
          // Secondary failure: session is stuck in 'processing' until stale reclaim.
          // Surface so operators notice and don't silently rely on the timeout.
          console.warn(`[aquifer] enrich failed for session ${sessionId} AND markStatus('failed') also failed: ${markErr.message}`);
        }
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
            sanitized: safeNormalized,
            parsedEntities,
            skipped: { summary: skipSummary, entities: skipEntities, turns: skipTurnEmbed },
            safetyGate,
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
        safetyGate,
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

    async memoryRecall(query, opts = {}) {
      memoryServing.assertCuratedRecallOpts(opts);
      await ensureMigrated();
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new Error('memory.recall(query): query must be a non-empty string');
      }
      const validModes = new Set(['fts', 'hybrid', 'vector']);
      const mode = opts.mode || 'hybrid';
      if (!validModes.has(mode)) {
        throw new Error(`Invalid curated recall mode: "${mode}". Must be one of: fts, hybrid, vector`);
      }
      let queryVec = null;
      if (mode === 'hybrid' || mode === 'vector') {
        if (!embedFn) {
          if (mode === 'vector') {
            throw new Error('curated memory_recall mode=vector requires config.embed.fn or EMBED_PROVIDER env');
          }
        } else {
          const embedded = await embedFn([query]);
          queryVec = Array.isArray(embedded) && Array.isArray(embedded[0]) ? embedded[0] : null;
          if (!queryVec && mode === 'vector') throw new Error('embedFn returned empty vector for curated memory_recall');
        }
      }
      const scopedOpts = memoryServing.withDefaultScope(opts);
      const limit = Math.max(1, Math.min(50, scopedOpts.limit || 10));
      const runLexical = mode === 'fts' || mode === 'hybrid';
      const runVector = (mode === 'vector' || mode === 'hybrid') && queryVec;
      const [lexicalRows, embeddingRows] = await Promise.all([
        runLexical ? aquifer.memory.recall(query, {
          ...scopedOpts,
          ftsConfig: migrationRuntime.getFtsConfig(),
        }) : Promise.resolve([]),
        runVector ? aquifer.memory.recallViaMemoryEmbeddings(queryVec, scopedOpts) : Promise.resolve([]),
      ]);
      const rows = aquifer.memory.rankHybridMemoryRows(lexicalRows, embeddingRows, { limit });
      return rows.map(memoryServing.normalizeCuratedRecallRow);
    },

    async historicalRecall(query, opts = {}) {
      return aquifer.evidenceRecall(query, { ...opts, allowBroadEvidence: true });
    },

    async recall(query, opts = {}) {
      if (memoryServing.resolveMode(opts) === 'curated') {
        return aquifer.memoryRecall(query, opts);
      }
      return aquifer.historicalRecall(query, opts);
    },

    async evidenceRecall(query, opts = {}) {
      // Contract (aligned across core / manifest / consumer tools): query must
      // be a non-empty string. Empty strings previously short-circuited to []
      // silently — that masks caller bugs. Callers wanting "recent sessions"
      // should use a dedicated API, not pass empty to recall().
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new Error('aquifer.recall(query): query must be a non-empty string');
      }
      if (opts.allowBroadEvidence !== true && !memoryServing.hasEvidenceBoundary(opts)) {
        throw new Error('evidence_recall requires an audit boundary filter (agentId, source, dateFrom/dateTo, host, sessionId) or allowUnsafeDebug=true');
      }

      const VALID_MODES = ['fts', 'hybrid', 'vector'];
      const mode = opts.mode !== undefined ? opts.mode : 'hybrid';
      if (!VALID_MODES.includes(mode)) {
        throw new Error(`Invalid recall mode: "${mode}". Must be one of: ${VALID_MODES.join(', ')}`);
      }

      if (mode === 'hybrid' || mode === 'vector') {
        requireEmbed('recall');
      }

      const {
        agentId,
        agentIds: rawAgentIds,
        source,
        dateFrom,
        dateTo,
        limit = 5,
        weights: overrideWeights,
        entities: explicitEntities,
        entityMode = 'any',
        strictSearchErrors = false,
      } = opts;
      const searchErrors = [];

      function recordSearchError(pathName, err) {
        searchErrors.push({
          path: pathName,
          message: err && err.message ? err.message : String(err),
        });
      }

      function maybeThrowSearchErrors() {
        if (!strictSearchErrors || searchErrors.length === 0) return;
        const details = searchErrors.map(e => `${e.path}: ${e.message}`).join('; ');
        throw new Error(`Recall search failed: ${details}`);
      }

      // Normalize agentId/agentIds into a single resolved value
      // agentIds takes precedence; agentId is sugar for agentIds: [agentId]
      const resolvedAgentIds = rawAgentIds && rawAgentIds.length > 0
        ? rawAgentIds
        : (agentId ? [agentId] : null);

      // Validate before touching DB
      if (explicitEntities && explicitEntities.length > 0 && !entitiesEnabled) {
        throw new Error('Entities are not enabled');
      }

      await ensureMigrated();

      // rerank gating: provider must be configured + caller didn't disable.
      // Whether to actually invoke is decided after hybridRank, since the
      // shortlist is needed for the auto-trigger heuristics.
      const rerankProviderReady = !!reranker && opts.rerank !== false;
      const rerankForced = opts.rerank === true;
      const rerankTopK = rerankProviderReady ? Math.max(limit, opts.rerankTopK || defaultRerankTopK) : limit;
      const fetchLimit = rerankTopK * 4;

      // 1. Embed query (only needed for hybrid/vector modes)
      let queryVec = null;
      if (mode === 'hybrid' || mode === 'vector') {
        const queryVecResult = await embedFn([query]);
        queryVec = queryVecResult[0];
        if (!queryVec || !queryVec.length) return []; // m3: guard empty array too
      }

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
          // 'any' mode with explicit entities: use resolved IDs for boost.
          // Filter by tenant_id + agentIds to prevent cross-tenant / cross-agent
          // boost pollution (session_id is caller-supplied and not globally unique).
          const esParams = [entityIds, tenantId];
          let esAgentClause = '';
          if (resolvedAgentIds && resolvedAgentIds.length > 0) {
            esParams.push(resolvedAgentIds);
            esAgentClause = `AND s.agent_id = ANY($${esParams.length})`;
          }
          const esResult = await pool.query(
            `SELECT es.session_row_id, s.session_id, COUNT(*) AS entity_count
            FROM ${qi(schema)}.entity_sessions es
            JOIN ${qi(schema)}.sessions s ON s.id = es.session_row_id
            WHERE es.entity_id = ANY($1)
              AND s.tenant_id = $2
              ${esAgentClause}
            GROUP BY es.session_row_id, s.session_id`,
            esParams
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
            const esParams = [entityIds, tenantId];
            let esAgentClause = '';
            if (resolvedAgentIds && resolvedAgentIds.length > 0) {
              esParams.push(resolvedAgentIds);
              esAgentClause = `AND s.agent_id = ANY($${esParams.length})`;
            }
            const esResult = await pool.query(
              `SELECT es.session_row_id, s.session_id, COUNT(*) AS entity_count
              FROM ${qi(schema)}.entity_sessions es
              JOIN ${qi(schema)}.sessions s ON s.id = es.session_row_id
              WHERE es.entity_id = ANY($1)
                AND s.tenant_id = $2
                ${esAgentClause}
              GROUP BY es.session_row_id, s.session_id`,
              esParams
            );

            const maxCount = Math.max(1, ...esResult.rows.map(r => parseInt(r.entity_count)));
            for (const row of esResult.rows) {
              entityScoreBySession.set(row.session_id, parseInt(row.entity_count) / maxCount);
            }
          }
        } catch { /* entity search failure non-fatal */ }
      }

      // 3. Run search paths in parallel (conditioned on mode)
      const runFts = mode === 'fts' || mode === 'hybrid';
      const runVector = mode === 'vector' || mode === 'hybrid';

      const [ftsRows, embResult, turnResult] = await Promise.all([
        runFts
          ? storage.searchSessions(pool, query, {
              schema, tenantId, agentIds: resolvedAgentIds, source, dateFrom, dateTo, limit: fetchLimit,
              ftsConfig: migrationRuntime.getFtsConfig(),
            }).catch((err) => {
              recordSearchError('fts', err);
              return [];
            })
          : Promise.resolve([]),
        runVector
          ? storage.searchSummaryEmbeddings(pool, {
              schema, tenantId, queryVec,
              agentIds: resolvedAgentIds, source, dateFrom, dateTo, limit: fetchLimit,
            }).catch((err) => {
              recordSearchError('summary-vector', err);
              return { rows: [] };
            })
          : Promise.resolve({ rows: [] }),
        runVector
          ? storage.searchTurnEmbeddings(pool, {
              schema, tenantId, queryVec, dateFrom, dateTo, agentIds: resolvedAgentIds, source, limit: fetchLimit,
            }).catch((err) => {
              recordSearchError('turn-vector', err);
              return { rows: [] };
            })
          : Promise.resolve({ rows: [] }),
      ]);

      const embRows = embResult.rows || [];
      const turnRows = turnResult.rows || [];

      // 3b. Apply candidate filter (entityMode 'all')
      const filterFn = candidateSessionIds
        ? (rows) => rows.filter(r => candidateSessionIds.has(r.session_id || String(r.id)))
        : (rows) => rows;

      const filteredFts = filterPublicPlaceholderSessionRows(filterFn(ftsRows));
      const filteredEmb = filterPublicPlaceholderSessionRows(filterFn(embRows));
      const filteredTurn = filterPublicPlaceholderSessionRows(filterFn(turnRows));

      if (filteredFts.length === 0 && filteredEmb.length === 0 && filteredTurn.length === 0) {
        maybeThrowSearchErrors();
        return [];
      }

      // 4. Open-loop set extraction
      const openLoopSet = new Set();
      for (const r of [...filteredFts, ...filteredEmb, ...filteredTurn]) {
        const sid = r.session_id || String(r.id);
        const ss = typeof r.structured_summary === 'string'
          ? (() => { try { return JSON.parse(r.structured_summary); } catch { return null; } })()
          : r.structured_summary;
        if (ss && Array.isArray(ss.open_loops) && ss.open_loops.length > 0) {
          openLoopSet.add(sid);
        }
      }

      // 5. Run external source searches (parallel + timeout)
      const EXTERNAL_TIMEOUT = 10000;
      const externalRows = [];
      const externalPromises = [];
      for (const [name, sourceConfig] of sources) {
        if (typeof sourceConfig.search === 'function') {
          const w = sourceConfig.weight !== undefined && sourceConfig.weight !== undefined ? sourceConfig.weight : 1.0;
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
            }).catch((err) => {
              recordSearchError(`external:${name}`, err);
            })
          );
        }
      }
      if (externalPromises.length > 0) await Promise.all(externalPromises);

      // 6. Hybrid rank
      const filteredExternalRows = filterPublicPlaceholderSessionRows(filterFn(externalRows));
      const mergedWeights = { ...rankWeights, ...overrideWeights };
      const ranked = hybridRank(
        filteredFts,
        [...filteredEmb, ...filteredExternalRows],
        filteredTurn,
        {
          limit: rerankTopK,
          weights: mergedWeights,
          entityScoreBySession,
          openLoopSet,
        },
      );

      // 6b. Rerank (optional, with auto-trigger gate)
      let finalRanked = ranked;
      let rerankDecision = { apply: false, reason: 'provider_not_ready' };
      if (rerankProviderReady && ranked.length > 1) {
        if (rerankForced) {
          rerankDecision = { apply: true, reason: 'forced' };
        } else {
          // hasEntities = either caller passed entities explicitly OR the
          // query-derived path found matching entities (non-empty boost map).
          // shouldAutoRerank names the condition "entities present"; honour both.
          rerankDecision = shouldAutoRerank({
            query,
            mode,
            ranked,
            hasEntities: (explicitEntities && explicitEntities.length > 0)
              || entityScoreBySession.size > 0,
            autoTrigger,
          });
        }
      } else if (!rerankProviderReady) {
        rerankDecision = {
          apply: false,
          reason: !reranker ? 'no_provider_configured' : 'caller_disabled',
        };
      } else {
        rerankDecision = { apply: false, reason: 'shortlist_too_short' };
      }

      if (rerankDecision.apply) {
        try {
          const docs = ranked.map(r => buildRerankDocument(r, rerankMaxChars));
          const rerankResult = await reranker.rerank(query, docs, { topN: ranked.length });
          const scoreMap = new Map(rerankResult.map(r => [r.index, r.score]));

          finalRanked = ranked.map((r, i) => ({
            ...r,
            _hybridScore: r._score,
            _rerankScore: scoreMap.has(i) ? scoreMap.get(i) : null,
            _rerankReason: rerankDecision.reason,
          }));

          finalRanked.sort((a, b) => {
            const aR = a._rerankScore ?? -Infinity;
            const bR = b._rerankScore ?? -Infinity;
            if (aR !== bR) return bR - aR;
            return (b._hybridScore || 0) - (a._hybridScore || 0);
          });
          finalRanked = filterPublicPlaceholderSessionRows(finalRanked).slice(0, limit);
        } catch (rerankErr) {
          // Fallback: use original hybrid-rank order, flag in debug
          if (process.env.AQUIFER_DEBUG) console.error('[aquifer] rerank error:', rerankErr.message);
          finalRanked = filterPublicPlaceholderSessionRows(ranked).slice(0, limit).map(r => ({
            ...r,
            _rerankFallback: true,
            _rerankReason: rerankDecision.reason,
            _rerankErrorMessage: rerankErr.message,
          }));
        }
      } else {
        finalRanked = filterPublicPlaceholderSessionRows(ranked).slice(0, limit).map(r => ({ ...r, _rerankReason: rerankDecision.reason }));
      }

      // 7. Record access
      const sessionRowIds = finalRanked
        .map(r => r.id || r.session_row_id)
        .filter(Boolean);

      if (sessionRowIds.length > 0) {
        try {
          await storage.recordAccess(pool, sessionRowIds, { schema });
        } catch { /* access recording non-fatal */ }
      }

      // 8. Format results
      return finalRanked.map(r => ({
        sessionId: r.session_id,
        agentId: r.agent_id,
        source: r.source,
        startedAt: r.started_at,
        summaryText: r.summary_text || null,
        structuredSummary: r.structured_summary || null,
        matchedTurnText: r.matched_turn_text || null,
        matchedTurnIndex: r.matched_turn_index || null,
        score: r._rerankScore ?? r._score,
        trustScore: r._trustScore ?? 0.5,
        _debug: {
          rrf: r._rrf,
          timeDecay: r._timeDecay,
          access: r._access,
          entityScore: r._entityScore,
          trustScore: r._trustScore,
          trustMultiplier: r._trustMultiplier,
          openLoopBoost: r._openLoopBoost,
          hybridScore: r._hybridScore ?? r._score,
          rerankScore: r._rerankScore ?? null,
          rerankFallback: r._rerankFallback || false,
          rerankApplied: rerankDecision.apply,
          rerankReason: r._rerankReason || rerankDecision.reason,
          rerankErrorMessage: r._rerankErrorMessage || null,
          searchErrors: searchErrors.slice(),
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

    async memoryFeedback(memoryId, opts = {}) {
      let targetMemoryId = memoryId;
      let canonicalKey = opts.canonicalKey || null;
      if (memoryId && typeof memoryId === 'object') {
        targetMemoryId = memoryId.memoryId || memoryId.id || null;
        canonicalKey = memoryId.canonicalKey || memoryId.canonical_key || canonicalKey;
      }
      if (!targetMemoryId && !canonicalKey) {
        throw new Error('memoryFeedback(memoryId): memoryId or canonicalKey is required');
      }
      const feedbackType = opts.feedbackType || opts.verdict;
      if (!feedbackType) throw new Error('opts.feedbackType is required');
      await ensureMigrated();
      if (!targetMemoryId && canonicalKey) {
        const rows = await memoryRecords.findActiveByCanonicalKey({
          tenantId: opts.tenantId || tenantId,
          canonicalKey,
        });
        if (!rows[0]) throw new Error(`Active memory not found: ${canonicalKey}`);
        targetMemoryId = rows[0].id;
        canonicalKey = rows[0].canonical_key || rows[0].canonicalKey || canonicalKey;
      }
      const result = await aquifer.memory.recordFeedback({
        tenantId: opts.tenantId || tenantId,
        targetKind: 'memory_record',
        targetId: targetMemoryId,
        feedbackType,
        actorKind: opts.actorKind || 'user',
        actorId: opts.actorId || opts.agentId || null,
        queryFingerprint: opts.queryFingerprint || null,
        note: opts.note || null,
        metadata: {
          ...(opts.metadata || {}),
          publicSurface: 'memoryFeedback',
        },
      });
      return {
        ...result,
        memoryId: targetMemoryId === null ? null : String(targetMemoryId),
        canonicalKey,
        feedbackType,
      };
    },

    async feedbackStats(opts = {}) {
      await ensureMigrated();
      return storage.getFeedbackStats(pool, {
        schema,
        tenantId,
        agentId: opts.agentId || undefined,
        dateFrom: opts.dateFrom || undefined,
        dateTo: opts.dateTo || undefined,
      });
    },

    // --- admin ---

    async getSession(sessionId, opts = {}) {
      const agentId = opts.agentId || 'agent';
      return storage.getSession(pool, sessionId, agentId, opts, { schema, tenantId });
    },

    async skip(sessionId, opts = {}) {
      const agentId = opts.agentId || 'agent';
      const reason = opts.reason || null;
      // Atomic CAS: only skip if still pending (avoids race with concurrent enrich)
      const result = await pool.query(
        `UPDATE ${qi(schema)}.sessions
        SET processing_status = 'skipped', processing_error = $1
        WHERE session_id = $2 AND agent_id = $3 AND tenant_id = $4
          AND processing_status = 'pending'
        RETURNING id`,
        [reason, sessionId, agentId, tenantId]
      );
      if (result.rows.length === 0) {
        // Check if session exists at all
        const existing = await storage.getSession(pool, sessionId, agentId, {}, { schema, tenantId });
        if (!existing) throw new Error(`Session not found: ${sessionId} (agentId=${agentId})`);
        return null; // exists but not pending — no-op
      }
      return { id: result.rows[0].id, sessionId, agentId, status: 'skipped' };
    },

    // --- public config accessor ---

    getConfig() {
      return {
        schema,
        tenantId,
        memoryServingMode: memoryServing.servingMode,
        memoryActiveScopeKey: memoryServing.defaultActiveScopeKey,
        memoryActiveScopePath: memoryServing.defaultActiveScopePath,
        backendKind,
        backendProfile: backendInfo.profile,
        capabilities: backendInfo.capabilities,
      };
    },

    getCapabilities() {
      return backendCapabilities(backendKind);
    },

    // v1.2.0: expose the internal pool so host persona layers can reuse it
    // for host-owned tables (e.g. daily_entries). Read-only — callers should
    // not call pool.end() on it; use aquifer.close() for that.
    getPool() {
      return pool;
    },

    // v1.2.0: expose resolved LLM function. May be null if no llm.fn was
    // supplied and AQUIFER_LLM_PROVIDER env is unset. Persona layers that
    // implement custom summaryFn can reuse this instead of wiring their own.
    getLlmFn() {
      return llmFn;
    },

    // v1.2.0: expose resolved embed function (may be null same as LLM).
    getEmbedFn() {
      return embedFn;
    },

    // --- admin query helpers ---

    async getStats() {
      const [sessions, summaries, turns, timeRange] = await Promise.all([
        pool.query(
          `SELECT processing_status, COUNT(*)::int as count
          FROM ${qi(schema)}.sessions WHERE tenant_id = $1
          GROUP BY processing_status`,
          [tenantId]
        ),
        pool.query(
          `SELECT COUNT(*)::int as count FROM ${qi(schema)}.session_summaries WHERE tenant_id = $1`,
          [tenantId]
        ),
        pool.query(
          `SELECT COUNT(*)::int as count FROM ${qi(schema)}.turn_embeddings WHERE tenant_id = $1`,
          [tenantId]
        ),
        pool.query(
          `SELECT MIN(started_at) as earliest, MAX(started_at) as latest
          FROM ${qi(schema)}.sessions WHERE tenant_id = $1`,
          [tenantId]
        ),
      ]);

      let entityCount = 0;
      try {
        const entResult = await pool.query(
          `SELECT COUNT(*)::int as count FROM ${qi(schema)}.entities WHERE tenant_id = $1`,
          [tenantId]
        );
        entityCount = entResult.rows[0]?.count || 0;
      } catch { /* entities table may not exist */ }

      let memoryRecords = {
        available: false,
        total: 0,
        active: 0,
        visibleInBootstrap: 0,
        visibleInRecall: 0,
        earliest: null,
        latest: null,
      };
      try {
        const memoryResult = await pool.query(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'active')::int AS active,
             COUNT(*) FILTER (WHERE status = 'active' AND visible_in_bootstrap = true)::int AS visible_in_bootstrap,
             COUNT(*) FILTER (WHERE status = 'active' AND visible_in_recall = true)::int AS visible_in_recall,
             MIN(accepted_at) AS earliest,
             MAX(accepted_at) AS latest
           FROM ${qi(schema)}.memory_records
           WHERE tenant_id = $1`,
          [tenantId]
        );
        const row = memoryResult.rows[0] || {};
        memoryRecords = {
          available: true,
          total: row.total || 0,
          active: row.active || 0,
          visibleInBootstrap: row.visible_in_bootstrap || 0,
          visibleInRecall: row.visible_in_recall || 0,
          earliest: row.earliest || null,
          latest: row.latest || null,
        };
      } catch { /* memory_records table may not exist on older installs */ }

      let sessionFinalizations = {
        available: false,
        total: 0,
        statuses: {},
        latestFinalizedAt: null,
        latestUpdatedAt: null,
      };
      try {
        const finalizationResult = await pool.query(
          `SELECT
             status,
             COUNT(*)::int AS count,
             MAX(finalized_at) AS latest_finalized_at,
             MAX(updated_at) AS latest_updated_at
           FROM ${qi(schema)}.session_finalizations
           WHERE tenant_id = $1
           GROUP BY status`,
          [tenantId]
        );
        const statuses = Object.fromEntries(finalizationResult.rows.map(row => [row.status, row.count]));
        sessionFinalizations = {
          available: true,
          total: finalizationResult.rows.reduce((sum, row) => sum + row.count, 0),
          statuses,
          latestFinalizedAt: finalizationResult.rows
            .map(row => row.latest_finalized_at)
            .filter(Boolean)
            .sort()
            .pop() || null,
          latestUpdatedAt: finalizationResult.rows
            .map(row => row.latest_updated_at)
            .filter(Boolean)
            .sort()
            .pop() || null,
        };
      } catch { /* session_finalizations table may not exist on older installs */ }

      return {
        backendKind,
        backendProfile: backendInfo.profile,
        serving: {
          mode: memoryServing.servingMode,
          activeScopeKey: memoryServing.defaultActiveScopeKey,
          activeScopePath: memoryServing.defaultActiveScopePath,
        },
        sessions: Object.fromEntries(sessions.rows.map(r => [r.processing_status, r.count])),
        sessionTotal: sessions.rows.reduce((s, r) => s + r.count, 0),
        summaries: summaries.rows[0]?.count || 0,
        turnEmbeddings: turns.rows[0]?.count || 0,
        entities: entityCount,
        memoryRecords,
        sessionFinalizations,
        earliest: timeRange.rows[0]?.earliest || null,
        latest: timeRange.rows[0]?.latest || null,
      };
    },

    async getPendingSessions(opts = {}) {
      const limit = opts.limit !== undefined ? opts.limit : 100;
      const result = await pool.query(
        `SELECT session_id, agent_id, processing_status
        FROM ${qi(schema)}.sessions
        WHERE tenant_id = $1
          AND processing_status IN ('pending', 'failed')
        ORDER BY started_at DESC
        LIMIT $2`,
        [tenantId, limit]
      );
      return result.rows;
    },

    async exportSessions(opts = {}) {
      const { agentId, source, limit = 1000 } = opts;
      const where = [`s.tenant_id = $1`];
      const params = [tenantId];

      if (agentId) { params.push(agentId); where.push(`s.agent_id = $${params.length}`); }
      if (source) { params.push(source); where.push(`s.source = $${params.length}`); }
      params.push(limit);

      const result = await pool.query(
        `SELECT s.session_id, s.agent_id, s.source, s.started_at, s.msg_count,
                s.processing_status, ss.summary_text, ss.structured_summary
        FROM ${qi(schema)}.sessions s
        LEFT JOIN ${qi(schema)}.session_summaries ss ON ss.session_row_id = s.id
        WHERE ${where.join(' AND ')}
        ORDER BY s.started_at DESC
        LIMIT $${params.length}`,
        params
      );
      return result.rows;
    },

    async memoryBootstrap(opts = {}) {
      await ensureMigrated();
      memoryServing.assertCuratedBootstrapOpts(opts);
      return aquifer.memory.bootstrap(memoryServing.withDefaultScope(opts));
    },

    async historicalBootstrap(opts = {}) {
      await ensureMigrated();
      return legacyBootstrap(opts);
    },

    async bootstrap(opts = {}) {
      if (memoryServing.resolveMode(opts) === 'curated') {
        return aquifer.memoryBootstrap(opts);
      }

      return aquifer.historicalBootstrap(opts);
    },
  };

  // Completion-capability surfaces (P2). All methods return AqResult envelope;
  // DDL materialised in schema/004-completion.sql (migrated unconditionally,
  // additive only). See core/errors.js for envelope shape.
  const { createNarratives } = require('./narratives');
  const { createTimeline } = require('./timeline');
  const { createState } = require('./state');
  const { createHandoff } = require('./handoff');
  const { createProfiles } = require('./profiles');
  const { createDecisions } = require('./decisions');
  const { createArtifacts } = require('./artifacts');
  const { createConsolidation } = require('./consolidation');
  const { createBundles } = require('./bundles');
  const { createEntityState } = require('./entity-state');
  const { createInsights } = require('./insights');
  const { createMemoryRecords } = require('./memory-records');
  const { createMemoryPromotion, buildMemoryEmbeddingText } = require('./memory-promotion');
  const { createMemoryBootstrap } = require('./memory-bootstrap');
  const { createMemoryRecall } = require('./memory-recall');
  const { createMemoryConsolidation } = require('./memory-consolidation');
  const { createSessionFinalization } = require('./session-finalization');
  const { createSessionCheckpoints } = require('./session-checkpoints');
  const qSchema = qi(schema);
  aquifer.narratives = createNarratives({ pool, schema: qSchema, defaultTenantId: tenantId });
  aquifer.timeline = createTimeline({ pool, schema: qSchema, defaultTenantId: tenantId });
  aquifer.state = createState({ pool, schema: qSchema, defaultTenantId: tenantId });
  aquifer.handoff = createHandoff({ pool, schema: qSchema, defaultTenantId: tenantId });
  aquifer.profiles = createProfiles({ pool, schema: qSchema, defaultTenantId: tenantId });
  aquifer.decisions = createDecisions({ pool, schema: qSchema, defaultTenantId: tenantId });
  aquifer.artifacts = createArtifacts({ pool, schema: qSchema, defaultTenantId: tenantId });
  aquifer.consolidation = createConsolidation({ pool, schema: qSchema, defaultTenantId: tenantId });
  aquifer.bundles = createBundles({ pool, schema: qSchema, defaultTenantId: tenantId });
  // entityState materialises in schema/005-entity-state-history.sql, gated on
  // entitiesEnabled (it FK-references entities). Drop-clean — see
  // scripts/drop-entity-state-history.sql.
  aquifer.entityState = createEntityState({ pool, schema: qSchema, defaultTenantId: tenantId });
  // insights materialises in schema/006-insights.sql. No FK from elsewhere
  // into this table; DROP CASCADE is clean. See scripts/drop-insights.sql.
  // Recall ranking weights configurable via config.insights.recallWeights.
  aquifer.insights = createInsights({
    pool,
    schema: qSchema,
    defaultTenantId: tenantId,
    embedFn,
    recallWeights: (config.insights && config.insights.recallWeights) || null,
    recencyWindowDays: config.insights && Number.isFinite(config.insights.recencyWindowDays)
      ? config.insights.recencyWindowDays : undefined,
    dedup: config.insights && config.insights.dedup ? config.insights.dedup : undefined,
  });

  const memoryRecords = createMemoryRecords({ pool, schema: qSchema, defaultTenantId: tenantId });
  const memoryPromotion = createMemoryPromotion({ records: memoryRecords, embedFn });
  const memoryBootstrap = createMemoryBootstrap({ records: memoryRecords });
  const memoryRecall = createMemoryRecall({ pool, schema: qSchema, defaultTenantId: tenantId });
  const memoryConsolidation = createMemoryConsolidation({
    pool,
    schema: qSchema,
    defaultTenantId: tenantId,
    records: memoryRecords,
  });
  const sessionFinalization = createSessionFinalization({
    pool,
    schema,
    recordsSchema: qSchema,
    defaultTenantId: tenantId,
    embedFn,
  });
  const sessionCheckpoints = createSessionCheckpoints({
    pool,
    schema,
    defaultTenantId: tenantId,
  });

  function currentMemoryScopeKeys(opts = {}) {
    if (Array.isArray(opts.activeScopePath) && opts.activeScopePath.length > 0) {
      return opts.activeScopePath.map(value => String(value)).filter(Boolean);
    }
    if (opts.activeScopeKey) return [String(opts.activeScopeKey)];
    return null;
  }

  // v1 curated-memory sidecar. Top-level recall/bootstrap can opt into this
  // plane through memory.servingMode while legacy/evidence mode remains
  // available for compatibility and debugging.
  aquifer.memory = {
    upsertScope: async (input = {}) => {
      await ensureMigrated();
      return memoryRecords.upsertScope(input);
    },
    createVersion: async (input = {}) => {
      await ensureMigrated();
      return memoryRecords.createVersion(input);
    },
    upsertMemory: async (input = {}) => {
      await ensureMigrated();
      return memoryRecords.upsertMemory(input);
    },
    upsertEvidenceItem: async (input = {}) => {
      await ensureMigrated();
      return memoryRecords.upsertEvidenceItem(input);
    },
    linkEvidence: async (input = {}) => {
      await ensureMigrated();
      return memoryRecords.linkEvidence(input);
    },
    recordFeedback: async (input = {}) => {
      await ensureMigrated();
      return memoryRecords.recordFeedback(input);
    },
    extractCandidates: (input = {}) => memoryPromotion.extractCandidates(input),
    assessCandidate: (candidate = {}) => memoryPromotion.assessCandidate(candidate),
    promote: async (candidates = [], opts = {}) => {
      await ensureMigrated();
      return memoryPromotion.promote(candidates, opts);
    },
    bootstrap: async (opts = {}) => {
      await ensureMigrated();
      return memoryBootstrap.bootstrap(opts);
    },
    current: async (opts = {}) => {
      await ensureMigrated();
      return memoryRecords.currentProjection(memoryServing.withDefaultScope(opts));
    },
    listCurrentMemory: async (opts = {}) => {
      await ensureMigrated();
      return memoryRecords.currentProjection(memoryServing.withDefaultScope(opts));
    },
    backfillEmbeddings: async (opts = {}) => {
      await ensureMigrated();
      requireEmbed('memory.backfillEmbeddings');
      const scopedOpts = memoryServing.withDefaultScope(opts);
      const listInput = {
        tenantId: scopedOpts.tenantId || tenantId,
        asOf: scopedOpts.asOf,
        scopeId: scopedOpts.scopeId,
        scopeKeys: currentMemoryScopeKeys(scopedOpts),
        withoutEmbedding: true,
        limit: Math.max(1, Math.min(200, scopedOpts.limit || 50)),
      };
      if (scopedOpts.visibleInRecall !== undefined) {
        listInput.visibleInRecall = scopedOpts.visibleInRecall;
      } else if (scopedOpts.visibleInBootstrap === undefined) {
        listInput.visibleInRecall = true;
      }
      if (scopedOpts.visibleInBootstrap !== undefined) {
        listInput.visibleInBootstrap = scopedOpts.visibleInBootstrap;
      }
      const sourceRows = await memoryRecords.listActive(listInput);
      const rowsToEmbed = [];
      const texts = [];
      for (const row of sourceRows) {
        const text = buildMemoryEmbeddingText(row);
        if (!text) continue;
        rowsToEmbed.push(row);
        texts.push(text);
      }
      if (rowsToEmbed.length === 0) {
        return {
          scanned: sourceRows.length,
          embedded: 0,
          skipped: sourceRows.length,
          memories: [],
        };
      }
      const vectors = await embedFn(texts);
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error(`memory.backfillEmbeddings embedFn returned ${Array.isArray(vectors) ? vectors.length : 'invalid'} vectors for ${texts.length} memory rows`);
      }
      const updatedRows = [];
      let skipped = sourceRows.length - rowsToEmbed.length;
      const skippedMemories = [];
      for (let i = 0; i < rowsToEmbed.length; i++) {
        const vector = vectors[i];
        if (!Array.isArray(vector) || vector.length === 0) {
          skipped += 1;
          skippedMemories.push({
            memoryId: String(rowsToEmbed[i].id),
            canonicalKey: rowsToEmbed[i].canonical_key || rowsToEmbed[i].canonicalKey || null,
            reason: 'empty_vector',
          });
          continue;
        }
        const updateResult = await memoryRecords.updateMemoryEmbedding({
          tenantId: scopedOpts.tenantId || tenantId,
          memoryId: rowsToEmbed[i].id,
          embedding: vector,
        });
        if (updateResult && updateResult.updated && updateResult.memory) {
          updatedRows.push(updateResult.memory);
          continue;
        }
        skipped += 1;
        skippedMemories.push({
          memoryId: String(rowsToEmbed[i].id),
          canonicalKey: rowsToEmbed[i].canonical_key || rowsToEmbed[i].canonicalKey || null,
          reason: updateResult && updateResult.status ? updateResult.status : 'not_updated',
        });
      }
      return {
        scanned: sourceRows.length,
        embedded: updatedRows.length,
        skipped,
        memories: updatedRows.map(memoryRecords.normalizeCurrentMemoryRow),
        skippedMemories,
      };
    },
    recall: async (query, opts = {}) => {
      await ensureMigrated();
      return memoryRecall.recall(query, opts);
    },
    recallViaEvidenceItems: async (query, opts = {}) => {
      await ensureMigrated();
      return memoryRecall.recallViaEvidenceItems(query, opts);
    },
    recallViaMemoryEmbeddings: async (queryVec, opts = {}) => {
      await ensureMigrated();
      return memoryRecall.recallViaMemoryEmbeddings(queryVec, opts);
    },
    recallViaLinkedSummaryEmbeddings: async (queryVec, opts = {}) => {
      await ensureMigrated();
      return memoryRecall.recallViaLinkedSummaryEmbeddings(queryVec, opts);
    },
    rankHybridMemoryRows: (lexicalRows, embeddingRows, opts = {}) => {
      return memoryRecall.rankHybridMemoryRows(lexicalRows, embeddingRows, opts);
    },
    consolidation: {
      plan: memoryConsolidation.plan,
      distillArchiveSnapshot: memoryConsolidation.distillArchiveSnapshot,
      runJob: async (input = {}) => {
        await ensureMigrated();
        return memoryConsolidation.runJob(input);
      },
      recordRun: async (input = {}) => {
        await ensureMigrated();
        return memoryConsolidation.recordRun(input);
      },
      claimRun: async (input = {}) => {
        await ensureMigrated();
        return memoryConsolidation.claimRun(input);
      },
      applyPlan: async (input = {}) => {
        await ensureMigrated();
        return memoryConsolidation.applyPlan(input);
      },
      executePlan: async (input = {}) => {
        await ensureMigrated();
        return memoryConsolidation.executePlan(input);
      },
    },
  };

  aquifer.finalization = {
    createTask: async (input = {}) => {
      await ensureMigrated();
      return sessionFinalization.createTask(input);
    },
    get: async (input = {}) => {
      await ensureMigrated();
      return sessionFinalization.get(input);
    },
    list: async (input = {}) => {
      await ensureMigrated();
      return sessionFinalization.list(input);
    },
    updateStatus: async (input = {}) => {
      await ensureMigrated();
      return sessionFinalization.updateStatus(input);
    },
    finalizeSession: async (input = {}) => {
      await ensureMigrated();
      return sessionFinalization.finalizeSession(input);
    },
  };

  aquifer.checkpoints = {
    upsertRun: async (input = {}) => {
      await ensureMigrated();
      return sessionCheckpoints.upsertRun(input);
    },
    updateRunStatus: async (input = {}) => {
      await ensureMigrated();
      return sessionCheckpoints.updateRunStatus(input);
    },
    listRuns: async (input = {}) => {
      await ensureMigrated();
      return sessionCheckpoints.listRuns(input);
    },
    upsertSources: async (rows = [], input = {}) => {
      await ensureMigrated();
      return sessionCheckpoints.upsertSources(rows, input);
    },
    listSources: async (input = {}) => {
      await ensureMigrated();
      return sessionCheckpoints.listSources(input);
    },
    buildSynthesisInput: (input = {}) => sessionCheckpoints.buildSynthesisInput(input),
    buildSynthesisPrompt: (input = {}, opts = {}) => sessionCheckpoints.buildSynthesisPrompt(input, opts),
    buildRunInputFromSynthesis: (input = {}, summary = {}, opts = {}) => (
      sessionCheckpoints.buildRunInputFromSynthesis(input, summary, opts)
    ),
    planFromFinalizations: async (input = {}) => {
      await ensureMigrated();
      return sessionCheckpoints.planFromFinalizations(input);
    },
    runProducer: async (input = {}) => {
      await ensureMigrated();
      return sessionCheckpoints.runProducer(input);
    },
    listForHandoff: async (input = {}) => {
      await ensureMigrated();
      return sessionCheckpoints.listForHandoff(input);
    },
    listAcceptedForHandoff: async (input = {}) => {
      await ensureMigrated();
      return sessionCheckpoints.listAcceptedForHandoff(input);
    },
  };

  aquifer.finalizeSession = aquifer.finalization.finalizeSession;

  return aquifer;
}

// ---------------------------------------------------------------------------
// formatBootstrapText — pure function, builds <session-bootstrap> XML block
// ---------------------------------------------------------------------------

function formatBootstrapText(data, maxChars) {
  if (!data.sessions || data.sessions.length === 0) {
    return { text: 'No recent sessions found.', truncated: false };
  }

  let truncated = false;
  // Build session lines (newest first, truncate from oldest if over budget)
  const sessionLines = [];
  for (const s of data.sessions) {
    const date = s.startedAt ? new Date(s.startedAt).toISOString().slice(0, 10) : '?';
    const title = s.title || '(untitled)';
    const overview = s.overview ? s.overview.slice(0, 200) : '';
    let line = `- ${date} | ${title}`;
    if (overview) line += ` — ${overview}`;
    const decisions = s.decisions
      .map(d => typeof d === 'string' ? d : d.decision)
      .filter(Boolean);
    if (decisions.length > 0) line += `\n  Decisions: ${decisions.join('; ')}`;
    sessionLines.push(line);
  }

  // Fit within maxChars by removing oldest sessions
  let bodyLines = [...sessionLines];
  const footer = [];
  if (data.openLoops.length > 0) {
    footer.push(`Open items: ${data.openLoops.map(l => l.item).join(', ')}`);
  }
  if (data.recentDecisions.length > 0) {
    footer.push(`Recent decisions: ${data.recentDecisions.map(d => d.decision).join(', ')}`);
  }

  const buildText = (lines) => {
    const body = ['Recent sessions:', ...lines].join('\n');
    const full = footer.length > 0 ? body + '\n' + footer.join('\n') : body;
    return `<session-bootstrap sessions="${lines.length}" open_loops="${data.openLoops.length}">\n${full}\n</session-bootstrap>`;
  };

  let text = buildText(bodyLines);
  while (text.length > maxChars && bodyLines.length > 1) {
    bodyLines.pop();  // remove oldest
    truncated = true;
    text = buildText(bodyLines);
  }

  return { text, truncated };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { createAquifer, formatBootstrapText, shouldAutoRerank };
