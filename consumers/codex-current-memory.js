'use strict';

function compactCurrentMemoryRow(row = {}) {
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const confidence = payload.confidence || payload.currentMemoryConfidence || null;
    return {
        memoryType: row.memoryType || row.memory_type || 'memory',
        canonicalKey: row.canonicalKey || row.canonical_key || null,
        scopeKey: row.scopeKey || row.scope_key || null,
        summary: String(row.summary || row.title || '').replace(/\s+/g, ' ').trim(),
        authority: row.authority || null,
        confidence,
    };
}

function currentMemoryRows(currentMemory = null) {
    return Array.isArray(currentMemory?.memories)
        ? currentMemory.memories
        : (Array.isArray(currentMemory?.items) ? currentMemory.items : []);
}

function currentMemoryLimit(opts = {}) {
    return Math.max(0, Math.min(20, opts.maxCurrentMemoryItems || opts.currentMemoryLimit || 12));
}

function formatCurrentMemoryPromptBlock(currentMemory = null, opts = {}) {
    const maxItems = currentMemoryLimit(opts);
    const meta = currentMemory && currentMemory.meta ? currentMemory.meta : {};
    const rows = currentMemoryRows(currentMemory);
    const compactRows = rows.map(compactCurrentMemoryRow).filter(row => row.summary).slice(0, maxItems);
    const attrs = [
        `source="${meta.source || 'memory_records'}"`,
        `serving_contract="${meta.servingContract || meta.serving_contract || 'current_memory_v1'}"`,
        `count="${compactRows.length}"`,
        `truncated="${Boolean(meta.truncated || rows.length > compactRows.length)}"`,
        `degraded="${Boolean(meta.degraded || currentMemory?.error)}"`,
    ];
    const lines = compactRows.map(row => {
        const scope = row.scopeKey ? ` scope=${row.scopeKey}` : '';
        const authority = row.authority ? ` authority=${row.authority}` : '';
        const confidence = row.confidence ? ` confidence=${row.confidence}` : '';
        return `- ${row.memoryType}${scope}${authority}${confidence}: ${row.summary}`;
    });
    if (currentMemory && currentMemory.error && lines.length === 0) {
        lines.push(`- degraded: ${String(currentMemory.error).replace(/\s+/g, ' ').trim()}`);
    }
    if (lines.length === 0) lines.push('- none');
    return [
        `<current_memory ${attrs.join(' ')}>`,
        ...lines,
        '</current_memory>',
    ].join('\n');
}

function compactCurrentMemorySnapshot(currentMemory = null, opts = {}) {
    const maxItems = currentMemoryLimit(opts);
    const meta = currentMemory && currentMemory.meta ? currentMemory.meta : {};
    const rows = currentMemoryRows(currentMemory);
    return {
        memories: rows.map(compactCurrentMemoryRow).filter(row => row.summary).slice(0, maxItems),
        meta: {
            source: meta.source || 'memory_records',
            servingContract: meta.servingContract || meta.serving_contract || 'current_memory_v1',
            count: Math.min(rows.length, maxItems),
            truncated: Boolean(meta.truncated || rows.length > maxItems),
            degraded: Boolean(meta.degraded || currentMemory?.error),
        },
    };
}

async function resolveCurrentMemoryForFinalization(aquifer, opts = {}) {
    if (opts.includeCurrentMemory === false) return null;
    if (opts.currentMemory !== undefined) return opts.currentMemory;
    const currentFn = aquifer?.memory?.current || aquifer?.memory?.listCurrentMemory;
    if (typeof currentFn !== 'function') return null;
    const limit = Math.max(1, Math.min(20, opts.currentMemoryLimit || opts.maxCurrentMemoryItems || 12));
    try {
        return await currentFn.call(aquifer.memory, {
            tenantId: opts.tenantId,
            activeScopeKey: opts.activeScopeKey || opts.scopeKey,
            activeScopePath: opts.activeScopePath,
            scopeId: opts.scopeId,
            asOf: opts.asOf,
            limit,
        });
    } catch (err) {
        return {
            memories: [],
            meta: {
                source: 'memory_records',
                servingContract: 'current_memory_v1',
                count: 0,
                truncated: false,
                degraded: true,
            },
            error: err.message,
        };
    }
}

module.exports = {
    compactCurrentMemoryRow,
    formatCurrentMemoryPromptBlock,
    compactCurrentMemorySnapshot,
    resolveCurrentMemoryForFinalization,
};
