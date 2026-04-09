'use strict';

const { parseEntityOutput } = require('../core/entity');

// ---------------------------------------------------------------------------
// defaultEntityPrompt
// ---------------------------------------------------------------------------

function defaultEntityPrompt(messages, opts = {}) {
  const conversation = messages
    .map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');

  return `Extract named entities from the following conversation.

Output in this exact format (one entity per block, separated by ---):

[ENTITIES]
name: <display name, original casing>
type: <person|project|concept|tool|metric|org|place|event|doc|task|topic|other>
aliases: <comma-separated alternative names, or empty>
---

Rules:
- Only extract entities discussed substantively (not just mentioned in passing)
- Normalize aliases (e.g., "React.js" and "React" are aliases)
- Choose the most specific type
- Minimum 0, maximum 15 entities
- If no entities found, output only: [ENTITIES]\n(none)

Example:
[ENTITIES]
name: PostgreSQL
type: tool
aliases: Postgres, PG
---
name: Alice Chen
type: person
aliases: Alice
---

---
CONVERSATION:
${conversation}`;
}

// ---------------------------------------------------------------------------
// extractEntities
// ---------------------------------------------------------------------------

async function extractEntities(messages, {
  llmFn,
  promptFn,
} = {}) {
  if (!llmFn) return [];

  const buildPrompt = promptFn || defaultEntityPrompt;

  try {
    const prompt = buildPrompt(messages, {});
    const response = await llmFn(prompt);
    return parseEntityOutput(response);
  } catch (err) {
    // LLM failure: return empty, never throw
    return [];
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { defaultEntityPrompt, extractEntities, parseEntityOutput };
