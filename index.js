'use strict';

const { createAquifer } = require('./core/aquifer');
const { createEmbedder } = require('./pipeline/embed');
const { createReranker } = require('./pipeline/rerank');
const { normalizeSession, detectClient } = require('./pipeline/normalize');

module.exports = { createAquifer, createEmbedder, createReranker, normalizeSession, detectClient };
