'use strict';

// ---------------------------------------------------------------------------
// defaultSummarizePrompt
// ---------------------------------------------------------------------------

function defaultSummarizePrompt(messages, opts = {}) {
  const conversation = messages
    .map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');

  let entitySection = '';
  if (opts.mergeEntities) {
    entitySection = `

Also extract named entities from this conversation. Output them after the summary in this exact format:

[ENTITIES]
name: <display name, original casing>
type: <person|project|concept|tool|metric|org|place|event|doc|task|topic|other>
aliases: <comma-separated alternative names, or empty>
---
(repeat for each entity)

Rules for entities:
- Only extract entities that are discussed substantively (not just mentioned in passing)
- Normalize aliases (e.g., "React.js" and "React" are aliases of the same entity)
- Choose the most specific type that fits
- Minimum 0, maximum 15 entities per session`;
  }

  return `Summarize the following conversation concisely. Focus on:
1. What was discussed (main topics)
2. What was decided or concluded
3. What actions were taken or planned
4. Any unresolved questions or open loops

Output a structured summary in this exact format (follow spacing and prefixes precisely):

TITLE: <one-line title>
OVERVIEW: <2-3 sentence overview>
TOPICS:
- <topic name>: <brief summary>
DECISIONS:
- <decision>: <reason>
OPEN_LOOPS:
- <unresolved item>
IMPORTANT_FACTS:
- <key fact>

Example:
TITLE: Database migration strategy discussion
OVERVIEW: Team discussed migrating from MySQL to PostgreSQL. Decided to use pgloader for data transfer. Timeline set for next sprint.
TOPICS:
- Migration tooling: Evaluated pgloader vs custom scripts, chose pgloader for reliability
- Schema changes: Need to convert ENUM types to CHECK constraints
DECISIONS:
- Use pgloader: Handles type conversion automatically, proven in production
OPEN_LOOPS:
- Need to benchmark query performance on new schema
IMPORTANT_FACTS:
- Current DB size is 45GB with 12M rows in largest table
${entitySection}

---
CONVERSATION:
${conversation}`;
}

// ---------------------------------------------------------------------------
// parseStructuredSummary — extract fields from LLM output
// ---------------------------------------------------------------------------

function _parseStructuredSummary(text) {
  if (!text) return null;

  const result = {
    title: '',
    overview: '',
    topics: [],
    decisions: [],
    open_loops: [],
    important_facts: [],
  };

  // Extract TITLE
  const titleMatch = text.match(/^TITLE:\s*(.+)/m);
  if (titleMatch) result.title = titleMatch[1].trim();

  // Extract OVERVIEW
  const overviewMatch = text.match(/^OVERVIEW:\s*([\s\S]*?)(?=\n(?:TOPICS|DECISIONS|OPEN_LOOPS|IMPORTANT_FACTS|\[ENTITIES\])|$)/m);
  if (overviewMatch) result.overview = overviewMatch[1].trim();

  // Extract TOPICS
  const topicsMatch = text.match(/^TOPICS:\s*\n([\s\S]*?)(?=\n(?:DECISIONS|OPEN_LOOPS|IMPORTANT_FACTS|\[ENTITIES\])|$)/m);
  if (topicsMatch) {
    const lines = topicsMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of lines) {
      const cleaned = line.replace(/^\s*-\s*/, '').trim();
      const colonIdx = cleaned.indexOf(':');
      if (colonIdx > 0) {
        result.topics.push({
          name: cleaned.slice(0, colonIdx).trim(),
          summary: cleaned.slice(colonIdx + 1).trim(),
        });
      } else {
        result.topics.push({ name: cleaned, summary: '' });
      }
    }
  }

  // Extract DECISIONS
  const decisionsMatch = text.match(/^DECISIONS:\s*\n([\s\S]*?)(?=\n(?:OPEN_LOOPS|IMPORTANT_FACTS|\[ENTITIES\])|$)/m);
  if (decisionsMatch) {
    const lines = decisionsMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of lines) {
      const cleaned = line.replace(/^\s*-\s*/, '').trim();
      const colonIdx = cleaned.indexOf(':');
      if (colonIdx > 0) {
        result.decisions.push({
          decision: cleaned.slice(0, colonIdx).trim(),
          reason: cleaned.slice(colonIdx + 1).trim(),
        });
      } else {
        result.decisions.push({ decision: cleaned, reason: '' });
      }
    }
  }

  // Extract OPEN_LOOPS
  const openLoopsMatch = text.match(/^OPEN_LOOPS:\s*\n([\s\S]*?)(?=\n(?:IMPORTANT_FACTS|\[ENTITIES\])|$)/m);
  if (openLoopsMatch) {
    const lines = openLoopsMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of lines) {
      result.open_loops.push({ item: line.replace(/^\s*-\s*/, '').trim() });
    }
  }

  // Extract IMPORTANT_FACTS
  const factsMatch = text.match(/^IMPORTANT_FACTS:\s*\n([\s\S]*?)(?=\n\[ENTITIES\]|$)/m);
  if (factsMatch) {
    const lines = factsMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of lines) {
      const fact = line.replace(/^\s*-\s*/, '').trim();
      if (fact) result.important_facts.push(fact);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// extractiveFallback
// ---------------------------------------------------------------------------

function extractiveFallback(messages) {
  const userMsgs = (messages || []).filter(m => m.role === 'user');
  const texts = userMsgs.map(m => {
    if (typeof m.content === 'string') return m.content.trim();
    if (Array.isArray(m.content)) {
      return m.content
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n')
        .trim();
    }
    return '';
  }).filter(Boolean);

  let selected;
  if (texts.length <= 6) {
    selected = texts;
  } else {
    const head = texts.slice(0, 3);
    const tail = texts.slice(-3);
    // Dedupe: if any tail item is already in head, skip it
    const headSet = new Set(head);
    selected = [...head, ...tail.filter(t => !headSet.has(t))];
  }

  const joined = selected.join('\n---\n').slice(0, 2000);

  return {
    summaryText: joined,
    structuredSummary: null,
    entityRaw: null,
    isExtractive: true,
  };
}

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

async function summarize(messages, {
  llmFn,
  promptFn,
  mergeEntities = false,
} = {}) {
  if (!llmFn) {
    return extractiveFallback(messages);
  }

  const buildPrompt = promptFn || defaultSummarizePrompt;

  try {
    const prompt = buildPrompt(messages, { mergeEntities });
    const response = await llmFn(prompt);
    if (typeof response !== 'string' || response.trim() === '') {
      return extractiveFallback(messages);
    }

    // Parse structured fields
    const structuredSummary = _parseStructuredSummary(response);

    // Extract entity section if present
    let entityRaw = null;
    if (mergeEntities) {
      const idx = response.indexOf('[ENTITIES]');
      if (idx !== -1) {
        entityRaw = response.slice(idx);
      }
    }

    // M6 fix: strip [ENTITIES] section from summaryText before storage
    let cleanSummary = response;
    if (mergeEntities) {
      const idx = response.indexOf('[ENTITIES]');
      if (idx !== -1) cleanSummary = response.slice(0, idx).trim();
    }

    return {
      summaryText: cleanSummary,
      structuredSummary,
      entityRaw,
      isExtractive: false,
    };
  } catch {
    // LLM failure: fall back to extractive
    return extractiveFallback(messages);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { defaultSummarizePrompt, summarize, extractiveFallback };
