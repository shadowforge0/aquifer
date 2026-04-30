'use strict';

const { createEmbedder } = require('../pipeline/embed');

function buildRerankDocument(row, maxChars) {
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

  if (mode === 'fts') {
    if (len > autoTrigger.ftsMinResults) return { apply: true, reason: 'fts_wide_shortlist' };
    return { apply: false, reason: 'fts_shortlist_too_narrow' };
  }

  if (!autoTrigger.modes.includes(mode)) {
    return { apply: false, reason: 'mode_not_in_autotrigger_modes' };
  }

  if (len >= 2) {
    const s0 = ranked[0]?._score ?? 0;
    const s1 = ranked[1]?._score ?? 0;
    if (s0 - s1 <= autoTrigger.maxTopScoreGap) {
      return { apply: true, reason: 'top_score_gap_close' };
    }
  }

  return { apply: false, reason: 'top_score_gap_wide' };
}

module.exports = {
  buildRerankDocument,
  resolveEmbedFn,
  shouldAutoRerank,
};
