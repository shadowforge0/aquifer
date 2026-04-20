'use strict';

// Extract temporal state-change facts from session content.
//
// Input: message array + entity context (name→id map) + LLM.
// Output: array of change objects ready to feed entity-state.applyChanges().
//
// Strict rules baked into the prompt:
//   - Only "已發生 / past-tense / 完成式" transitions — reject tentative
//     ("I might / I was thinking about / let's consider").
//   - Must have explicit time anchor ("on 2026-04-18", "as of today",
//     "this morning") — tag to session started_at if only "now".
//   - attribute must be stable snake_case path (version.stable,
//     editor.preference, runtime.node.version).
//   - value must be JSON-serialisable (strings, numbers, bools, nested OK).
//   - confidence ∈ [0,1]; default 0.7, any < threshold is dropped by caller.

const ATTRIBUTE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

function defaultStateChangePrompt(messages, ctx = {}) {
  const conversation = messages
    .map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');
  const entityList = ctx.entities && ctx.entities.length
    ? ctx.entities.map(e => `  - "${e.name}" (id=${e.id})`).join('\n')
    : '  (no entities resolved yet)';
  const sessionTime = ctx.sessionStartedAt || new Date().toISOString();

  return `You extract TEMPORAL STATE-CHANGE FACTS from a conversation.
A state change means "this specific attribute of this specific entity CHANGED its value at a specific moment."

## Strict rules

1. Only extract CHANGES — not first-observations, not opinions, not preferences merely mentioned.
2. Only PAST-TENSE / COMPLETED transitions. Reject tentative language:
   - REJECT: "I might try", "I was thinking about", "let's consider", "maybe", "probably", "planning to"
   - ACCEPT: "I upgraded", "switched to", "changed to", "升到", "改成", "換成", "現在用", "已經改"
3. Must have explicit TIME ANCHOR — exact date, "today", "this morning", "as of", "自 X 起"
   If only implicit "now", use ctx.sessionStartedAt as valid_from.
4. attribute MUST be a STABLE snake_case path (lowercase, dots as separators):
   - GOOD: version.stable, editor.preference, runtime.node.version, indexing.pgvector.strategy
   - BAD: "Version Stable", "My Editor", "editor-pref"
5. Each change MUST match an entity in the list below by entity_name (exact match preferred, alias OK).
   If no matching entity exists, DROP the change silently.
6. value must be JSON-serialisable. Wrap scalars plain (e.g. "1.3.0"), objects as {key: v}.

## Output

Emit ONE JSON object, no prose, no code fence, no commentary:

{
  "state_changes": [
    {
      "entity_name": "<must match list>",
      "attribute": "<snake_case.dotted.path>",
      "value": <any JSON>,
      "valid_from": "<ISO8601 timestamp>",
      "time_anchor_text": "<the phrase that anchors the time>",
      "evidence_text": "<the sentence that states the change, <= 240 chars>",
      "confidence": <0..1>
    }
  ]
}

If no changes, output: {"state_changes": []}

## Entities in scope

${entityList}

## Session started at: ${sessionTime}

## Conversation

${conversation}
`;
}

// Attempt to recover a JSON object from LLM output — some models wrap in
// code fences, some prepend "Here is the JSON:" etc. Tolerant but strict
// about the resulting shape.
function extractJsonBlock(text) {
  if (!text || typeof text !== 'string') return null;
  // Strip triple-backtick fences if present.
  let s = text.trim();
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) s = fenceMatch[1].trim();
  // Take the substring from the first { to the last }.
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last < first) return null;
  const candidate = s.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

// Normalize one raw LLM-emitted change. Returns { entityName, ... } with the
// human-facing name intact — resolution to entity_id happens in the caller
// (enrich) after entity upsert, so state extraction itself doesn't need
// a populated id lookup.
function normalizeChange(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.entity_name === 'string' ? raw.entity_name.trim() : null;
  if (!name) return null;

  // If a scope whitelist is passed, reject names not on it (case-insensitive).
  if (ctx.scopeNames && !ctx.scopeNames.has(name.toLowerCase())) return null;

  const attribute = typeof raw.attribute === 'string' ? raw.attribute.trim() : '';
  if (!ATTRIBUTE_RE.test(attribute)) return null;

  if (raw.value === undefined) return null;  // explicit null is OK

  const validFromDate = new Date(raw.valid_from || raw.validFrom || ctx.sessionStartedAt);
  if (!Number.isFinite(validFromDate.getTime())) return null;

  let confidence = raw.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) confidence = 0.7;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  const evidenceText = typeof raw.evidence_text === 'string' ? raw.evidence_text.slice(0, 240) : '';

  return {
    entityName: name,
    attribute,
    value: raw.value,
    validFrom: validFromDate.toISOString(),
    evidenceText,
    confidence,
    source: 'llm',
    evidenceSessionId: ctx.evidenceSessionId || null,
    sessionRowId: ctx.sessionRowId ?? null,
  };
}

async function extractStateChanges(messages, {
  llmFn,
  promptFn,
  entities = [],            // [{id, name, aliases?: []}]
  sessionStartedAt,
  evidenceSessionId,
  sessionRowId,
  confidenceThreshold = 0.7,
  timeoutMs = 10000,
  maxOutputTokens = 600,
  logger,
} = {}) {
  if (!llmFn) return { changes: [], warnings: ['no_llm'] };
  if (!entities.length) return { changes: [], warnings: ['no_entities_in_scope'] };

  // Build case-insensitive name whitelist (entity name + aliases).
  const scopeNames = new Set();
  for (const e of entities) {
    if (!e || !e.name) continue;
    scopeNames.add(String(e.name).toLowerCase());
    for (const a of (e.aliases || [])) {
      if (typeof a === 'string') scopeNames.add(a.toLowerCase());
    }
  }

  const buildPrompt = promptFn || defaultStateChangePrompt;
  const prompt = buildPrompt(messages, { entities, sessionStartedAt });

  const warnings = [];
  let rawResponse;
  try {
    // Simple timeout wrapper — llmFn signature in this repo is (prompt) => string.
    rawResponse = await Promise.race([
      llmFn(prompt, { maxTokens: maxOutputTokens }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('llm_timeout')), timeoutMs)),
    ]);
  } catch (e) {
    if (logger && logger.warn) logger.warn(`[extract-state-changes] llm call failed: ${e.message}`);
    return { changes: [], warnings: [`llm_error: ${e.message}`] };
  }

  const parsed = extractJsonBlock(rawResponse);
  if (!parsed || !Array.isArray(parsed.state_changes)) {
    if (logger && logger.warn) logger.warn(`[extract-state-changes] malformed output, dropping batch`);
    return { changes: [], warnings: ['malformed_json'] };
  }

  const ctx = { scopeNames, sessionStartedAt, evidenceSessionId, sessionRowId };
  const changes = [];
  let dropped = 0;
  for (const raw of parsed.state_changes) {
    const n = normalizeChange(raw, ctx);
    if (!n) { dropped++; continue; }
    if (n.confidence < confidenceThreshold) { dropped++; continue; }
    changes.push(n);
  }
  if (dropped > 0) warnings.push(`dropped_${dropped}_invalid_or_low_confidence`);
  return { changes, warnings };
}

module.exports = {
  defaultStateChangePrompt,
  extractJsonBlock,
  normalizeChange,
  extractStateChanges,
};
