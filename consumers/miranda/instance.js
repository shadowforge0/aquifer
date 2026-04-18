'use strict';

// Miranda Aquifer instance factory — produces a singleton bound to the
// miranda schema + entity scope + rerank config. Host supplies the pg.Pool
// and embed function (they're host-specific wiring: OpenClaw has its own
// pg + embed libs; CC uses the same).

const { createAquifer } = require('../../index');
const { callLlm } = require('./llm');

let _instance = null;

/**
 * @param {object} opts
 * @param {object} opts.pool — pg.Pool from the host
 * @param {function} opts.embedFn — async (texts: string[]) => number[][]
 * @param {function} [opts.llmFn] — defaults to Miranda's MiniMax wrapper
 * @param {string} [opts.rerankKey] — OpenRouter API key; falls back to
 *   process.env.OPENROUTER_API_KEY / AQUIFER_RERANK_API_KEY
 * @returns {object} Aquifer instance
 */
function getAquifer(opts = {}) {
    if (_instance) return _instance;
    if (!opts.pool) throw new Error('Miranda: pool is required');
    if (!opts.embedFn) throw new Error('Miranda: embedFn is required');

    const rerankKey = opts.rerankKey
        || process.env.OPENROUTER_API_KEY
        || process.env.AQUIFER_RERANK_API_KEY;

    _instance = createAquifer({
        schema: 'miranda',
        db: opts.pool,
        tenantId: 'default',
        embed: { fn: opts.embedFn },
        llm: { fn: opts.llmFn || callLlm },
        entities: { enabled: true, mergeCall: true, scope: 'miranda' },
        facts: { enabled: true },
        rerank: rerankKey ? {
            provider: 'openrouter',
            openrouterApiKey: rerankKey,
            model: 'cohere/rerank-v3.5',
            topK: 20,
            maxChars: 1600,
            timeout: 5000,
            maxRetries: 1,
        } : null,
    });

    return _instance;
}

function resetAquifer() { _instance = null; }

module.exports = { getAquifer, resetAquifer };
