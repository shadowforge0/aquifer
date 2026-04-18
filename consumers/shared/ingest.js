'use strict';

// ---------------------------------------------------------------------------
// Shared ingest flow — the standard "received session → Aquifer" pipeline.
//
// All three host adapters (OpenClaw before_reset, Claude Code afterburn,
// OpenCode backfill) do the same three things:
//   1. Normalize raw entries to commit-ready shape
//   2. commit() the messages + metadata
//   3. enrich() if enough user turns, else skip()
// With dedup on (agentId, sessionId) so the same hook firing twice is safe.
//
// runIngest() centralizes this. Host adapters pass in their raw entries, the
// adapter name, and an optional postProcess callback for persona side effects.
// ---------------------------------------------------------------------------

const { normalizeMessages } = require('./normalize');

const RECENT_CAP = 200;
const RECENT_TTL_MS = 30 * 60 * 1000;

function evictStale(dedupMap, now = Date.now()) {
    if (!dedupMap || dedupMap.size <= RECENT_CAP) return;
    const cutoff = now - RECENT_TTL_MS;
    for (const [k, ts] of dedupMap) {
        if (ts < cutoff) dedupMap.delete(k);
    }
}

/**
 * Run the standard commit-then-enrich flow for a single session.
 *
 * @param {object} opts
 * @param {object} opts.aquifer — Aquifer instance
 * @param {string} opts.sessionId
 * @param {string} opts.agentId
 * @param {string} [opts.source] — caller-provided source tag (e.g. 'openclaw', 'cc', 'opencode')
 * @param {string} [opts.sessionKey] — passed through to commit()
 * @param {any[]} opts.rawEntries — host-native session entries
 * @param {'gateway'|'cc'|'claude-code'|'preNormalized'} [opts.adapter]
 *        'preNormalized' means rawEntries already matches normalizeMessages output
 *        (used by OpenCode which reads SQLite directly).
 * @param {object} [opts.preNormalized] — { messages, userCount, ... } ready to commit,
 *        required when adapter === 'preNormalized'
 * @param {number} [opts.minUserMessages=3] — enrich threshold
 * @param {Map} [opts.dedupMap] — Map<key, timestamp>; same session won't process twice within TTL
 * @param {Set} [opts.inFlight] — Set<key>; concurrent firings are guarded
 * @param {function} [opts.postProcess] — forwarded to enrich()
 * @param {function} [opts.summaryFn] — forwarded to enrich()
 * @param {function} [opts.entityParseFn] — forwarded to enrich()
 * @param {object} [opts.logger] — { info, warn }
 * @returns {Promise<{status:string, normalized:any[]|null, counts:object|null, enrichResult:object|null, skipReason?:string}>}
 */
async function runIngest(opts = {}) {
    const {
        aquifer, sessionId, agentId, source, sessionKey,
        rawEntries, adapter, preNormalized,
        minUserMessages = 3,
        dedupMap = null, inFlight = null,
        postProcess = null, summaryFn = null, entityParseFn = null,
        logger = console,
    } = opts;

    if (!aquifer) throw new Error('aquifer is required');
    if (!sessionId) throw new Error('sessionId is required');
    if (!agentId) throw new Error('agentId is required');

    const dedupKey = `${agentId}:${sessionId}`;
    if (dedupMap && dedupMap.has(dedupKey)) {
        return { status: 'dedup', normalized: null, counts: null, enrichResult: null, skipReason: 'recent' };
    }
    if (inFlight && inFlight.has(dedupKey)) {
        return { status: 'dedup', normalized: null, counts: null, enrichResult: null, skipReason: 'in_flight' };
    }
    if (inFlight) inFlight.add(dedupKey);

    try {
        // 1. Normalize
        let norm;
        if (adapter === 'preNormalized') {
            if (!preNormalized) throw new Error('preNormalized adapter requires opts.preNormalized');
            norm = preNormalized;
        } else {
            norm = normalizeMessages(rawEntries, { adapter });
        }

        if (norm.userCount === 0) {
            return { status: 'skipped_empty', normalized: norm.messages, counts: norm, enrichResult: null, skipReason: 'no_user_messages' };
        }

        // 2. Commit
        await aquifer.commit(sessionId, norm.messages, {
            agentId,
            source: source || adapter || 'api',
            sessionKey: sessionKey || null,
            model: norm.model,
            tokensIn: norm.tokensIn,
            tokensOut: norm.tokensOut,
            startedAt: norm.startedAt,
            lastMessageAt: norm.lastMessageAt,
        });
        if (logger && logger.info) logger.info(`[aquifer-ingest] committed ${sessionId} (${norm.messages.length} msgs, user=${norm.userCount})`);

        // 3. Enrich or skip
        let enrichResult = null;
        if (norm.userCount >= minUserMessages) {
            try {
                enrichResult = await aquifer.enrich(sessionId, {
                    agentId,
                    summaryFn: summaryFn || undefined,
                    entityParseFn: entityParseFn || undefined,
                    postProcess: postProcess || undefined,
                });
                if (logger && logger.info) {
                    logger.info(`[aquifer-ingest] enriched ${sessionId} (turns=${enrichResult.turnsEmbedded}, entities=${enrichResult.entitiesFound})`);
                }
            } catch (enrichErr) {
                if (logger && logger.warn) logger.warn(`[aquifer-ingest] enrich failed for ${sessionId}: ${enrichErr.message}`);
                // Commit already succeeded — don't rethrow
            }
        } else {
            try {
                await aquifer.skip(sessionId, { agentId, reason: `user_count=${norm.userCount} < min=${minUserMessages}` });
            } catch (skipErr) {
                if (logger && logger.warn) logger.warn(`[aquifer-ingest] skip failed for ${sessionId}: ${skipErr.message}`);
            }
            return { status: 'skipped_short', normalized: norm.messages, counts: norm, enrichResult: null, skipReason: `user_count=${norm.userCount}` };
        }

        if (dedupMap) {
            dedupMap.set(dedupKey, Date.now());
            evictStale(dedupMap);
        }

        return { status: 'ok', normalized: norm.messages, counts: norm, enrichResult };
    } finally {
        if (inFlight) inFlight.delete(dedupKey);
    }
}

module.exports = { runIngest };
