'use strict';

// MCP tool manifest — single source of truth for Aquifer's MCP surface.
//
// Spec: aquifer-completion §G1 (bi-directional registration). Gateway hosts
// `require('@shadowforge0/aquifer-memory').MCP_TOOL_MANIFEST` in-process;
// cross-process hosts (CC MCP server) consume the JSON file written by
// `writeManifestFile()` / the `aquifer mcp-contract` CLI. Both paths read
// from this module, so the two surfaces can never drift.
//
// Tool definitions are expressed as JSON Schema (standard, language-agnostic,
// serialisable). consumers/mcp.js builds Zod schemas from these descriptors
// at server start-up.

const fs = require('fs');
const path = require('path');

const MCP_SERVER_NAME = 'aquifer-memory';

const MCP_TOOL_MANIFEST = Object.freeze([
  {
    name: 'session_recall',
    description: 'Search stored sessions by keyword. Supports entity intersection for precise multi-entity queries.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, description: 'Search query (keyword or natural language)' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results (default 5)' },
        agentId: { type: 'string', description: 'Filter by agent ID' },
        source: { type: 'string', description: 'Filter by source (e.g., gateway, cc)' },
        dateFrom: { type: 'string', description: 'Start date YYYY-MM-DD' },
        dateTo: { type: 'string', description: 'End date YYYY-MM-DD' },
        entities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Entity names to match',
        },
        entityMode: {
          type: 'string',
          enum: ['any', 'all'],
          description: '"any" (default, boost) or "all" (only sessions with every entity)',
        },
        mode: {
          type: 'string',
          enum: ['fts', 'hybrid', 'vector'],
          description: 'Recall mode: "fts" (keyword only, no embed needed), "hybrid" (default, FTS + vector), "vector" (vector only)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'session_feedback',
    description: 'Record trust feedback on a recalled session. Helpful sessions rank higher in future recalls.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', minLength: 1, description: 'Session ID to give feedback on' },
        verdict: { type: 'string', enum: ['helpful', 'unhelpful'], description: 'Was the recalled session useful?' },
        note: { type: 'string', description: 'Optional reason' },
        agentId: { type: 'string', description: 'Agent ID the session was stored under (e.g. "main"). Defaults to "agent" if omitted.' },
      },
      required: ['sessionId', 'verdict'],
    },
  },
  {
    name: 'memory_stats',
    description: 'Return storage statistics for the Aquifer memory store (session counts by status, summaries, turn embeddings, entities, date range).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'memory_pending',
    description: 'List sessions with pending or failed processing status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'session_bootstrap',
    description: 'Load recent session context for a new conversation. Returns summaries, open items, and decisions from recent sessions. Call this at the start of a conversation for continuity; use session_recall for keyword search.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agentId: { type: 'string', description: 'Filter by agent ID' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max sessions (default 5)' },
        lookbackDays: { type: 'integer', minimum: 1, maximum: 90, description: 'How far back in days (default 14)' },
        maxChars: { type: 'integer', minimum: 500, maximum: 12000, description: 'Max output characters (default 4000)' },
      },
    },
  },
]);

function getManifest() {
  return {
    manifestVersion: 1,
    serverName: MCP_SERVER_NAME,
    generatedAt: new Date().toISOString(),
    tools: MCP_TOOL_MANIFEST.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: JSON.parse(JSON.stringify(t.inputSchema)),
    })),
  };
}

function writeManifestFile(outPath) {
  if (!outPath) throw new Error('outPath is required');
  const resolved = path.resolve(outPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(getManifest(), null, 2) + '\n', 'utf8');
  return resolved;
}

module.exports = {
  MCP_SERVER_NAME,
  MCP_TOOL_MANIFEST,
  getManifest,
  writeManifestFile,
};
