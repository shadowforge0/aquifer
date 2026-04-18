# SPEC：Aquifer 補完工程（消滅 miranda-memory）

> 2026-04-18 產出。依據 `BUCKET_CLASSIFICATION_20260418.md` + 04-18 架構 reframing 拍板。目標：把 `~/.openclaw/shared/lib/miranda-memory/` 徹底搬離，讓「裝 aquifer 就有完整記憶」、consumer 只剩 host wiring 薄殼。

## 0. 驗收條件（DoD）

- `~/.openclaw/shared/lib/miranda-memory/` 目錄消失（`git mv` → 新 plugin or 整份刪除）。
- OpenClaw gateway `extensions/afterburn/index.js` + `extensions/driftwood/index.js` 只 require `@shadowforge0/aquifer-memory/consumers/miranda`（或獨立 plugin 套件），不 require `shared/lib/miranda-memory`。
- CC hook `~/.claude/scripts/cc-afterburn.js` + `cc-afterburn-backfill.js` + `cc-context-inject.sh` 改吃 plugin 對外 API（或 top-level Aquifer exports），path-based deep import（`cc-afterburn.js:357-358`）一併清掉。
- `miranda.facts` / `miranda.fact_entities` 改由 Aquifer 新 `schema/004-facts.sql` 可選 migration 管理；facts lifecycle 的 promote/stale/archive/merge/supersede transaction 從 `summary.js` 搬進 Aquifer `pipeline/consolidation/`。
- Aquifer test 全綠（現 527 tests + 新增）、miranda-memory 原 19 tests 轉 plugin 或淘汰、Gateway smoke（`getAquifer`/`session_recall`/`knowledge_search`/`parseEntitySection`）全綠、CC afterburn 端到端驗證（手動跑一個 session 走完 commit→enrich→daily→facts→consolidation）。
- 不新增任何 cron。Phase 1+2 舊 rollup spec 不復活。
- Aquifer npm 版本由 1.0.4 → 1.1.0（minor bump：新增 `pipeline/consolidation` + `consumers/miranda` + `schema/004-facts.sql`；向下相容）。

## 1. 任務拆解（四 Milestone，依序執行）

### M1：Aquifer 補三件可選能力（不破壞既有 API）

1-1. `pipeline/consolidation/` 新模組
- `pipeline/consolidation/prompt.js`：從 `miranda-memory/parsers.js` 搬 `buildConsolidationPrompt` 出來，簽名改泛化（inputs：`recap` / `activeFacts` / `candidates` / `currentNarrative`；不綁 Miranda 措辭的部分留 plugin 覆寫）。
- `pipeline/consolidation/parse.js`：搬 `parseConsolidationOutput`。
- `pipeline/consolidation/apply.js`：抽出 `summary.js` 內的 8-action transaction（promote/create/update/confirm/stale/discard/merge/supersede），吃 `pool + schema + actions + agentId + sessionId`，不綁 `miranda.facts` 字面，改吃 `${schema}.facts`。
- `pipeline/consolidation/index.js`：export `runConsolidation({ pool, schema, ... })`。
- `core/aquifer.js`：新增 `instance.consolidate(sessionId, opts)` 包裝，opt-in；`enrich` 不動（保留 postProcess 讓 caller 自己呼叫 `consolidate`）。

1-2. `schema/004-facts.sql`（可選 migration）
- `${schema}.facts`（id/subject_key/subject_label/statement/status/importance/source_session_id/agent_id/evidence/superseded_by/last_confirmed_at/created_at/updated_at），索引與既有 `miranda.facts` live schema 一致（見舊 spec F4 dump）。
- `${schema}.fact_entities`（fact_id / entity_id）。
- 由 `aquifer.enableFacts()` 觸發 migration（仿照 `enableEntities()`）。

1-3. `consumers/shared/entity-parser.js`
- 把 `miranda-memory/parsers.js` 的 `parseEntitySection` 抽出（它已經是通用解析 function）。
- 從 top-level `index.js` export 出來，取代現在 plugin 直接走 `core/entity` path-based require 的 hack。

1-4. `docs/postprocess-contract.md`（新）
- 明文列 `enrich({ postProcess })` 的 context 物件 schema（`session` / `effectiveModel` / `summary` / `embedding` / `turnVectors` / `extra` / `normalized` / `parsedEntities` / `skipped` / `turnsEmbedded` / `entitiesFound` / `warnings`），標 stability = "stable in 1.x"。

**M1 測試**：
- `test/consolidation.test.js`：apply.js 八種 action × commit/rollback，mock pool。
- `test/consolidation-prompt.test.js`：buildConsolidationPrompt 輸出 snapshot、parseConsolidationOutput 對七種樣本。
- `test/facts-schema.test.js`：`enableFacts()` 建表、idempotent。
- `test/entity-parser.test.js`：現 miranda-memory parsers 測試裡 `parseEntitySection` 的 case 全搬過來。

### M1.5：擴 `consumers/shared/` — 把三個 consumer 重複造的輪子模組化

> 現況：`consumers/openclaw-plugin.js`、`consumers/opencode.js`、`consumers/mcp.js` 各自有 normalize / format / dedup 實作；`shared/` 目前只有 `config.js` / `factory.js` / `llm.js`。重複的抽出來，三個 consumer 才真的共用一套。

1-5-1. `consumers/shared/normalize.js`
- `normalizeMessages(rawEntries, { adapter })` — 接 `gateway`（openclaw）、`cc`（Claude Code JSONL）、`opencode`（SQLite parts）三種 adapter，內部轉 Aquifer `pipeline/normalize`。
- 回傳 `{ messages, userCount, assistantCount, model, tokensIn, tokensOut, startedAt, lastMessageAt }`，commit-ready 形狀。
- 取代 `openclaw-plugin.js#normalizeEntries` + `opencode.js#normalizeConversation` + `miranda-memory/normalize.js` 三份 duplicate。

1-5-2. `consumers/shared/ingest.js`
- `runIngest({ aquifer, sessionId, agentId, source, sessionKey, rawEntries, adapter, minUserMessages, dedupMap, inFlight, postProcess })`：封裝「normalize → commit → enrich(postProcess) 或 skip」標準流程，含 dedupKey + inFlight 保護。
- 三個 host adapter 共用，不再各自重寫 commit+enrich 骨架。

1-5-3. `consumers/shared/recall-format.js`
- 預設英文格式器（合併現行 `openclaw-plugin.js#formatRecallResults` + `mcp.js#formatResults`）。
- 提供 `createRecallFormatter({ renderTitle, renderBody, renderMatched, lang })`，讓 persona（如 Miranda）注入 zh-TW narrative 風格，不必整份重寫。

**M1.5 測試**：
- `test/shared-normalize.test.js`：三個 adapter 的 input fixture 各一組，欄位對齊。
- `test/shared-ingest.test.js`：dedup / inFlight / userCount 門檻 / enrich 失敗仍 commit 成功。
- `test/shared-recall-format.test.js`：預設格式 snapshot + 自訂 renderer 注入。

### M2：Host adapter × Persona 拆兩層

2-A. 通用 host adapter（三個，不帶 persona）：
```
consumers/
  openclaw-plugin.js     ← 已有，內部改吃 shared/ingest + shared/normalize；乾淨只做 commit+enrich+tool registration
  claude-code.js         ← 新增，通用 CC afterburn + context-inject adapter
                          exports: { runAfterburn(input), runContextInject(input), runBackfill(opts) }
                          input 吃 CC transcript JSONL 路徑 / sessionId / agentId / workspaceDir
                          內部走 shared/ingest 的標準流程；postProcess 槽預留給 persona
  opencode.js            ← 已有，內部改吃 shared/ingest + shared/normalize
```
三者都是「純 host」——沒有 persona 概念，postProcess 留空或由 caller 注入。任何新 agent（英文助理、其他 persona）都能用這三個 host 不吃 Miranda 那套。

2-B. Miranda persona layer：
```
consumers/miranda/
  index.js               ← export { mountOnOpenClaw(api, opts), mountOnClaudeCode(ccAdapter, opts), buildPostProcess(opts) }
  instance.js            ← Aquifer singleton wiring（吃 injected host pg/embed/llm，不綁 OpenClaw path）
  llm.js                 ← OpenRouter wrapper + loadConfig（envPath 可覆寫）
  prompts/summary.js     ← buildSummaryPrompt（六段）+ parseSummaryOutput + parseRecapLines + parseWorkingFacts + parseHandoffSection
  daily-entries.js       ← taipeiDateString + fetchDailyContext + writeDailyEntries（miranda.daily_entries 由 plugin 擁有，不進 Aquifer schema）
  workspace-files.js     ← writeWorkspaceFiles（emotional-state.md / recap json / recap .md）
  recall-format.js       ← 用 shared/recall-format 的 createRecallFormatter 注 zh-TW 敘事
  context-inject.js      ← buildSessionContext + extractFocusTodoMood
```
Miranda 現在是「拿來套到 host 上的 persona」：
- `mountOnOpenClaw(api)` = 註冊 `before_reset` / `before_prompt_build` / `registerTool session_recall`，postProcess 用 `buildPostProcess(opts)` 做 daily + workspace + consolidate 三件。
- `mountOnClaudeCode(cc)` = 把 `buildPostProcess` 接到 `consumers/claude-code.js` 的 runAfterburn、用 `context-inject` 接 runContextInject。

2-C. 搬移對照（miranda-memory → 目的地）：
| 原檔 | 目的地 | 備註 |
|---|---|---|
| `index.js` | `consumers/miranda/index.js` + `consumers/openclaw-plugin.js`（裸版） | register* 分兩邊 |
| `instance.js` | `consumers/miranda/instance.js` | 改吃 injected deps |
| `llm.js` | `consumers/miranda/llm.js` | envPath 可覆寫 |
| `parsers.js` 六段 prompt/parser | `consumers/miranda/prompts/summary.js` | persona 專屬 |
| `parsers.js#parseEntitySection` | `consumers/shared/entity-parser.js`（M1.3） | 通用 |
| `parsers.js` consolidation prompt/parse | `pipeline/consolidation/`（M1.1） | 通用 |
| `normalize.js` | 刪 → 改走 `shared/normalize.js` | duplicate |
| `daily-entries.js` | `consumers/miranda/daily-entries.js` | persona |
| `workspace-files.js` | `consumers/miranda/workspace-files.js` | persona |
| `recall-format.js` | `consumers/miranda/recall-format.js`（注入 shared formatter） | persona |
| `context-inject.js` | `consumers/miranda/context-inject.js` | persona |
| `summary.js` orchestration | 拆：通用骨架進 `shared/ingest.js`；persona 步驟（daily/workspace/consolidate）進 `consumers/miranda/index.js#buildPostProcess` | — |
| `knowledge-search.js` | 不搬，留 OpenClaw host（M4） | 非 session memory |

2-D. `package.json` 變動：
- `files:` 加 `consumers/miranda/`、`consumers/claude-code.js`
- `exports:` 加 `./consumers/miranda`、`./consumers/claude-code`、`./consumers/shared/normalize`、`./consumers/shared/ingest`、`./consumers/shared/recall-format`、`./consumers/shared/entity-parser`
- version 1.0.4 → 1.1.0
- 保留 `consumers/openclaw-plugin.js` 不動（只是內部實作改走 shared/）

**M2 測試**：
- `test/claude-code-adapter.test.js`：runAfterburn 吃 fake CC JSONL，走完 shared/ingest，postProcess 收到正確 context。
- `test/miranda-persona.test.js`：mountOnOpenClaw + mountOnClaudeCode 各跑一次，驗證 Miranda prompt + daily + workspace + consolidate 皆被觸發。
- `test/miranda-prompts.test.js`：搬舊 miranda-memory parsers 19 tests 的六段部分。
- `test/openclaw-plugin.test.js` + `test/opencode.test.js`：refactor 後走 shared/ingest，驗證行為等價（snapshot 對照）。

### M3：切流量 + 清舊檔

3-1. Gateway 端（`~/.openclaw/`）：
- `extensions/afterburn/index.js`：改 `const miranda = require('@shadowforge0/aquifer-memory/consumers/miranda'); miranda.mountOnOpenClaw(api, { envPath: ... })`。
- `extensions/driftwood/index.js`：`registerKnowledgeTool` 改 require 獨立 knowledge-search lib（新建 `~/.openclaw/shared/lib/knowledge-search/`，只搬 knowledge-search.js + 對應 pg helper）；`registerSessionRecallTool` + `registerSessionContextHook` 收到 `miranda.mountOnOpenClaw` 裡一併處理。
- 重啟 `openclaw-gateway.service`，跑 smoke。
- 確認 6 agents 載入、session_recall / knowledge_search 回應正常、before_prompt_build 注入出現 Miranda persona。

3-2. CC 端（`~/.claude/scripts/`）：
- `cc-afterburn.js`：改 `const cc = require('@shadowforge0/aquifer-memory/consumers/claude-code'); const miranda = require('@shadowforge0/aquifer-memory/consumers/miranda'); miranda.mountOnClaudeCode(cc); await cc.runAfterburn(input)`。順手清 357-358 path-based deep import（`normalizeEntityName` 改吃 top-level export）。
- `cc-afterburn-backfill.js`：同上，用 `cc.runBackfill`。
- `cc-context-inject.sh`：node eval 改 `cc.runContextInject(input)`。
- 手動跑一個短 session（3 user msg 以上），確認 miranda.sessions/session_summaries/daily_entries/facts 全部寫入、workspace 的 emotional-state.md 被更新、narrative 被 upsert。

3-3. 刪除（僅在 M3.1 + M3.2 smoke 全綠之後）：
- `rm -rf ~/.openclaw/shared/lib/miranda-memory/`
- OpenClaw private tree 會被 daily-backup 自動 commit。

### M4：Knowledge search 獨立化（避免拖累主線）

4-1. 新目錄 `~/.openclaw/shared/lib/knowledge-search/`（不進 Aquifer repo）
- 搬 `miranda-memory/knowledge-search.js`。
- 依賴的 `pg.searchByEmbedding` / `searchNewsByEmbedding` / `searchByKeyword` 留原處不動。
- Driftwood ext require 此路徑。

4-2. 不改 schema、不動 knowledge_chunks / news_items 表。

## 2. 工作順序 & 時序

1. **先把 1.0.4 commit 掉**（pending：`cd ~/projects/aquifer && npm install` 裝 eslint devDep → `git commit` → 不 push）。
2. **M1 全做完 + PR 自 review**（consolidation 三檔 + 004-facts.sql + entity-parser + docs + 四支測試）。bump 1.1.0-alpha.1，`npm pack` 產 tarball。
3. **M1.5 全做完**（shared/normalize + shared/ingest + shared/recall-format + 三支測試；現有 openclaw-plugin / opencode / mcp 內部 refactor 吃 shared/ 並跑 snapshot 對照）。
4. **M2 全做完**（claude-code.js host adapter + miranda persona layer 七檔搬過 + 測試）。bump 1.1.0-alpha.2，`npm pack`。
5. **M3.1 Gateway 切流量**：`~/.openclaw/package.json` dep 指向 alpha.2 tarball，`npm install`，重啟 gateway，smoke 全綠。
6. **M3.2 CC 切流量**：改三支 hook 腳本，跑一輪 afterburn 驗證。
7. **M3.3 刪 miranda-memory**。
8. **M4 knowledge-search 獨立化**（可跟 M3 並行）。
9. Aquifer 正式 `1.1.0` pack + publish（如有 registry）。

## 3. 風險與回滾

- **風險 A**：plugin 搬過去後 `require('@shadowforge0/aquifer-memory/consumers/miranda')` 解不到 → `package.json#exports` 沒加對；rollback：回前一版 tarball。
- **風險 B**：facts 四表 schema 在 Aquifer 建立時跟 live 的 `miranda.facts` 欄位順序 / constraint 不匹配 → M1.2 前先 `pg_dump -s` live schema，004-facts.sql 用 `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS` 最小侵入；rollback：`enableFacts()` 不跑就等同沒事。
- **風險 C**：Gateway 切流量後 before_prompt_build 注入格式變 → 以現行 `context-inject.js` 輸出做 snapshot test（M2 覆蓋），任何字元級變化視為 regression。
- **風險 D**：CC deep import 清掉之後 `normalizeEntityName` 在某個 edge path 拿不到 → M1.3 把它放 top-level export；CC 改 `require('@shadowforge0/aquifer-memory').normalizeEntityName`，跑一次 `kg/backfill_entities.js` 驗。
- **回滾總閘**：Gateway 端保留 `extensions/afterburn/index.js.bak`（已有 `.bak`），CC 端 `git` 保留上一版；M3 任何 smoke 失敗立刻 revert，miranda-memory 目錄晚一點才真刪。

## 4. 非目標（Out of scope）

- 不補任何 cron；Phase 1+2 rollup spec 作廢，rollup-daily/weekly/maintain-facts 等 bin 腳本**不寫**。
- 不改 `miranda.daily_entries` schema。它留在 plugin 作 Miranda 專屬投影，Aquifer schema 不承接。
- 不搬 knowledge_chunks / news_items / knowledge-search 進 Aquifer。
- 不做 Aquifer 1.1.0 → 1.2.0 的事（Miranda plugin 成熟後若要獨立成 `@shadowforge0/aquifer-miranda` package 再說，**本 spec 範圍內不拆**）。

## 5. 收尾與 memory 更新

- M3 完成後更新 `project_aquifer_completion.md`：status=done。
- 刪除 `feedback_aquifer_two_layer.md` 不適用——改狀態為「已落地，保留作歷史依據」（memory 不刪）。
- `MEMORY.md` 索引更新「Aquifer 補完工程」→「Aquifer 補完工程（已完成，2026-04-xx）」。
- `HANDOFF_ARCHITECTURE_REFRAMING_20260418.md` 留原處當歷史。
- 在 Aquifer repo `CHANGELOG.md`（若無則新建）記 1.1.0 的三大新增。

---

**下一動作**：先把 1.0.4 commit 清掉（裝 eslint → commit → 不 push），接著進 M1。M1 可以一條 branch 一次做完，PR 自 review 後進 M2。
