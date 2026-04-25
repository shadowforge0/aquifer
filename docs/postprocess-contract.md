# `enrich({ postProcess })` Contract

`aquifer.enrich(sessionId, opts)` runs commit → summarize → embed → entity-extract → mark-status inside a single DB transaction. After the transaction commits and the client is released, if `opts.postProcess` was supplied, Aquifer invokes it once with a context object. This is how consumers hook persona-specific side-effects (daily logs, workspace files, consolidation, narrative regen, metrics) without mutating core.

**Stability**: stable in 1.x. Additive changes only (new ctx fields). No removals or breaking renames without a major bump.

## Signature

```ts
postProcess?: (ctx: PostProcessContext) => Promise<void>
```

## When it runs

- **After** transaction commit and client release. The session row is already at its final status (`succeeded` or `partial`); nothing in postProcess can affect that.
- **At most once per enrich call**. No retry. If `postProcess` throws, the error is captured on the returned result as `postProcessError` (not re-thrown).
- Best-effort. The enrich call's return value resolves regardless of postProcess outcome.

## `ctx` shape

```ts
interface PostProcessContext {
  session: {
    id: number;              // DB primary key (<schema>.sessions.id)
    sessionId: string;       // caller-provided session key
    agentId: string;
    model: string | null;
    source: string | null;
    startedAt: string | null;  // ISO-8601
    endedAt: string | null;    // ISO-8601
  };

  // opts.model override, falling back to session.model. Handy for consumers
  // that want to pass the runtime model into downstream consolidation prompts.
  effectiveModel: string | null;

  // Summary result, if summarize ran. Null when skipSummary or summary failed.
  summary: {
    summaryText: string;
    structuredSummary: object | null;  // custom summaryFn payload
  } | null;

  // Summary-level embedding vector (size = embed.dim). Null if embed skipped/failed.
  embedding: number[] | null;

  // Per-turn embedding vectors (one per user turn). Null if skipped/failed.
  turnVectors: number[][] | null;

  // Passthrough from customSummaryFn return { extra }. Consumers use this to
  // smuggle intermediate results (recap/sections/workingFacts) from summaryFn
  // into postProcess without recomputing.
  extra: any;

  // Messages used for embedding/entity extraction. Same array commit() saw.
  normalized: Array<{ role: string; content: string; timestamp?: string }>;

  // Parsed entities from entityParseFn (or built-in parser).
  parsedEntities: Array<{ name: string; normalizedName: string; aliases: string[]; type: string }>;

  // Which pipeline steps ran.
  skipped: { summary: boolean; entities: boolean; turns: boolean };

  // Counts from the tx.
  turnsEmbedded: number;
  entitiesFound: number;

  // Non-fatal failures collected inside enrich. Defensive copy — mutating this
  // array does NOT affect enrich's own warnings list.
  warnings: string[];
}
```

## Typical usage

```js
const result = await aquifer.enrich(sessionId, {
  agentId: 'main',
  summaryFn: async (msgs) => {
    const output = await callLlm(buildPrompt({ msgs }));
    const sections = parseSummaryOutput(output);
    const recap = parseRecapLines(sections.recap);
    return {
      summaryText: recap.overview || '',
      structuredSummary: recap,
      entityRaw: sections.entities || null,
      extra: { sections, recap, workingFacts: parseWorkingFacts(sections.working_facts) },
    };
  },
  entityParseFn: (text) => parseEntitySection(text).entities,
  postProcess: async (ctx) => {
    const recap = ctx.extra?.recap;
    const sections = ctx.extra?.sections;
    const workingFacts = ctx.extra?.workingFacts || [];

    // Daily log
    if (recap || sections) {
      await writeDailyEntries({ recap, sections, sessionId: ctx.session.sessionId, agentId: ctx.session.agentId });
    }

    // Write fact candidates (consumer-specific table, not in Aquifer schema)
    if (workingFacts.length > 0) {
      await writeFactCandidates({ facts: workingFacts, sessionId: ctx.session.sessionId });
    }

    // Consolidation (optional — requires enableFacts())
    if (recap) {
      const prompt = buildConsolidationPrompt({ recap, activeFacts, candidates, currentNarrative });
      const output = await callLlm(prompt);
      const { actions } = parseConsolidationOutput(output);
      if (actions.length > 0) {
        await aquifer.consolidate(ctx.session.sessionId, { actions, agentId: ctx.session.agentId });
      }
    }
  },
});

if (result.postProcessError) {
  logger.warn(`postProcess failed: ${result.postProcessError.message}`);
}
```

## What NOT to do in postProcess

- Don't throw as a signal of "enrich should have failed" — enrich is already committed. Use warnings or a separate audit table.
- Don't mutate `ctx.normalized`, `ctx.parsedEntities`, or `ctx.warnings`. They're shared-reference with the enrich return; defensive copy if you need to modify.
- Don't rely on postProcess running quickly — it's outside the tx. Long-running work should be fire-and-forget or queued by the consumer.

## What Aquifer guarantees

- `postProcess` receives the same `session` row the tx wrote. No stale reads.
- If enrich's tx rolls back, postProcess is NOT called.
- If postProcess throws, the error is on `result.postProcessError`. The session status is unaffected.
