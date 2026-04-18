'use strict';

// Aquifer v1.2.0: LLM provider autodetect from env for install-and-go.
//
// Precedence:
//   1. config.llm.fn (explicit function — host supplies)
//   2. AQUIFER_LLM_PROVIDER env + provider-specific api key + optional model
//
// We do NOT silently pick a provider from multiple keys (ambiguous). Hosts
// must opt in by setting AQUIFER_LLM_PROVIDER explicitly when they want env
// autowiring.
//
// Two response shapes in flight:
//   - Anthropic-shape: { content: [{ type:'text', text:'...' }] }
//     Used by: minimax, opencode
//   - OpenAI-shape:    { choices:[{ message:{ content:'...' } }] }
//     Used by: openai, openrouter

const { createLlmFn } = require('./llm');

const ANTHROPIC_PROVIDERS = {
  minimax: {
    envKey: 'MINIMAX_API_KEY',
    baseUrl: 'https://api.minimax.io/anthropic/v1/messages',
    defaultModel: 'MiniMax-M2.7',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
  },
  opencode: {
    envKey: 'OPENCODE_API_KEY',
    baseUrl: 'https://opencode.ai/zen/go/v1/messages',
    defaultModel: 'minimax-m2.5',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
  },
};

const OPENAI_PROVIDERS = {
  openai: {
    envKey: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  openrouter: {
    envKey: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
  },
};

function createAnthropicShapeFn({ baseUrl, apiKey, model, extraHeaders, timeoutMs, maxTokens }) {
  const timeout = timeoutMs || 120000;
  const mt = maxTokens || 4096;
  return async function llmFn(prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...(extraHeaders || {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: mt,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`LLM ${res.status}: ${body.slice(0, 200).replace(/[\n\r]/g, ' ')}`);
        err.statusCode = res.status;
        throw err;
      }
      const data = await res.json();
      let raw = '';
      if (data.content && Array.isArray(data.content)) {
        raw = data.content.map((c) => c.text || '').join('');
      } else if (data.choices && Array.isArray(data.choices)) {
        raw = data.choices[0]?.message?.content || '';
      }
      return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } finally {
      clearTimeout(timer);
    }
  };
}

function resolveLlmFn(llmConfig, env) {
  if (llmConfig && typeof llmConfig.fn === 'function') {
    return llmConfig.fn;
  }
  const provider = env.AQUIFER_LLM_PROVIDER;
  if (!provider) return null;

  const model = env.AQUIFER_LLM_MODEL || null;
  const timeoutMs = env.AQUIFER_LLM_TIMEOUT ? Number(env.AQUIFER_LLM_TIMEOUT) : undefined;

  if (ANTHROPIC_PROVIDERS[provider]) {
    const p = ANTHROPIC_PROVIDERS[provider];
    const apiKey = env[p.envKey];
    if (!apiKey) {
      throw new Error(`AQUIFER_LLM_PROVIDER=${provider} requires ${p.envKey}`);
    }
    return createAnthropicShapeFn({
      baseUrl: p.baseUrl,
      apiKey,
      model: model || p.defaultModel,
      extraHeaders: p.extraHeaders,
      timeoutMs,
    });
  }

  if (OPENAI_PROVIDERS[provider]) {
    const p = OPENAI_PROVIDERS[provider];
    const apiKey = env[p.envKey];
    if (!apiKey) {
      throw new Error(`AQUIFER_LLM_PROVIDER=${provider} requires ${p.envKey}`);
    }
    return createLlmFn({
      baseUrl: p.baseUrl,
      model: model || p.defaultModel,
      apiKey,
      timeoutMs,
    });
  }

  throw new Error(
    `AQUIFER_LLM_PROVIDER=${provider} not supported. Valid: ${[
      ...Object.keys(ANTHROPIC_PROVIDERS),
      ...Object.keys(OPENAI_PROVIDERS),
    ].join(', ')}`
  );
}

module.exports = { resolveLlmFn };
