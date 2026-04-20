'use strict';

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const storage = require('./storage');
const entity = require('./entity');
const { hybridRank } = require('./hybrid-rank');
const { summarize } = require('../pipeline/summarize');
const { extractEntities } = require('../pipeline/extract-entities');
const { createEmbedder } = require('../pipeline/embed');

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
// buildRerankDocument — assemble text for cross-encoder reranking
// ---------------------------------------------------------------------------

function buildRerankDocument(row, maxChars) {
  // Prefer structured_summary fields when available — title/overview carry
  // more signal than summary_text for short Chinese recaps, and topics /
  // decisions / open_loops give the cross-encoder substantive content.
  // Fall back to summary_text / matched_turn_text when structured is absent.
  const ss = row.structured_summary || null;
  const parts = [];
  if (ss) {
    if (ss.title) parts.push(String(ss.title).trim());
    if (ss.overview) parts.push(String(ss.overview).trim());
    if (Array.isArray(ss.topics)) {
      const topics = ss.topics
        .map(t => typeof t === 'string' ? t : (t && t.name ? `${t.name}${t.summary ? ': ' + t.summary : ''}` : ''))
        .filter(Boolean).join(' / ');
      if (topics) parts.push(topics);
    }
    if (Array.isArray(ss.decisions)) {
      const decisions = ss.decisions
        .map(d => typeof d === 'string' ? d : (d && d.decision ? d.decision : ''))
        .filter(Boolean).join(' / ');
      if (decisions) parts.push(`Decisions: ${decisions}`);
    }
    if (Array.isArray(ss.open_loops)) {
      const loops = ss.open_loops
        .map(l => typeof l === 'string' ? l : (l && l.item ? l.item : ''))
        .filter(Boolean).join(' / ');
      if (loops) parts.push(`Open loops: ${loops}`);
    }
  }
  if (!parts.length) {
    const bare = (row.summary_text || row.summary_snippet || '').trim();
    if (bare) parts.push(bare);
  }
  const turn = (row.matched_turn_text || '').replace(/\s+/g, ' ').trim();
  if (turn) {
    const joined = parts.join(' \n ');
    if (!joined.includes(turn)) parts.push(`Matched turn: ${turn}`);
  }

  let text = parts.join('\n\n').replace(/[ \t]+/g, ' ').trim();
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return text;
}

// ---------------------------------------------------------------------------
// resolveEmbedFn — v1.2.0 embed autodetect (explicit > object > env > null)
// ---------------------------------------------------------------------------

function resolveEmbedFn(embedConfig, env) {
  if (embedConfig && typeof embedConfig.fn === 'function') {
    return embedConfig.fn;
  }
  if (embedConfig && embedConfig.provider) {
    const embedder = createEmbedder(embedConfig);
    return (texts) => embedder.embedBatch(texts);
  }
  const provider = env.EMBED_PROVIDER;
  if (!provider) return null;

  const opts = { provider };
  if (provider === 'ollama') {
    opts.ollamaUrl = env.OLLAMA_URL || env.AQUIFER_EMBED_BASE_URL || 'http://localhost:11434';
    opts.model = env.AQUIFER_EMBED_MODEL || 'bge-m3';
  } else if (provider === 'openai') {
    opts.openaiApiKey = env.OPENAI_API_KEY;
    if (!opts.openaiApiKey) {
      throw new Error('EMBED_PROVIDER=openai requires OPENAI_API_KEY');
    }
    opts.openaiModel = env.AQUIFER_EMBED_MODEL || 'text-embedding-3-small';
    if (env.AQUIFER_EMBED_DIM) opts.openaiDimensions = Number(env.AQUIFER_EMBED_DIM);
  } else {
    throw new Error(`EMBED_PROVIDER=${provider} not supported by autodetect (use 'ollama' or 'openai', or pass config.embed.fn explicitly)`);
  }
  const embedder = createEmbedder(opts);
  return (texts) => embedder.embedBatch(texts);
}

// ---------------------------------------------------------------------------
// createAquifer
// ---------------------------------------------------------------------------

// Decide whether to invoke the optional reranker on this recall call.
// Returns `{ apply: boolean, reason: string }`. Pure function — no side effects.
function shouldAutoRerank({ query, mode, ranked, hasEntities, autoTrigger }) {
  if (!autoTrigger.enabled) return { apply: false, reason: 'auto_disabled' };

  if (hasEntities && autoTrigger.alwaysWhenEntities) {
    return { apply: true, reason: 'entities_present' };
  }

  const len = ranked.length;
  if (len < autoTrigger.minResults) return { apply: false, reason: 'too_few_results' };
  if (len > autoTrigger.maxResults) return { apply: false, reason: 'too_many_results' };

  const q = String(query || '').trim();
  const tokenCount = q.split(/\s+/).filter(Boolean).length;
  if (q.length < autoTrigger.minQueryChars && tokenCount < autoTrigger.minQueryTokens) {
    return { apply: false, reason: 'query_too_short' };
  }

  // FTS-only path: rerank when results are wide enough that semantic narrowing
  // is valuable. Cohere-style cross-encoders excel at re-ranking keyword hits.
  if (mode === 'fts') {
    if (len > autoTrigger.ftsMinResults) return { apply: true, reason: 'fts_wide_shortlist' };
    return { apply: false, reason: 'fts_shortlist_too_narrow' };
  }

  if (!autoTrigger.modes.includes(mode)) {
    return { apply: false, reason: 'mode_not_in_autotrigger_modes' };
  }

  // Hybrid: if top-1 and top-2 are close, signals are mixed enough to benefit.
  if (len >= 2) {
    const s0 = ranked[0]?._score ?? 0;
    const s1 = ranked[1]?._score ?? 0;
    if (s0 - s1 <= autoTrigger.maxTopScoreGap) {
      return { apply: true, reason: 'top_score_gap_close' };
    }
  }

  return { apply: false, reason: 'top_score_gap_wide' };
}

function createAquifer(config = {}) {
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

  // Track if migrate was called
  let migrated = false;
  let migratePromise = null;

  // FTS tsconfig — auto-detected during migrate(). 'zhcfg' if zhparser is
  // installed (better Chinese segmentation), otherwise 'simple' (legacy).
  // Override via config.ftsConfig if you need to force one or the other.
  let ftsConfig = config.ftsConfig || null;

  // State-change extraction (Q3): off by default. When enabled, enrich() runs
  // an extra LLM call to capture temporal state transitions on whitelisted
  // entities. See pipeline/extract-state-changes.js + core/entity-state.js.
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

  async function ensureMigrated() {
    if (migrated) return;
    if (migratePromise) return migratePromise;
    migratePromise = aquifer.migrate().finally(() => { migratePromise = null; });
    return migratePromise;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  const aquifer = {
    // --- lifecycle ---

    async migrate() {
      // Advisory lock prevents concurrent migrations across processes.
      // Lock key is derived from schema name to allow parallel migration
      // of different schemas in the same database.
      const lockKey = Buffer.from(`aquifer:${schema}`).reduce((h, b) => (h * 31 + b) & 0x7fffffff, 0);

      // Run all migration DDL on a single checked-out client so we can
      // capture RAISE NOTICE/WARNING emitted by the DO blocks. node-postgres
      // swallows notices on pool.query(); attaching a 'notice' listener to a
      // held client surfaces them. Fall back to pool.query() when the caller
      // passed a bare mock (no connect/release) — tests using minimal pool
      // stubs still exercise the migration shape, just without notice capture.
      const supportsCheckout = typeof pool.connect === 'function';
      const client = supportsCheckout ? await pool.connect() : pool;
      const releasesClient = supportsCheckout && typeof client.release === 'function';
      const notices = [];
      const onNotice = (n) => {
        notices.push({ severity: n.severity || 'NOTICE', message: n.message || String(n) });
      };
      const hasEvents = typeof client.on === 'function' && typeof client.off === 'function';
      if (hasEvents) client.on('notice', onNotice);

      try {
        await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
        try {
          // 1. Run base DDL
          const baseSql = loadSql('001-base.sql', schema);
          await client.query(baseSql);

          // 2. If entities enabled, run entity DDL
          if (entitiesEnabled) {
            const entitySql = loadSql('002-entities.sql', schema);
            await client.query(entitySql);
          }

          // 3. Trust + feedback (always, not gated by entities)
          const trustSql = loadSql('003-trust-feedback.sql', schema);
          await client.query(trustSql);

          // 4. Facts / consolidation (opt-in)
          if (factsEnabled) {
            const factsSql = loadSql('004-facts.sql', schema);
            await client.query(factsSql);
          }

          // 5. Completion foundation (always, additive): narratives,
          // consumer_profiles, sessions.consolidation_phases. Pure additive DDL
          // with IF NOT EXISTS guards — safe on every migrate() call.
          const completionSql = loadSql('004-completion.sql', schema);
          await client.query(completionSql);

          // 6. Entity state history (always, gated by entitiesEnabled because
          // it FK-references entities). Drop-clean — see scripts/drop-entity-state-history.sql.
          if (entitiesEnabled) {
            const stateHistorySql = loadSql('005-entity-state-history.sql', schema);
            await client.query(stateHistorySql);
          }

          // 7. Insights (always, additive). No FK from anywhere into this table —
          // safe to DROP CASCADE. See scripts/drop-insights.sql.
          const insightsSql = loadSql('006-insights.sql', schema);
          await client.query(insightsSql);

          migrated = true;
        } finally {
          await client.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch((err) => {
            console.warn(`[aquifer] failed to release migration advisory lock for schema "${schema}": ${err.message}`);
          });
        }
      } finally {
        if (hasEvents) client.off('notice', onNotice);
        if (releasesClient) client.release();
      }

      // Surface captured migration notices that operators need to see:
      //   - any WARNING/ERROR (zhcfg rebuild warnings, HNSW OOM, etc.)
      //   - aquifer-authored NOTICE messages ('[aquifer] ...' prefix in the
      //     migration DO blocks; these announce extension-install fallback,
      //     HNSW deferral, and other operational decisions)
      // Filtered out: PG's own "relation already exists, skipping" and
      // similar idempotent-DDL chatter that floods a re-run.
      for (const n of notices) {
        const sev = (n.severity || 'NOTICE').toUpperCase();
        const msg = n.message || '';
        const line = `[aquifer] migration ${sev.toLowerCase()}: ${msg}`;
        if (sev === 'WARNING' || sev === 'ERROR') {
          console.warn(line);
        } else if (sev === 'NOTICE' && msg.startsWith('[aquifer]')) {
          console.info(line);
        }
      }

      // Auto-detect FTS tsconfig if not forced by config. Restrict to the
      // public namespace — same restriction the trigger function uses — so a
      // same-named config in another schema doesn't fool the detection.
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

      // Post-flight: surface which Chinese FTS backend the migration actually
      // landed on, and warm the backend's tokenizer so the first live query
      // doesn't pay cold-start cost unpredictably. RAISE NOTICE/WARNING from
      // the migration DO blocks are swallowed by node-postgres unless a
      // notice handler is attached, so without this operators can't tell if
      // pg_jieba silently failed to install and FTS is degraded to 'simple'.
      //
      // pg_jieba first-backend load is ~60MB RAM + 0.5-1s to mmap the dict.
      // Warming once inside migrate() amortizes that on the backend that runs
      // migration; other pool backends still pay it on first use, but the
      // timing surfaces the cost so operators who see unexpected latency
      // know where to look.
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
          const t0 = Date.now();
          await pool.query(`SELECT to_tsvector('zhcfg', $1)`, ['warmup 記憶系統 aquifer'])
            .catch(() => {});
          warmupMs = Date.now() - t0;
        }

        const warmupNote = warmupMs !== null ? ` warmup=${warmupMs}ms` : '';
        console.info(
          `[aquifer] FTS post-flight: backend=${backend} ` +
          `jieba=${row.have_jieba} zhparser=${row.have_zhparser} ` +
          `selected=${ftsConfig}${warmupNote}`
        );
        if (warmupMs !== null && warmupMs > 500) {
          console.info(
            `[aquifer] Note: first FTS call paid ~${warmupMs}ms for tokenizer init ` +
            `(dictionary mmap). Subsequent calls on the same backend are cached.`
          );
        }
      } catch (err) {
        console.warn(`[aquifer] FTS post-flight check failed: ${err.message}`);
      }
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
      if (migrated) {
        const entitySql = loadSql('002-entities.sql', schema);
        await pool.query(entitySql);
      }
    },

    async enableFacts() {
      factsEnabled = true;
      // Run the facts DDL (idempotent — all CREATE/ALTER use IF NOT EXISTS).
      // Safe to call repeatedly; also safe to call before migrate() (will no-op
      // until base schema exists, which enrich/commit will materialize).
      await ensureMigrated();
      const factsSql = loadSql('004-facts.sql', schema);
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

      // 2. Extract user turns
      const turns = storage.extractUserTurns(normalized);

      // Collected across pre-tx and tx phases; any non-empty warnings demote
      // the final status from 'succeeded' to 'partial' (see step 8 below).
      const warnings = [];

      // 3. Summarize (custom or built-in)
      let summaryResult = null;
      let entityRaw = null;
      let extra = null;

      if (!skipSummary && normalized.length > 0) {
        // Pre-transaction failures (customSummaryFn / summarize throws) would
        // otherwise bubble out and leave the session stuck in 'processing'
        // until stale reclaim. Capture as a warning so status ends 'partial',
        // keeping parity with how embed/entity-extract failures are treated.
        try {
          if (customSummaryFn) {
            // Custom pipeline: caller handles LLM call and parsing
            summaryResult = await customSummaryFn(normalized);
            if (summaryResult && summaryResult.entityRaw) entityRaw = summaryResult.entityRaw;
            if (summaryResult && summaryResult.extra) extra = summaryResult.extra;
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
        } catch (e) {
          warnings.push(`summary step failed: ${e.message}`);
          summaryResult = null;
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
            parsedEntities = await extractEntities(normalized, { llmFn, promptFn: entityPromptFn });
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
            const result = await extractStateChanges(normalized, {
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
      // Contract (aligned across core / manifest / consumer tools): query must
      // be a non-empty string. Empty strings previously short-circuited to []
      // silently — that masks caller bugs. Callers wanting "recent sessions"
      // should use a dedicated API, not pass empty to recall().
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new Error('aquifer.recall(query): query must be a non-empty string');
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
              ftsConfig,
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

      const filteredFts = filterFn(ftsRows);
      const filteredEmb = filterFn(embRows);
      const filteredTurn = filterFn(turnRows);

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
      const mergedWeights = { ...rankWeights, ...overrideWeights };
      const ranked = hybridRank(
        filteredFts,
        [...filteredEmb, ...filterFn(externalRows)],
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
          finalRanked = finalRanked.slice(0, limit);
        } catch (rerankErr) {
          // Fallback: use original hybrid-rank order, flag in debug
          if (process.env.AQUIFER_DEBUG) console.error('[aquifer] rerank error:', rerankErr.message);
          finalRanked = ranked.slice(0, limit).map(r => ({
            ...r,
            _rerankFallback: true,
            _rerankReason: rerankDecision.reason,
            _rerankErrorMessage: rerankErr.message,
          }));
        }
      } else {
        finalRanked = ranked.slice(0, limit).map(r => ({ ...r, _rerankReason: rerankDecision.reason }));
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
      return { schema, tenantId };
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

      return {
        sessions: Object.fromEntries(sessions.rows.map(r => [r.processing_status, r.count])),
        sessionTotal: sessions.rows.reduce((s, r) => s + r.count, 0),
        summaries: summaries.rows[0]?.count || 0,
        turnEmbeddings: turns.rows[0]?.count || 0,
        entities: entityCount,
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

    async bootstrap(opts = {}) {
      await ensureMigrated();

      const agentId = opts.agentId || null;
      const source = opts.source || null;
      const limit = Math.max(1, Math.min(20, opts.limit || 5));
      const lookbackDays = opts.lookbackDays || 14;
      const maxChars = opts.maxChars || 4000;
      const format = opts.format || 'structured';

      // 'partial' sessions have a summary but recorded warnings during enrich;
      // they are user-visible content, not in-progress — bootstrap must include
      // them alongside 'succeeded'. 'pending' / 'processing' have no summary
      // yet and are correctly excluded.
      const where = [`s.tenant_id = $1`, `s.processing_status IN ('succeeded', 'partial')`];
      const params = [tenantId];

      if (agentId) {
        params.push(agentId);
        where.push(`s.agent_id = $${params.length}`);
      }
      if (source) {
        params.push(source);
        where.push(`s.source = $${params.length}`);
      }

      params.push(lookbackDays);
      // upsertSession sets ended_at on every commit but started_at / last_message_at
      // only when the caller supplies them — fall back through both so sessions
      // committed without explicit timestamps remain reachable.
      where.push(`COALESCE(s.last_message_at, s.ended_at, s.started_at) > now() - ($${params.length} || ' days')::interval`);

      params.push(limit);

      const result = await pool.query(
        `SELECT s.session_id, s.agent_id, s.source, s.started_at, s.msg_count,
                ss.summary_text, ss.structured_summary
         FROM ${qi(schema)}.sessions s
         JOIN ${qi(schema)}.session_summaries ss ON ss.session_row_id = s.id
         WHERE ${where.join(' AND ')}
         ORDER BY COALESCE(s.last_message_at, s.ended_at, s.started_at) DESC
         LIMIT $${params.length}`,
        params
      );

      const sessions = result.rows.map(r => {
        const ss = r.structured_summary || {};
        const hasSS = ss.title || ss.overview;
        return {
          sessionId: r.session_id,
          agentId: r.agent_id,
          source: r.source,
          startedAt: r.started_at,
          title: ss.title || (hasSS ? null : (r.summary_text || '').slice(0, 60).trim() || null),
          overview: ss.overview || (hasSS ? null : (r.summary_text || '').slice(0, 200).trim() || null),
          topics: Array.isArray(ss.topics) ? ss.topics : [],
          decisions: Array.isArray(ss.decisions) ? ss.decisions : [],
          openLoops: Array.isArray(ss.open_loops) ? ss.open_loops : [],
          importantFacts: Array.isArray(ss.important_facts) ? ss.important_facts : [],
        };
      });

      // Cross-session open loops merge + dedup + sentinel filter
      const SENTINELS = new Set(['無', 'none', 'n/a', 'na', 'done', '']);
      const seenLoops = new Set();
      const openLoops = [];
      for (const s of sessions) {
        for (const loop of s.openLoops) {
          const raw = typeof loop === 'string' ? loop : (loop.item || '');
          const normalized = raw.trim().replace(/\s+/g, ' ').toLowerCase();
          if (SENTINELS.has(normalized) || !normalized || seenLoops.has(normalized)) continue;
          seenLoops.add(normalized);
          openLoops.push({ item: raw.trim(), fromSession: s.sessionId, latestStartedAt: s.startedAt });
        }
      }

      // Cross-session recent decisions dedup
      const seenDecisions = new Set();
      const recentDecisions = [];
      for (const s of sessions) {
        for (const d of s.decisions) {
          const key = typeof d === 'string' ? d : (d.decision || '');
          const normalized = key.trim().replace(/\s+/g, ' ').toLowerCase();
          if (!normalized || seenDecisions.has(normalized)) continue;
          seenDecisions.add(normalized);
          recentDecisions.push({ decision: key.trim(), reason: d.reason || null, fromSession: s.sessionId });
        }
      }

      const structured = {
        sessions,
        openLoops,
        recentDecisions,
        meta: { lookbackDays, count: sessions.length, maxChars, truncated: false },
      };

      if (format === 'text' || format === 'both') {
        const textResult = formatBootstrapText(structured, maxChars);
        structured.text = textResult.text;
        structured.meta.truncated = textResult.truncated;
      }

      return structured;
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
  });

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
