# miranda-memory 功能 Bucket 分類清單

> 2026-04-18 產出。依據 04-18 Architecture Reframing 拍板的二層原則：Aquifer = 完整記憶；Consumer = 薄殼（personality / UI glue / host wiring）。本清單把 `~/.openclaw/shared/lib/miranda-memory/` 的 11 個 module、相關 miranda.* table、systemd cron、gateway/CC hook，逐件分到四 bucket，供後續「Aquifer 補完工程」寫新 spec 用。

## 四 Bucket 定義

1. **Aquifer core** — 通用記憶資料層。schema、session lifecycle、commit/recall/enrich/bootstrap/feedback 等跨 tenant 跨 agent 皆可用的 API。
2. **Aquifer pipeline** — 通用記憶處理鏈。LLM 摘要契約、entity 抽取、embedding、rerank、facts/narrative consolidation 等；可選啟用，但邏輯屬於記憶本身。
3. **Aquifer consumer plugin**（新 `aquifer-miranda-plugin`） — 把 Aquifer 掛進 OpenClaw gateway + CC hook 的薄殼：Miranda persona prompt、daily log、workspace files、zh-TW recall format、context injection、host env/pg/embed 注入。
4. **OpenClaw host-only** — 跟 Aquifer 無關、只服務 Miranda 這個 agent 的功能：knowledge corpus search、Miranda app-scan、STT 等。

---

## A. miranda-memory 11 個 module

| Module | 大小 | Bucket | 理由 |
|---|---|---|---|
| `index.js` | 219 行 | **consumer plugin** | 純 registration hub（registerAfterburn / registerSessionRecallTool / executeSessionRecall）。功能跟 `aquifer/consumers/openclaw-plugin.js` 重疊，新 plugin 直接取代。 |
| `instance.js` | 51 行 | **consumer plugin** | Aquifer singleton 工廠，注入 OpenClaw 的 `shared/lib/pg` 和 `shared/lib/embed`。純 host wiring。 |
| `llm.js` | 120 行 | **consumer plugin** | 讀 `~/.openclaw/.env`、包 OpenRouter caller。Aquifer 已有 `consumers/shared/llm.js`，薄殼只要把 OpenClaw env 餵進去就好。 |
| `normalize.js` | 116 行 | **Aquifer pipeline**（刪除 / 已覆蓋） | `coerceRawEntries` 的功能 Aquifer `pipeline/normalize/adapters/gateway.js` 已有；`normalizeSession` 走 OpenClaw `shared/lib/session-normalize` — 新 plugin 改用 Aquifer pipeline，整個 module 移除。 |
| `parsers.js` | 542 行 | **分兩邊** | `parseEntitySection` → **Aquifer pipeline**（entity parse 通用）。`buildSummaryPrompt` / `parseSummaryOutput` / `parseRecapLines` / `parseWorkingFacts` / `parseHandoffSection` → **consumer plugin**（Miranda 六段 prompt 契約，屬 persona）。`buildConsolidationPrompt` / `parseConsolidationOutput` → **Aquifer pipeline**（facts lifecycle prompt 是通用記憶機制，但預設 opt-in）。 |
| `daily-entries.js` | 206 行 | **consumer plugin** | `miranda.daily_entries` 是 Miranda 人類可讀日誌的投影；`taipeiDateString` / `fetchDailyContext` / `writeDailyEntries` 都綁定台北時區 + Miranda 段落契約，不該污染 Aquifer core。 |
| `workspace-files.js` | 80 行 | **consumer plugin** | 寫 `emotional-state.md` / recap JSON / recap `.md` 到 workspaceDir，純 Miranda UI 物件。 |
| `recall-format.js` | 127 行 | **consumer plugin** | zh-TW 敘事格式（標題/敘事/主題/決策）— 是 Miranda 對話風格。Aquifer core 已提供 `formatBootstrapText`，consumer 再疊自己的格式層。 |
| `knowledge-search.js` | 99 行 | **OpenClaw host-only** | 吃的是 `knowledge_chunks` / `news_items`（跟 session memory 無關的知識語料）。不是 session 記憶，長期看是獨立 package 候選，短期內留在 host。 |
| `context-inject.js` | 151 行 | **consumer plugin** | `before_prompt_build` 注入 Miranda 人格 + handoff + 今日 CLI digest + mood — 完全是 persona 薄殼。 |
| `summary.js` | 360 行 | **分兩邊** | `processAfterburnSnapshot` 外殼 orchestration → **consumer plugin**（workspace 寫檔、daily 寫 DB、host logger）。其中 facts/consolidation 的 insert/update/promote/stale/archive/merge/supersede transaction → **Aquifer pipeline**（facts lifecycle API 應該 Aquifer 提供，consumer 只呼叫）。 |

---

## B. miranda.* Tables（目前 11 張）

| Table | Bucket | 理由 |
|---|---|---|
| `miranda.sessions` | **Aquifer core** | Aquifer schema `001-base.sql` 已管。 |
| `miranda.session_summaries` | **Aquifer core** | 同上。 |
| `miranda.session_segments` | **Aquifer core** | 同上。 |
| `miranda.turn_embeddings` | **Aquifer core** | 同上。 |
| `miranda.entities` | **Aquifer core**（entities 擴充） | `002-entities.sql` 已管。 |
| `miranda.entity_mentions` | **Aquifer core** | 同上。 |
| `miranda.entity_relations` | **Aquifer core** | 同上。 |
| `miranda.entity_sessions` | **Aquifer core** | 同上。 |
| `miranda.fact_entities` | **Aquifer pipeline** | facts lifecycle 附屬表。 |
| `miranda.facts` | **Aquifer pipeline** | facts consolidation 生命週期（candidate/active/stale/archived/superseded）屬通用記憶機制，應由 Aquifer 提供 `004-facts.sql` 可選 schema。 |
| `miranda.daily_entries` | **consumer plugin** | Miranda 人類可讀每日日誌投影，非通用。 |

> 另：narrative 目前走 `getLatestByTag('[NARRATIVE]')` 查 `daily_entries` 的 tagged row，`upsertNarrative` 也寫 `daily_entries`。narrative 概念本身偏「人格第一人稱連續敘述」，歸 **consumer plugin**。

---

## C. Systemd Timers / Cron

| Unit | Bucket | 理由 |
|---|---|---|
| `upstream-cron.timer` | **OpenClaw host-only** | driftwood 上游抓取，跟 session memory 無關。 |
| `digest-cron.timer` | **OpenClaw host-only** | 市場 digest，driftwood 專用。 |
| `driftwood-cron.timer` | **OpenClaw host-only** | Delivery router。 |
| `compile-cron.timer` | **OpenClaw host-only** | 知識 compile。 |
| `concept-registry-check.timer` | **OpenClaw host-only** | 知識語料健檢。 |
| `miranda-app-scan.timer` | **OpenClaw host-only** | Spotify 狀態監控，純 Miranda app。 |
| `miranda-sync.timer` | **OpenClaw host-only** | Miranda workspace 同步，跟記憶管線無關。 |

**重點：目前沒有任何 cron 直接驅動 miranda-memory 管線。** Phase 1+2 的 rollup cron spec 已作廢（04-18 拍板），不用補。

---

## D. Hooks

| Hook 位置 | 目前實作 | Bucket | 遷移方向 |
|---|---|---|---|
| Gateway `before_reset` | `extensions/afterburn/index.js` → `miranda.registerAfterburn` → `summary.processAfterburnSnapshot` | **consumer plugin** | 新 `aquifer-miranda-plugin` 取代，內部呼叫 Aquifer `commit` + `enrich(postProcess=...)`。 |
| Gateway `before_prompt_build` | `extensions/driftwood/index.js` → `miranda.registerSessionContextHook` | **consumer plugin** | 同上歸新 plugin。 |
| Gateway `registerTool session_recall` | `extensions/driftwood/index.js` → `miranda.registerSessionRecallTool` | **consumer plugin**（zh-TW 外殼）→ Aquifer core 提供 recall API | 呼叫 `aquifer.recall`，zh-TW 格式由 consumer 包。 |
| Gateway `registerTool knowledge_search` | `extensions/driftwood/index.js` → `miranda.registerKnowledgeTool` | **OpenClaw host-only** | 獨立留在 driftwood ext，不進 Aquifer。 |
| CC `SessionStart` | `~/.claude/scripts/cc-context-inject.sh` → `miranda.buildSessionContext` | **consumer plugin**（CC adapter） | 新 plugin 提供 CC 分支入口。 |
| CC Stop / afterburn | `~/.claude/scripts/cc-afterburn.js` → `miranda.{getAquifer,loadConfig,taipeiDateString,fetchDailyContext,extractConversationText,buildSummaryPrompt,callLlm,parseSummaryOutput,writeDailyEntries,resetAquifer}` | **consumer plugin**（CC adapter） | 同上，改吃新 plugin 公開的 CC 入口。 |
| CC `cc-afterburn.js:357-358` path-based deep import | 已知技術債 | **consumer plugin** | plugin 補完後順便清掉 deep import，改吃 top-level export。 |

---

## E. 衍生結論（給寫新 spec 用）

先做的事：Aquifer 補三個可選能力 — `pipeline/consolidation/`（facts lifecycle + consolidation prompt/parser + `004-facts.sql` 可選 schema）、`consumers/shared/entity-parser.js`（把 `parseEntitySection` 提出來）、enrich 的 `postProcess` 契約明確文件化。接著新開 `aquifer-miranda-plugin` repo（或 `aquifer/consumers/miranda.js` 子檔），把 index/instance/llm/summary 外殼/daily-entries/workspace-files/recall-format/context-inject + Miranda 版 parsers 全搬過來；plugin 同時提供 gateway register 入口和 CC adapter 入口（取代 cc-afterburn.js 對 miranda-memory 的直連）。knowledge-search 原地留在 driftwood ext，不動。systemd cron 不補。最後收尾：刪除 `~/.openclaw/shared/lib/miranda-memory/`、CC hook deep import 改吃 top-level export、gateway afterburn ext 改載入新 plugin。這樣拆出來 Aquifer 才真的「完整」，consumer 才真的「薄」，miranda-memory 這一層就消滅了。
