'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Default host home. Callers can override via opts.envPath / opts.configDir.
const DEFAULT_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');

function loadEnvFile(envPath) {
    if (!envPath) envPath = path.join(DEFAULT_HOME, '.env');
    try {
        const text = fs.readFileSync(envPath, 'utf8');
        for (const line of text.split('\n')) {
            const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
            if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
        }
    } catch { /* no .env */ }
}

function loadConfig(pluginConfig = {}, opts = {}) {
    const home = opts.home || DEFAULT_HOME;
    loadEnvFile(opts.envPath || path.join(home, '.env'));

    let defaults = {};
    const configPath = opts.configPath || path.join(home, 'extensions/afterburn/config.default.json');
    try {
        let raw = fs.readFileSync(configPath, 'utf8');
        raw = raw.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] || '');
        defaults = JSON.parse(raw);
    } catch { /* use empty */ }

    return { ...defaults['afterburn'], ...pluginConfig };
}

// Model defaults per runtime — Miranda's choices on MiniMax
const RUNTIME_DEFAULTS = {
    gateway: 'MiniMax-M2.7',
    cc: 'MiniMax-M2.5',
    opencode: 'MiniMax-M2.5',
};

const RUNTIME_ENV_KEY = {
    cc: 'CC_AFTERBURN_MODEL',
    opencode: 'OPENCODE_AFTERBURN_MODEL',
};

function resolveModel({ runtime, explicitModel, configModel } = {}) {
    if (explicitModel) return explicitModel;
    const envKey = RUNTIME_ENV_KEY[runtime] || 'AFTERBURN_LLM_MODEL';
    if (process.env[envKey]) return process.env[envKey];
    if (configModel) return configModel;
    return RUNTIME_DEFAULTS[runtime] || RUNTIME_DEFAULTS.gateway;
}

async function callLlm(prompt, { runtime, model, timeoutMs } = {}) {
    const resolvedModel = model || resolveModel({ runtime });
    const timeout = timeoutMs || 120000;
    const apiKey = process.env.MINIMAX_API_KEY || process.env.OPENCODE_API_KEY || '';
    if (!apiKey) throw new Error('MINIMAX_API_KEY not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch('https://api.minimax.io/anthropic/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: resolvedModel,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 4096,
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`LLM ${res.status}: ${body.slice(0, 200)}`);
        }

        const data = await res.json();
        let raw;
        if (data.content && Array.isArray(data.content)) {
            raw = data.content.map(c => c.text || '').join('');
        } else {
            raw = data.choices?.[0]?.message?.content || '';
        }
        // Strip <think>...</think> reasoning tags (MiniMax M2.5)
        return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { loadEnvFile, loadConfig, resolveModel, callLlm };
