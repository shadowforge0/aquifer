'use strict';

// Aquifer Memory — drop-in OpenClaw extension
//
// Host layout:
//   $OPENCLAW_HOME/extensions/aquifer-memory/  ← symlink to this directory
//   (or run `bash scripts/install-openclaw.sh $OPENCLAW_HOME` from the tarball)
//
// Behavior:
//   - Loads $OPENCLAW_HOME/.env so DATABASE_URL / EMBED_PROVIDER /
//     AQUIFER_LLM_PROVIDER etc. are visible to the plugin.
//   - Delegates to consumers/openclaw-plugin.js. If AQUIFER_PERSONA is set
//     (pluginConfig.persona or env), the plugin loads the persona module
//     and hands off mountOnOpenClaw(api); otherwise the default generic
//     path runs (before_reset capture + session_recall + session_feedback).
//
// Host-specific customization goes in a persona module, not here.

const fs = require('fs');
const path = require('path');
const os = require('os');

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');

function loadEnvFile(envPath) {
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch { /* .env missing — ok */ }
}

loadEnvFile(path.join(OPENCLAW_HOME, '.env'));

// Re-export the plugin as-is. OpenClaw expects { id, name, register }.
module.exports = require('../openclaw-plugin');
