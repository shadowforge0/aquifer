'use strict';

const { createAquifer } = require('./core/aquifer');
const { createEmbedder } = require('./pipeline/embed');
const { createReranker } = require('./pipeline/rerank');
const { normalizeEntityName } = require('./core/entity');
const { parseEntitySection } = require('./consumers/shared/entity-parser');
const { AqError, ok, err, asResult, isKnownCode, KNOWN_CODES } = require('./core/errors');
const { MCP_SERVER_NAME, MCP_TOOL_MANIFEST, getManifest, writeManifestFile } = require('./core/mcp-manifest');

module.exports = {
  createAquifer,
  createEmbedder,
  createReranker,
  normalizeEntityName,
  parseEntitySection,
  // Completion-capability error envelope (P1 foundation).
  AqError,
  ok,
  err,
  asResult,
  isKnownCode,
  KNOWN_CODES,
  // MCP tool manifest — canonical for gateway in-process + CC cross-process.
  MCP_SERVER_NAME,
  MCP_TOOL_MANIFEST,
  getMcpManifest: getManifest,
  writeMcpManifestFile: writeManifestFile,
};
