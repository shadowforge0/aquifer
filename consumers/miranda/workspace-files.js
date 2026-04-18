'use strict';

const fs = require('fs');
const path = require('path');

// Host-owned file paths: emotional state + recap JSON + learned skills.
// These are Miranda persona artifacts; other consumers won't want them.

function extractFilePaths(conversationText) {
    const re = /(?:^|\s|["'`])((?:\/[\w.@-]+)+(?:\/[\w.@-]+)*\.[\w]+)/g;
    const paths = new Set();
    let m;
    while ((m = re.exec(conversationText || '')) !== null) {
        const p = m[1];
        if (p.startsWith('/bin/') || p.startsWith('/usr/') || p.startsWith('/etc/')) continue;
        if (p.includes('node_modules/')) continue;
        paths.add(p);
    }
    return [...paths].slice(0, 30);
}

async function writeWorkspaceFiles(sections, recap, workspaceDir, context, logger = console) {
    let emotionalStateWritten = false;
    const recapFilesWritten = [];
    let learnedSkillsWritten = 0;

    if (sections?.emotional_state) {
        await fs.promises.mkdir(path.join(workspaceDir, 'memory'), { recursive: true });
        await fs.promises.writeFile(
            path.join(workspaceDir, 'memory', 'emotional-state.md'),
            sections.emotional_state, 'utf8',
        );
        emotionalStateWritten = true;
        if (logger.info) logger.info('[miranda] wrote emotional state');
    }

    if (recap?.title) {
        const sessDir = path.join(workspaceDir, 'memory', 'sessions');
        await fs.promises.mkdir(sessDir, { recursive: true });
        if (context?.conversationText) recap.files_mentioned = extractFilePaths(context.conversationText);

        await fs.promises.writeFile(
            path.join(sessDir, 'afterburn-latest.json'),
            JSON.stringify(recap, null, 2), 'utf8',
        );
        recapFilesWritten.push('afterburn-latest.json');

        const safeId = String(context?.sessionId || '').replace(/[^a-zA-Z0-9._-]/g, '_');
        if (safeId) {
            const fname = `afterburn-${safeId}.json`;
            await fs.promises.writeFile(path.join(sessDir, fname), JSON.stringify(recap, null, 2), 'utf8');
            recapFilesWritten.push(fname);
        }
        if (logger.info) logger.info(`[miranda] wrote recap (title=${recap.title.slice(0, 40)})`);
    }

    if (Array.isArray(recap?.reusable_patterns) && recap.reusable_patterns.length > 0) {
        try {
            const skillsPath = path.join(workspaceDir, 'memory', 'topics', 'learned-skills.md');
            let existing = '';
            try { existing = await fs.promises.readFile(skillsPath, 'utf8'); } catch { /* first write */ }
            if (!existing) {
                existing = '# Learned Skills\n\n> 自動從 session 中抽取的可重用操作模式。\n> invariant = 永久規則。derived = 情境洞察（可能過期）。\n\n';
            }
            const now = new Intl.DateTimeFormat('sv-SE', {
                timeZone: 'Asia/Taipei',
                year: 'numeric', month: '2-digit', day: '2-digit',
            }).format(new Date());
            const patterns = recap.reusable_patterns.filter(p => p.pattern && p.trigger);
            const lines = [];
            for (const p of patterns) {
                const icon = p.durability === 'invariant' ? '🔒' : '📌';
                const suffix = p.durability !== 'invariant' ? '（expires ~14d）' : '';
                lines.push(`- ${icon} **${p.pattern}** — 觸發：${p.trigger}；做法：${p.action || '(見 session)'}${suffix}`);
            }
            if (lines.length > 0) {
                await fs.promises.mkdir(path.dirname(skillsPath), { recursive: true });
                const section = `\n### ${now} (${String(context?.sessionId || '').slice(0, 8)})\n${lines.join('\n')}\n`;
                await fs.promises.writeFile(skillsPath, existing + section, 'utf8');
                learnedSkillsWritten = patterns.length;
                if (logger.info) logger.info(`[miranda] wrote ${patterns.length} skill(s)`);
            }
        } catch (err) {
            if (logger.info) logger.info(`[miranda] skill write skip: ${err.message}`);
        }
    }

    return { emotionalStateWritten, recapFilesWritten, learnedSkillsWritten };
}

module.exports = { writeWorkspaceFiles, extractFilePaths };
