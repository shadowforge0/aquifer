'use strict';

// Miranda zh-TW recall formatter — overrides the shared default renderers
// to produce narrative-style output instead of score-flavored markdown.

const { createRecallFormatter, truncate, formatDateIso } = require('../shared/recall-format');

function formatTopicLines(topics) {
    if (!Array.isArray(topics) || topics.length === 0) return '- 無';
    return topics.map((topic) => {
        const name = topic?.name || '未命名主題';
        const summary = topic?.summary ? `：${topic.summary}` : '';
        return `- ${name}${summary}`;
    }).join('\n');
}

function formatDecisions(decisions) {
    if (!Array.isArray(decisions) || decisions.length === 0) return null;
    return decisions.map(d => {
        const decision = d?.decision || '';
        const reason = d?.reason ? `（${d.reason}）` : '';
        return `- ${decision}${reason}`;
    }).join('\n');
}

function coalesceTitle(structuredSummary, summaryText) {
    if (structuredSummary && structuredSummary.title) return structuredSummary.title;
    if (summaryText) return truncate(summaryText, 60);
    return '(無標題)';
}

const mirandaRenderers = {
    empty: () => '找不到符合條件的 session。',
    header: () => null,
    title: (r, i) => {
        const ss = r.structuredSummary || {};
        const title = coalesceTitle(ss, r.summaryText);
        const date = formatDateIso(r.startedAt);
        const agent = r.agentId || r.agent_id || 'main';
        return `### ${i + 1}. ${title}\n**Agent**: ${agent} | **Date**: ${date}`;
    },
    body: (r) => {
        const ss = r.structuredSummary || {};
        const parts = [];

        if (ss.overview) parts.push(`**Overview**：${truncate(ss.overview, 400)}`);
        else if (r.summaryText) parts.push(`**Overview**：${truncate(r.summaryText, 400)}`);

        if (Array.isArray(ss.topics) && ss.topics.length > 0) {
            parts.push(`**主題**：\n${formatTopicLines(ss.topics)}`);
        }

        const decisions = formatDecisions(ss.decisions);
        if (decisions) parts.push(`**決策**：\n${decisions}`);

        if (Array.isArray(ss.open_loops) && ss.open_loops.length > 0) {
            const items = ss.open_loops.map(l => `- ${typeof l === 'string' ? l : (l.item || '')}`).join('\n');
            parts.push(`**待辦**：\n${items}`);
        }

        return parts.length > 0 ? parts.join('\n') : null;
    },
    matched: (r) => r.matchedTurnText ? `**命中段落**: ${truncate(r.matchedTurnText, 200)}` : null,
    score: () => null,
    separator: () => '\n---\n',
};

const mirandaFormatter = createRecallFormatter(mirandaRenderers);

function formatRecallResults(results, opts = {}) {
    return mirandaFormatter(results, opts);
}

module.exports = { formatRecallResults, mirandaRenderers };
