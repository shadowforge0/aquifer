'use strict';

const REDACTION = '[REDACTED_SECRET]';

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\b(AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|DATABASE_URL)\s*=\s*[^\s]+/gi,
  /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(cookie|set-cookie)\s*:\s*[^\n]+/gi,
  /\bpostgres(?:ql)?:\/\/[^:\s/]+:[^@\s/]+@[^\s]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const SESSION_INJECTION_RE = [
  /^\s*\[AQUIFER CONTEXT\]/i,
  /<session-bootstrap\b/i,
  /<memory-bootstrap\b/i,
  /^# AGENTS\.md instructions/i,
  /<environment_context>/i,
  /<developer_context>/i,
];

const TOOL_OUTPUT_RE = [
  /^\s*(tool|command|shell|exec)_?output\s*:/i,
  /^\s*Exit code:\s*\d+/im,
  /^\s*Wall time:\s*[\d.]+/im,
  /^\s*Output:\s*$/im,
  /\bstdout\b[\s\S]*\bstderr\b/i,
];

const STACK_TRACE_RE = [
  /Traceback \(most recent call last\):/,
  /^\s+at .+\(.+:\d+:\d+\)$/m,
  /^\s+at .+:\d+:\d+$/m,
  /\bSQLSTATE\s+[A-Z0-9]{5}\b/i,
  /\bduplicate key value violates unique constraint\b/i,
  /\bsyntax error at or near\b/i,
];

const COMMENTARY_RE = [
  /^(I will|I'll|I'm going to|I’m going to|I will now)\b/i,
  /^(我先|我會|接下來我|現在我會|我現在)\b/,
];

function extractText(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter(part => part && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');
  }
  if (typeof message.text === 'string') return message.text;
  return '';
}

function replaceText(message, text) {
  const next = { ...message };
  if (typeof next.content === 'string') {
    next.content = text;
  } else if (Array.isArray(next.content)) {
    let replaced = false;
    next.content = next.content.map(part => {
      if (!part || part.type !== 'text' || typeof part.text !== 'string') return part;
      if (replaced) return { ...part, text: '' };
      replaced = true;
      return { ...part, text };
    });
    if (!replaced) next.content = text;
  } else if (typeof next.text === 'string') {
    next.text = text;
  } else {
    next.content = text;
  }
  return next;
}

function redactSecrets(text) {
  let redacted = String(text || '');
  for (const re of SECRET_PATTERNS) {
    redacted = redacted.replace(re, REDACTION);
  }
  return {
    text: redacted,
    redacted: redacted !== String(text || ''),
  };
}

function isEnvDump(text) {
  const lines = String(text || '').split(/\r?\n/);
  let envLines = 0;
  for (const line of lines) {
    if (/^[A-Z_][A-Z0-9_]{2,}=/.test(line.trim())) envLines++;
  }
  return envLines >= 3;
}

function hasAny(patterns, text) {
  return patterns.some(re => re.test(text));
}

function assessTextForEnrich(text, role) {
  const raw = String(text || '').trim();
  const tags = [];
  if (!raw) return { action: 'drop', reason: 'empty', tags: ['empty'], text: '' };

  if (hasAny(SESSION_INJECTION_RE, raw)) tags.push('session_injected_context');
  if (role === 'tool' || hasAny(TOOL_OUTPUT_RE, raw)) tags.push('tool_output');
  if (hasAny(STACK_TRACE_RE, raw)) tags.push('stack_trace');
  if (isEnvDump(raw)) tags.push('env_dump');
  if (role === 'assistant' && hasAny(COMMENTARY_RE, raw)) tags.push('commentary');

  const secretResult = redactSecrets(raw);
  if (secretResult.redacted) tags.push('secret_risk');

  const dropTags = new Set([
    'session_injected_context',
    'tool_output',
    'stack_trace',
    'env_dump',
    'commentary',
  ]);
  const dropReason = tags.find(tag => dropTags.has(tag));
  if (dropReason) {
    return { action: 'drop', reason: dropReason, tags, text: '' };
  }

  return {
    action: 'keep',
    reason: secretResult.redacted ? 'redacted' : 'clean',
    tags,
    text: secretResult.text,
    redacted: secretResult.redacted,
  };
}

function applyEnrichSafetyGate(messages = []) {
  const input = Array.isArray(messages) ? messages : [];
  const safe = [];
  const quarantined = [];
  const stats = {
    total: input.length,
    kept: 0,
    dropped: 0,
    redacted: 0,
  };

  for (let i = 0; i < input.length; i++) {
    const message = input[i];
    const role = message && message.role ? String(message.role) : 'unknown';
    const assessment = assessTextForEnrich(extractText(message), role);
    if (assessment.action === 'drop') {
      stats.dropped++;
      quarantined.push({ index: i, role, reason: assessment.reason, tags: assessment.tags });
      continue;
    }
    if (assessment.redacted) stats.redacted++;
    stats.kept++;
    safe.push(replaceText(message, assessment.text));
  }

  return {
    messages: safe,
    meta: {
      stats,
      quarantined,
      redacted: stats.redacted,
      dropped: stats.dropped,
    },
  };
}

function sanitizeStructuredValue(value, meta, role = 'assistant') {
  if (typeof value === 'string') {
    const assessment = assessTextForEnrich(value, role);
    if (assessment.action === 'drop') {
      meta.dropped++;
      return undefined;
    }
    if (assessment.redacted) meta.redacted++;
    return assessment.text;
  }
  if (Array.isArray(value)) {
    return value
      .map(item => sanitizeStructuredValue(item, meta, role))
      .filter(item => item !== undefined);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const sanitized = sanitizeStructuredValue(child, meta, role);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return value;
}

function sanitizeSummaryResult(summaryResult) {
  if (!summaryResult) return { summaryResult: null, meta: { redacted: 0, dropped: 0 } };
  const meta = { redacted: 0, dropped: 0 };
  const next = { ...summaryResult };
  if (typeof next.summaryText === 'string') {
    const assessment = assessTextForEnrich(next.summaryText, 'assistant');
    next.summaryText = assessment.action === 'drop' ? '' : assessment.text;
    if (assessment.action === 'drop') meta.dropped++;
    if (assessment.redacted) meta.redacted++;
  }
  if (next.structuredSummary) {
    next.structuredSummary = sanitizeStructuredValue(next.structuredSummary, meta, 'assistant');
  }
  return { summaryResult: next, meta };
}

module.exports = {
  REDACTION,
  redactSecrets,
  assessTextForEnrich,
  applyEnrichSafetyGate,
  sanitizeSummaryResult,
};
