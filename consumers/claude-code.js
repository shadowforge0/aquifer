'use strict';

// ---------------------------------------------------------------------------
// Claude Code host adapter.
//
// Generic entry points for CC-side afterburn hooks. No persona logic — callers
// construct any persona-specific hooks outside this package and inject them via
// `postProcess`, `summaryFn`, `entityParseFn`, or `contextInjector`.
//
// API:
//   runEnrich({ aquifer, sessionId, agentId, ... })
//       Enrich an already-committed session. Used by cc-afterburn after
//       cc-session-to-pg has written the session row.
//
//   runBackfill({ aquifer, sessionIds, ... })
//       Iterate enrich() over pending sessions (for catch-up after a gap).
//
//   runContextInject({ contextInjector, ... })
//       Return a host-specific system context string for a CC session start
//       hook. The injector is supplied by the deployment, not by Aquifer core.
// ---------------------------------------------------------------------------

/**
 * Enrich one committed session. Caller supplies the summaryFn / entityParseFn /
 * postProcess they want (persona-specific hooks).
 *
 * @param {object} opts
 * @param {object} opts.aquifer
 * @param {string} opts.sessionId
 * @param {string} opts.agentId
 * @param {function} [opts.summaryFn]
 * @param {function} [opts.entityParseFn]
 * @param {function} [opts.postProcess]
 * @param {object}  [opts.logger]
 * @returns {Promise<object>} The enrich result.
 */
async function runEnrich({
    aquifer, sessionId, agentId,
    summaryFn = null, entityParseFn = null, postProcess = null,
    logger = console,
} = {}) {
    if (!aquifer) throw new Error('runEnrich: aquifer is required');
    if (!sessionId) throw new Error('runEnrich: sessionId is required');
    if (!agentId) throw new Error('runEnrich: agentId is required');

    const result = await aquifer.enrich(sessionId, {
        agentId,
        summaryFn: summaryFn || undefined,
        entityParseFn: entityParseFn || undefined,
        postProcess: postProcess || undefined,
    });

    if (result.postProcessError && logger.warn) {
        logger.warn(`[cc-adapter] postProcess error for ${sessionId}: ${result.postProcessError.message}`);
    }
    if (logger.info) {
        logger.info(`[cc-adapter] enriched ${sessionId} (turns=${result.turnsEmbedded}, entities=${result.entitiesFound})`);
    }
    return result;
}

/**
 * Enrich a batch of sessions sequentially. Errors on one session don't stop
 * the batch; they're captured and returned alongside successes.
 *
 * @param {object} opts
 * @param {object} opts.aquifer
 * @param {string[]} opts.sessionIds
 * @param {function} opts.buildHooks — (sessionId) => { summaryFn?, entityParseFn?, postProcess? }
 *        Called per session; lets the caller rebuild persona hooks with the
 *        right sessionId / agentId / now.
 * @param {string} [opts.agentId='main']
 * @param {object} [opts.logger]
 * @returns {Promise<{ succeeded: object[], failed: object[] }>}
 */
async function runBackfill({
    aquifer, sessionIds, buildHooks,
    agentId = 'main', logger = console,
} = {}) {
    if (!aquifer) throw new Error('runBackfill: aquifer is required');
    if (!Array.isArray(sessionIds)) throw new Error('runBackfill: sessionIds must be an array');
    if (typeof buildHooks !== 'function') throw new Error('runBackfill: buildHooks must be a function');

    const succeeded = [];
    const failed = [];

    for (const sessionId of sessionIds) {
        try {
            const hooks = await buildHooks(sessionId, agentId);
            const result = await runEnrich({
                aquifer, sessionId, agentId,
                summaryFn: hooks?.summaryFn,
                entityParseFn: hooks?.entityParseFn,
                postProcess: hooks?.postProcess,
                logger,
            });
            succeeded.push({ sessionId, result });
        } catch (err) {
            if (logger.warn) logger.warn(`[cc-adapter] backfill failed for ${sessionId}: ${err.message}`);
            failed.push({ sessionId, error: err.message });
        }
    }

    return { succeeded, failed };
}

/**
 * Build a host-specific system context for a CC SessionStart hook.
 * The caller supplies the context injector so this public adapter stays generic.
 */
async function runContextInject(opts = {}) {
    const injector = opts.contextInjector || opts.computeInjection;
    if (typeof injector !== 'function') throw new Error('runContextInject: contextInjector is required');
    return injector(opts);
}

module.exports = { runEnrich, runBackfill, runContextInject };
