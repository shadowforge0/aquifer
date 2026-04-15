'use strict';

// Commands that produce no conversational value — skip entirely
const SKIP_COMMANDS = new Set(['/clear', '/compact', '/help', '/status', '/config']);

// Commands that mark session boundaries — keep as boundary markers
const RESET_COMMANDS = new Set(['/new', '/reset']);

const MAX_MSG_CHARS = 8000;
const MAX_NARRATION_CHARS = 200;

module.exports = { SKIP_COMMANDS, RESET_COMMANDS, MAX_MSG_CHARS, MAX_NARRATION_CHARS };
