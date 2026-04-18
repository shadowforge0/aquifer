'use strict';

// ---------------------------------------------------------------------------
// Consolidation pipeline
//
// Mechanics only — Aquifer ships the 8-action apply + schema. The prompt and
// output parser stay in consumers (they're persona-specific: different agents
// want different wording, language, and action vocabulary extensions).
//
// Typical flow in a consumer:
//
//   const output = await llmFn(consumerBuildPrompt({...}));
//   const { actions } = consumerParse(output);
//   await aquifer.consolidate(sessionId, { actions, agentId });
//
// aquifer.consolidate() is defined in core/aquifer.js and delegates here.
// ---------------------------------------------------------------------------

const { applyConsolidation } = require('./apply');

module.exports = { applyConsolidation };
