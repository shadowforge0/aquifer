'use strict';

const PUBLIC_PLACEHOLDER_SUMMARY_PATTERN = '(空測試會話|測試會話無實質內容|x 字元填充|placeholder)';
const PUBLIC_PLACEHOLDER_SUMMARY_RE = new RegExp(PUBLIC_PLACEHOLDER_SUMMARY_PATTERN, 'i');

function publicPlaceholderSummarySql(alias = 'ss') {
  return `(
    COALESCE(${alias}.summary_text, '') ~* '${PUBLIC_PLACEHOLDER_SUMMARY_PATTERN}'
    OR COALESCE(${alias}.structured_summary::text, '') ~* '${PUBLIC_PLACEHOLDER_SUMMARY_PATTERN}'
  )`;
}

function isPublicPlaceholderSessionMaterial(row = {}) {
  const summaryText = String(row.summary_text || row.summaryText || '').trim();
  if (summaryText && PUBLIC_PLACEHOLDER_SUMMARY_RE.test(summaryText)) return true;

  const structuredSummary = row.structured_summary ?? row.structuredSummary ?? null;
  if (structuredSummary === null || structuredSummary === undefined) return false;

  if (typeof structuredSummary === 'string') {
    return PUBLIC_PLACEHOLDER_SUMMARY_RE.test(structuredSummary);
  }

  try {
    return PUBLIC_PLACEHOLDER_SUMMARY_RE.test(JSON.stringify(structuredSummary));
  } catch {
    return false;
  }
}

function filterPublicPlaceholderSessionRows(rows = []) {
  return rows.filter(row => !isPublicPlaceholderSessionMaterial(row));
}

module.exports = {
  PUBLIC_PLACEHOLDER_SUMMARY_PATTERN,
  filterPublicPlaceholderSessionRows,
  isPublicPlaceholderSessionMaterial,
  publicPlaceholderSummarySql,
};
