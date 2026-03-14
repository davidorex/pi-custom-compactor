# Implementation Plan

5 phases, executed sequentially by subagents. Each phase produces working, tested code that subsequent phases build on.

---

## Phase 1: Project Scaffold + Types + Spec Resolution

**Goal:** Create the extension directory structure, all TypeScript interfaces, YAML spec parsing/validation, and multi-spec resolution logic. No pi runtime interaction — pure data modeling and file I/O.

**Deliverables:**
- `package.json` with `yaml` dependency and pi extension manifest
- `src/types.ts` — all interfaces
- `src/spec.ts` — YAML parsing, validation, multi-spec resolution
- `src/spec.test.ts` — tests for parsing and resolution

**What the agent needs to know:**
- Extension directory structure convention (package.json with `pi.extensions`, src/ layout)
- The full YAML spec format from SPEC.md (extracts, reassemble, tuning knobs)
- Resolution order (workflow-state.json → active pointer → default.yaml → flat file → none)
- No pi APIs needed — this is pure TypeScript + node:fs + yaml package

---

## Phase 2: Artifact I/O + Token Utilities + Stats

**Goal:** Build the artifact persistence layer — read, write, merge (append-only vs overwrite), cap enforcement (maxTokens, maxEntries), token estimation, and the stats JSONL log.

**Deliverables:**
- `src/artifacts.ts` — readArtifact, writeArtifact, mergeArtifact, enforceMaxTokens, enforceMaxEntries
- `src/tokens.ts` — estimateTokens (chars/4), estimateArtifactTokens
- `src/stats.ts` — CompactionStats, ArtifactStats, appendStats, readStats, formatTrend
- `src/artifacts.test.ts` — tests for merge, cap enforcement, edge cases (invalid JSON, missing files)
- `src/stats.test.ts` — tests for JSONL append/read, trend detection

**What the agent needs to know:**
- Types from Phase 1 (ExtractSpec with maxTokens, maxEntries, priority)
- Mechanical artifacts are append-only (arrays concatenated, sets merged)
- LLM artifacts are overwritten
- Cap enforcement: maxEntries slices from end (keep newest), maxTokens trims oldest entries until under budget
- Token estimation: `Math.ceil(JSON.stringify(data).length / 4)`
- Stats JSONL: one line per compaction, append-only
- Error handling: invalid JSON → return null, log warning

---

## Phase 3: Extractors (Mechanical + LLM)

**Goal:** Implement both extraction strategies. Mechanical: regex-based correction detection, file-ops extraction using pi's utilities. LLM: structured extraction via `complete()` from `@mariozechner/pi-ai`.

**Deliverables:**
- `src/mechanical.ts` — runMechanicalExtract, extractCorrections, extractFileOps, extractText helper
- `src/llm-extract.ts` — runLlmExtract, buildExtractionPrompt, parseJsonResponse, pickSummarizationModel
- `src/mechanical.test.ts` — tests with mock AgentMessages
- `src/llm-extract.test.ts` — tests for prompt construction, JSON parsing edge cases

**What the agent needs to know:**
- Types from Phase 1
- pi's AgentMessage union type: `Message | CustomAgentMessages[keyof CustomAgentMessages]`. User messages have `role: "user"`, content is `(TextContent | ImageContent)[]` where TextContent is `{ type: "text", text: string }`. Need to handle the union safely.
- pi's exported utilities: `createFileOps()`, `extractFileOpsFromMessage(msg, fileOps)`, `computeFileLists(fileOps)` from `@mariozechner/pi-coding-agent`
- pi's message serialization: `convertToLlm(messages)` and `serializeConversation(llmMessages)` from `@mariozechner/pi-coding-agent`
- `complete()` from `@mariozechner/pi-ai`: `complete(model, { messages }, { apiKey, maxTokens, signal })` → returns `AssistantMessage` with `.content` array and `.usage`
- Model selection: `ctx.modelRegistry.find(provider, pattern)`, `ctx.modelRegistry.getApiKey(model)`
- The `maxTokens` constraint on LLM extracts should be included in the prompt text, not as an API parameter (the API maxTokens is for response length)
- Error handling: JSON parse failures should return null with warning, not crash

---

## Phase 4: Reassembly + Budget Enforcement

**Goal:** Build the context injection layer — read artifacts from disk per the reassemble spec, enforce the global token budget with priority-based trimming, generate the stats summary block, compose everything into synthetic AgentMessages for the `context` hook.

**Deliverables:**
- `src/reassemble.ts` — readReassemblyArtifacts, enforceBudget, buildArtifactMessages, buildStatsSummary, composeSummary
- `src/reassemble.test.ts` — tests for budget enforcement (over/under budget, priority ordering, critical never dropped), stats summary formatting

**What the agent needs to know:**
- Types from Phase 1 (ReassembleSpec with budget, overflow, priority)
- Artifact I/O from Phase 2 (readArtifact, estimateArtifactTokens)
- Stats from Phase 2 (readStats for latest compaction stats)
- Budget enforcement algorithm:
  1. Read all artifacts, estimate tokens for each
  2. Sum total. If under budget (or no budget), done.
  3. If over: sort by priority (low → normal → high → critical)
  4. `trim-lowest`: drop entire lowest-priority artifacts until under budget. Never drop `critical`.
  5. `truncate-all`: proportionally reduce all non-critical artifacts
- Stats summary block: ~100 tokens of XML with last compaction stats, artifact sizes, growth warnings, budget usage, spec path
- `composeSummary()`: combines artifact content into tagged sections for the CompactionEntry.summary
- `buildArtifactMessages()`: wraps reassembled content as a synthetic `AgentMessage` with `role: "user"`, `content: [{ type: "text", text }]`, `timestamp: 0`
- Growth detection: compare current artifact tokens to previous compaction's — flag ⚠ if increasing for 3+ consecutive compactions

---

## Phase 5: Extension Entry Point — Hooks + Commands

**Goal:** Wire everything together in `index.ts`. Register the two hooks (`session_before_compact`, `context`), three commands (`/compaction-use`, `/compaction-stats`, `/compaction-clean`), and the event bus listener. This is the integration layer — all logic is in the modules from Phases 1–4.

**Deliverables:**
- `src/index.ts` — extension factory function with all registrations
- A working, installable extension

**What the agent needs to know:**
- All modules from Phases 1–4 and their public APIs
- pi Extension API:
  - `pi.on("session_before_compact", handler)` — event has `{ preparation, branchEntries, customInstructions, signal }`. Return `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }` to replace, `undefined` to fall back.
  - `pi.on("context", handler)` — event has `{ messages: AgentMessage[] }`. Return `{ messages }` to replace.
  - `pi.registerCommand(name, { description, getArgumentCompletions?, handler })` — handler receives `(args: string, ctx: ExtensionCommandContext)`
  - `pi.events.on("workflow:compaction", handler)` — event bus for workflow integration
  - `ctx.ui.notify(message, type)` — for warnings/errors
  - `ctx.model` — current model
  - `ctx.modelRegistry.find(provider, pattern)` — find a model
  - `ctx.modelRegistry.getApiKey(model)` — resolve API key
  - `ctx.cwd` — working directory
  - `ctx.getContextUsage()` — returns `{ tokens, contextWindow, percent }`
- Orchestration flow for `session_before_compact`:
  1. Resolve spec (Phase 1)
  2. If no spec, return undefined (fall back to built-in)
  3. Combine messagesToSummarize + turnPrefixMessages
  4. For each extract in spec: run mechanical or LLM extract, write artifact (Phase 2+3)
  5. Compose summary from artifacts (Phase 4)
  6. Record stats (Phase 2)
  7. Return compaction result with details containing artifact index + stats
- Orchestration flow for `context`:
  1. Resolve spec (Phase 1)
  2. If no spec or no reassemble section, return
  3. Read artifacts + enforce budget (Phase 4)
  4. Build stats summary block (Phase 4)
  5. Build synthetic messages (Phase 4)
  6. Prepend to event.messages, return
- Error handling: wrap entire hook bodies in try/catch. On failure, notify warning, return undefined (fall back to built-in). Never crash pi.
- The `complete()` call for LLM extracts needs the abort signal passed through from the event

---

## Execution Notes

- Each phase's agent receives SPEC.md + the files from prior phases
- Tests use node:test (built-in) — no test framework dependency
- The extension targets the project directory `.pi/extensions/custom-compactor/` but is developed in the repo root for convenience, then the final phase ensures correct structure
- `npm install` in the extension directory after Phase 1 creates the scaffold
