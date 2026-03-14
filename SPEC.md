# pi-custom-compactor: Extension Spec

A pi extension that replaces the built-in compaction with declarative, structured extraction passes defined in YAML. Instead of a single "LLM summarizes everything" strategy, users declare what to extract, how to persist it, and how to reassemble context. Multiple compaction specs can coexist, selected by workflow, by command, or created JIT by the LLM to match the current work.

## Problem

Pi's built-in compaction has one strategy: LLM summarizes older messages, keep recent ~20k tokens. This loses important context across compaction cycles:

- **User corrections** get buried or re-summarized into oblivion
- **Architectural decisions** lose their rationale
- **Task state** becomes vague
- **File awareness** is limited to the built-in `readFiles`/`modifiedFiles` tracking

Beyond information loss, the strategy is static. Debugging needs different memory than refactoring. A greenfield build needs different memory than a code review. One compaction spec can't serve all work modes.

The existing `custom-compaction.ts` example only swaps the model — it doesn't change the fundamental approach.

## Solution

A `.pi/compaction.yaml` spec that declares structured extraction passes:

```yaml
extracts:
  user-corrections:
    description: User corrections, redirects, and stated preferences
    persist: .pi/session-state/corrections.json
    format: |
      Array of { timestamp, correction, context }
    strategy: mechanical
    maxEntries: 50
    priority: high

  decisions:
    description: Architectural decisions with rationale
    persist: .pi/session-state/decisions.json
    format: |
      Array of { decision, rationale, files_affected }
    strategy: llm
    maxTokens: 2000
    priority: high

  file-awareness:
    description: Files read, modified, and created
    persist: .pi/session-state/files.json
    format: |
      { read: string[], modified: string[], created: string[] }
    strategy: mechanical
    priority: low

  task-state:
    description: Current goal, progress, blockers, next steps
    persist: .pi/session-state/task.json
    format: |
      { goal, constraints, done: string[], in_progress: string[], blocked: string[], next_steps: string[] }
    strategy: llm
    maxTokens: 2000
    priority: critical

reassemble:
  budget: 12000
  overflow: trim-lowest
  sources:
    - source: .pi/session-state/task.json
      as: "Task state:"
      wrap: task-state

    - source: .pi/session-state/corrections.json
      as: "User corrections and preferences (must be honored):"
      wrap: user-corrections

    - source: .pi/session-state/decisions.json
      as: "Architectural decisions made:"
      wrap: decisions

    - source: .pi/session-state/files.json
      as: "Files touched:"
      wrap: file-context
```

## Architecture

### Two Hooks

**`session_before_compact`** — Intercepts compaction, runs declared extracts, writes JSON artifacts, composes a rich summary from artifacts + LLM summarization, returns it as the compaction result.

**`context`** — Before every LLM call, reads artifacts from disk and prepends them as synthetic messages. This is ephemeral (not persisted in the session), avoiding duplication across turns.

### Why These Hooks

- `session_before_compact` is the only hook that fires for both manual `/compact` and auto-compaction. It can return `{ compaction: {...} }` to fully replace the built-in summary, or `undefined` to fall back.

- `context` fires before each LLM call with a deep copy of messages, safe to modify. Returning `{ messages: [...] }` replaces what the LLM sees without persisting anything. This is better than:
  - ~~`pi.appendEntry()`~~ — does NOT participate in LLM context (creates `CustomEntry`, explicitly ignored by `buildSessionContext`)
  - ~~`pi.sendMessage()`~~ — persists a `CustomMessageEntry` in the session, would duplicate on every turn
  - ~~`before_agent_start`~~ — persists a `CustomMessage` in the session per prompt, same duplication problem
  - ~~`session_start`~~ — fires once at initial load, not per-turn

### Extract Strategies

**Mechanical** (`strategy: mechanical`) — Pattern matching and tool-call parsing against the `AgentMessage[]`. No LLM cost. Results are **append-only** across compactions (corrections accumulate, file lists merge).

**LLM** (`strategy: llm`) — Semantic extraction via `complete()` from `@mariozechner/pi-ai`. Results are **overwritten** each compaction (task state and decisions reflect latest understanding).

### Artifact Lifecycle

Artifacts are JSON files on disk in `.pi/session-state/`. They:
- Survive independently of the session JSONL
- Can be inspected and hand-edited
- Accumulate across compactions (mechanical) or get refreshed (LLM)
- Are referenced by name in `CompactionEntry.details` as an artifact index

## Multiple Specs & Dynamic Selection

### Why Multiple Specs

Different work needs different memory:

| Work mode | What matters | What doesn't |
|-----------|-------------|--------------|
| Debugging | Error patterns, hypotheses tried, stack traces, reproduction steps | Task progress, API design |
| Refactoring | Dependency maps, migration progress, before/after patterns | User preferences, task backlog |
| Implementing | Task state, design decisions, API contracts, constraints | Error patterns, hypothesis history |
| Reviewing | Findings, severity, file annotations, patterns observed | Task state, build progress |

A single static YAML can't serve all of these. The compaction strategy should adapt to the work.

### Spec Layout

```
.pi/compaction/
├── default.yaml              # fallback when nothing else is active
├── debugging.yaml            # error patterns, hypotheses, stack traces
├── refactoring.yaml          # dependency maps, migration progress
├── implementing.yaml         # task state, decisions, API contracts
├── reviewing.yaml            # findings, severity, file annotations
├── memory-leak-hunt.yaml     # JIT-created by LLM for a specific task
└── active                    # pointer file: contains name of active spec
```

The `active` file is plain text containing the spec name (without `.yaml`):

```
debugging
```

### Resolution Order

The extension resolves the active spec on every compaction cycle and every `context` event (loaded fresh, no caching):

1. **Workflow signal** — If `.pi/workflow-state.json` exists and contains `{ "compactionSpec": "debugging" }`, use `.pi/compaction/debugging.yaml`
2. **Pointer file** — Else if `.pi/compaction/active` contains a name, use `.pi/compaction/<name>.yaml`
3. **Default** — Else if `.pi/compaction/default.yaml` exists, use it
4. **Flat file (backward compat)** — Else if `.pi/compaction.yaml` exists, use it
5. **No spec** — Fall back to built-in compaction

### Workflow Integration

The extension does not import from or depend on `../workflowsPiExtension` directly. Integration is via a file convention:

```json
// .pi/workflow-state.json (written by workflow extension)
{
  "activeWorkflow": "debug-memory-leak",
  "compactionSpec": "debugging"
}
```

When a workflow activates, the workflow extension writes this file. When it deactivates, it removes the `compactionSpec` field (or deletes the file). The compactor extension reads it during spec resolution. This is:

- **Decoupled** — neither extension imports the other
- **Inspectable** — it's a JSON file on disk
- **Restart-safe** — survives process restarts (unlike event bus messages)
- **Editable** — user or LLM can override by editing the file

For real-time coordination (e.g., workflow change mid-session without waiting for next compaction), the compactor also listens on the pi event bus as a secondary signal:

```typescript
pi.events.on("workflow:compaction", (data: { spec: string }) => {
  // Cache for immediate effect on next context event
  activeSpecOverride = data.spec;
});
```

The workflow extension can emit this when switching workflows. The file remains the source of truth; the event bus is an optimization for responsiveness.

### JIT Spec Creation

The LLM can create a new compaction spec at any time using normal file tools:

```
User: "We're debugging a memory leak in the worker pool"

LLM thinks: This needs a debugging-specific compaction strategy.
LLM action: write .pi/compaction/memory-leak.yaml with extracts for:
  - error-observations (mechanical: OOM patterns, heap sizes from bash output)
  - hypotheses (llm: what's been tried, what was ruled out, what's promising)
  - affected-files (mechanical: files read/modified during investigation)
  - reproduction-steps (llm: how to trigger the leak)
LLM action: write "memory-leak" to .pi/compaction/active
LLM says: "Set up memory leak debugging compaction. I'll track hypotheses, error patterns, and reproduction steps across compactions."
```

When the work shifts:

```
User: "OK the leak is fixed. Let's implement the new caching layer."

LLM action: write "implementing" to .pi/compaction/active
LLM says: "Switched to implementation compaction — tracking task state, decisions, and API contracts."
```

The old `memory-leak.yaml` stays on disk. Its artifacts stay in `.pi/session-state/`. If the user comes back to debugging later, everything is still there.

### `/compaction-use` Command

Registered via `pi.registerCommand()`. Switches the active spec:

```
/compaction-use debugging          # switch to .pi/compaction/debugging.yaml
/compaction-use memory-leak        # switch to JIT-created spec
/compaction-use default            # back to default
/compaction-use                    # show current + available specs
```

Implementation: writes the name to `.pi/compaction/active`.

With argument completions:

```typescript
pi.registerCommand("compaction-use", {
  description: "Switch active compaction spec",
  getArgumentCompletions: (prefix) => {
    const specs = listSpecFiles(cwd); // scan .pi/compaction/*.yaml
    return specs
      .filter(s => s.startsWith(prefix))
      .map(s => ({ value: s, label: s }));
  },
  handler: async (args, ctx) => {
    if (!args.trim()) {
      // Show current + available
      const current = resolveActiveSpecName(ctx.cwd);
      const available = listSpecFiles(ctx.cwd);
      ctx.ui.notify(`Active: ${current ?? "none"}\nAvailable: ${available.join(", ")}`, "info");
      return;
    }
    writeActivePointer(ctx.cwd, args.trim());
    ctx.ui.notify(`Compaction spec: ${args.trim()}`, "info");
  },
});
```

### Artifact Isolation Across Specs

Each spec declares its own `persist` paths. When specs switch:

- **Same paths** — New spec picks up existing artifacts. Useful when specs share extracts (e.g., both `debugging.yaml` and `implementing.yaml` track `file-awareness` at the same path).
- **Different paths** — Old artifacts are inert. Not injected, not deleted. They remain on disk for inspection or future reuse.
- **Recommended convention** — Namespace artifact paths by spec name to avoid collisions:

```yaml
# .pi/compaction/debugging.yaml
extracts:
  hypotheses:
    persist: .pi/session-state/debugging/hypotheses.json
    # ...
```

### `/compaction-clean` Command

Prunes orphaned artifacts not referenced by any spec:

```
/compaction-clean              # dry run — show what would be deleted
/compaction-clean --confirm    # actually delete
```

### Stats Across Spec Switches

The `compaction-stats.jsonl` log records which spec was active:

```typescript
interface CompactionStats {
  // ... existing fields ...
  specName: string;         // which spec produced this compaction
  specPath: string;         // resolved path to the YAML file
}
```

`/compaction-stats` groups trends by spec:

```
Spec: debugging (last 3 compactions)
  hypotheses:      1.2k → 1.8k → 2.4k  ⚠ growing
  error-patterns:  800 → 800 → 900  stable

Spec: implementing (last 5 compactions)
  task-state:  1.9k → 2.1k → 1.8k → 2.2k → 2.1k  stable
  decisions:   1.4k → 1.6k → 1.5k → 1.7k → 1.6k  stable
```

## Implementation

### Extension Structure

Directory extension with npm dependencies (needs `yaml` package):

```
.pi/extensions/custom-compactor/
├── package.json
├── src/
│   ├── index.ts          # Extension entry point, hook registration
│   ├── spec.ts           # YAML spec parsing, validation, multi-spec resolution
│   ├── mechanical.ts     # Mechanical extraction (corrections, file ops)
│   ├── llm-extract.ts    # LLM-based extraction (decisions, task state)
│   ├── artifacts.ts      # Read/write/merge JSON artifacts, cap enforcement
│   ├── reassemble.ts     # Build synthetic messages from artifacts + stats
│   └── stats.ts          # Token tracking, JSONL log, trend analysis
```

### Hook 1: `session_before_compact`

```typescript
import { complete } from "@mariozechner/pi-ai";
import {
  convertToLlm, serializeConversation,
  type ExtensionAPI, type SessionBeforeCompactEvent, type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

pi.on("session_before_compact", async (event, ctx) => {
  const spec = loadSpec(ctx.cwd);
  if (!spec) return; // no spec, fall back to built-in

  const { preparation, branchEntries, signal } = event;
  const {
    messagesToSummarize,
    turnPrefixMessages,
    previousSummary,
    firstKeptEntryId,
    tokensBefore,
    fileOps,        // already extracted by pi
  } = preparation;

  const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

  // Run each declared extract
  for (const [name, extract] of Object.entries(spec.extracts)) {
    const artifactPath = resolveArtifactPath(extract.persist, ctx.cwd);

    if (extract.strategy === "mechanical") {
      const result = runMechanicalExtract(name, extract, allMessages);
      const existing = readArtifact(artifactPath);
      const merged = mergeArtifact(existing, result); // append-only
      writeArtifact(artifactPath, merged);
    } else {
      // LLM extract
      const model = pickSummarizationModel(ctx);
      const apiKey = await ctx.modelRegistry.getApiKey(model);
      const result = await runLlmExtract(name, extract, allMessages, model, apiKey, signal);
      writeArtifact(artifactPath, result); // overwrite
    }
  }

  // Compose summary from artifacts + conversation
  const summary = composeSummary(spec, ctx.cwd, allMessages, previousSummary);

  return {
    compaction: {
      summary,
      firstKeptEntryId,
      tokensBefore,
      details: buildArtifactIndex(spec, ctx.cwd),
    },
  };
});
```

### Hook 2: `context`

```typescript
pi.on("context", async (event, ctx) => {
  const spec = loadSpec(ctx.cwd);
  if (!spec?.reassemble) return;

  // Only inject if we've had a compaction (artifacts exist)
  const artifacts = readReassemblyArtifacts(spec, ctx.cwd);
  if (artifacts.length === 0) return;

  // Build synthetic user messages from artifacts
  const injected = buildArtifactMessages(artifacts);

  // Prepend before existing messages
  return { messages: [...injected, ...event.messages] };
});
```

### Mechanical Extraction

Uses `AgentMessage` inspection. For user corrections, regex against user message text. For file ops, uses pi's built-in `preparation.fileOps` or the exported `extractFileOpsFromMessage()` utility.

```typescript
import { createFileOps, extractFileOpsFromMessage, computeFileLists } from "@mariozechner/pi-coding-agent";

function runMechanicalExtract(
  name: string,
  extract: ExtractSpec,
  messages: AgentMessage[],
): unknown {
  if (name === "user-corrections") {
    return extractCorrections(messages);
  }
  if (name === "file-awareness") {
    return extractFileOps(messages);
  }
  return null;
}

function extractCorrections(messages: AgentMessage[]): Correction[] {
  const corrections: Correction[] = [];
  const pattern = /\b(no[,.]|wrong|not what|instead|actually|don't|stop|should be|prefer|always|never)\b/i;

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const text = extractText(msg);
    if (pattern.test(text)) {
      corrections.push({ timestamp: msg.timestamp, text: text.slice(0, 500) });
    }
  }
  return corrections;
}

function extractFileOps(messages: AgentMessage[]) {
  const fileOps = createFileOps();
  for (const msg of messages) {
    extractFileOpsFromMessage(msg, fileOps);
  }
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  return { read: readFiles, modified: modifiedFiles };
}
```

### LLM Extraction

Uses `complete()` from `@mariozechner/pi-ai` with a structured prompt. Serializes messages via `convertToLlm()` + `serializeConversation()`.

```typescript
import { complete } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

async function runLlmExtract(
  name: string,
  extract: ExtractSpec,
  messages: AgentMessage[],
  model: Model<any>,
  apiKey: string,
  signal: AbortSignal,
): Promise<unknown> {
  const conversationText = serializeConversation(convertToLlm(messages));

  const prompt = `Extract "${name}" from the following conversation.
Description: ${extract.description}
Output format: ${extract.format}
Output valid JSON only, no explanation.

<conversation>
${conversationText}
</conversation>`;

  const response = await complete(model, {
    messages: [{
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    }],
  }, { apiKey, maxTokens: 4096, signal });

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map(c => c.text)
    .join("\n");

  return JSON.parse(text);
}
```

### Summary Composition

The compaction summary is composed from artifacts + a condensed LLM summary of the raw conversation. This ensures the built-in compaction summary message (automatically injected by `buildSessionContext()`) contains all structured context.

```typescript
function composeSummary(
  spec: CompactionSpec,
  cwd: string,
  messages: AgentMessage[],
  previousSummary?: string,
): string {
  const sections: string[] = [];

  // Add each artifact as a tagged section
  for (const entry of spec.reassemble) {
    const artifactPath = resolveArtifactPath(entry.source, cwd);
    if (!fs.existsSync(artifactPath)) continue;
    const data = fs.readFileSync(artifactPath, "utf-8");
    sections.push(`${entry.as}\n\n<${entry.wrap}>\n${data}\n</${entry.wrap}>`);
  }

  // Include previous summary context if iterating
  if (previousSummary) {
    sections.push(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
  }

  return sections.join("\n\n");
}
```

### Reassembly via `context` Hook

Artifacts are read from disk and injected as synthetic user messages before every LLM call. This is ephemeral — nothing is persisted to the session.

```typescript
function buildArtifactMessages(artifacts: ReassembledArtifact[]): AgentMessage[] {
  const content = artifacts
    .map(a => `${a.as}\n\n<${a.wrap}>\n${a.data}\n</${a.wrap}>`)
    .join("\n\n");

  return [{
    role: "user" as const,
    content: [{ type: "text" as const, text: content }],
    timestamp: 0,
  }];
}
```

### Model Selection for LLM Extracts

The extension should try a cheap/fast model for extraction (e.g., Gemini Flash), falling back to the conversation model:

```typescript
function pickSummarizationModel(ctx: ExtensionContext): Model<any> {
  // Try cheap models first
  const candidates = [
    ["google", "gemini-2.5-flash"],
    ["anthropic", "claude-haiku"],
  ];
  for (const [provider, pattern] of candidates) {
    const model = ctx.modelRegistry.find(provider, pattern);
    if (model) return model;
  }
  // Fall back to current model
  return ctx.model!;
}
```

## Token Tracking & Self-Tuning

### The Optimization Loop

Compaction is not fire-and-forget. The extension tracks token costs so that both the user and the LLM can evaluate and tune the compaction spec over time:

1. Compaction runs → stats are recorded
2. Stats are visible in context (LLM) and via command (user)
3. Either party identifies a problem (bloat, waste, missing extraction)
4. `.pi/compaction.yaml` is edited (by user or LLM — it's just a file)
5. Next compaction picks up the change (spec is loaded fresh each cycle)
6. Stats show the effect

No special tools needed. The LLM already has `read` and `edit`. The spec is a file on disk. The stats close the feedback loop.

### What Gets Tracked

Each compaction records:

```typescript
interface ArtifactStats {
  path: string;
  tokens: number;          // estimated tokens (chars/4 heuristic via estimateTokens)
  sizeBytes: number;       // raw file size
  entries?: number;        // item count for array artifacts (corrections, etc.)
  strategy: "mechanical" | "llm";
  trimmed?: boolean;       // true if maxTokens/maxEntries cap was applied
  extractCost?: {          // only for strategy: "llm"
    inputTokens: number;   // from complete() response.usage
    outputTokens: number;
  };
}

interface CompactionStats {
  timestamp: number;
  tokensBefore: number;              // pre-compaction context (from preparation)
  summaryTokens: number;             // the composed summary we returned
  reassemblyTokens: number;          // total injected by context hook
  reassemblyBudget: number | null;   // from spec, null if uncapped
  contextWindow: number;             // model's context window for percentage calc
  artifacts: Record<string, ArtifactStats>;
  totalExtractCost: {
    inputTokens: number;
    outputTokens: number;
  };
}
```

Token estimation uses the same `chars/4` heuristic pi uses internally (`estimateTokens`). For LLM extract costs, `complete()` returns actual usage via `response.usage`.

### Where Stats Live

**`CompactionEntry.details`** — The current compaction's stats are stored alongside the artifact index, surviving session reload:

```typescript
interface CompactionDetails {
  artifactIndex: Record<string, { path: string; strategy: string }>;
  stats: CompactionStats;
}
```

**`.pi/session-state/compaction-stats.jsonl`** — Append-only log. Each compaction appends one `CompactionStats` line. Enables trend analysis across compaction cycles.

### Stats in LLM Context

The `context` hook injects a small stats block (~100 tokens) alongside the artifacts:

```xml
<compaction-stats>
Last compaction: 142k → 4.2k summary + 8.7k reassembly (6.1% of 142k context)
Artifacts: task-state 2.1k, decisions 1.8k, corrections 3.2k (⚠ growing, 47 entries), files 1.6k
Reassembly budget: 8.7k / 12k (72%)
Extract cost: 6.4k input + 3.2k output tokens
Spec: .pi/compaction.yaml (editable)
</compaction-stats>
```

This lets the LLM reason about compaction health and proactively suggest changes. The `(editable)` hint reminds it the spec is a normal file.

### `/compaction-stats` Command

Registered via `pi.registerCommand()`. Reads the JSONL log and shows:

```
Last compaction:
  Context before:     142,381 tokens
  Summary produced:     4,200 tokens
  Reassembly total:     8,750 tokens (6.1% of context window)

  Artifacts:
    task-state        2,100 tokens  (llm, cost: 3.2k in / 1.8k out)
    decisions         1,850 tokens  (llm, cost: 3.2k in / 1.4k out)
    corrections       3,200 tokens  (mechanical, 47 entries) ⚠ growing
    files             1,600 tokens  (mechanical)

  Total extract cost: 6.4k input / 3.2k output tokens

Trend (last 5 compactions):
  corrections:  800 → 1,400 → 2,100 → 2,800 → 3,200  ⚠ growing
  task-state:   1,900 → 2,100 → 1,800 → 2,200 → 2,100  stable
  reassembly:   5,100 → 6,200 → 7,400 → 8,100 → 8,750  ⚠ growing
```

### Tuning Knobs

The YAML spec supports per-extract caps and a global reassembly budget:

```yaml
extracts:
  user-corrections:
    description: User corrections, redirects, and stated preferences
    persist: .pi/session-state/corrections.json
    format: |
      Array of { timestamp, correction, context }
    strategy: mechanical
    maxTokens: 4000        # hard cap — oldest entries trimmed to fit
    maxEntries: 50         # alternative cap — keep N most recent

  decisions:
    description: Architectural decisions with rationale
    persist: .pi/session-state/decisions.json
    format: |
      Array of { decision, rationale, files_affected }
    strategy: llm
    maxTokens: 2000        # instructs LLM to be concise within budget
    priority: high         # kept under global budget pressure

  task-state:
    description: Current goal, progress, blockers, next steps
    persist: .pi/session-state/task.json
    format: |
      { goal, constraints, done: string[], in_progress: string[], blocked: string[], next_steps: string[] }
    strategy: llm
    maxTokens: 2000
    priority: critical     # never dropped

  file-awareness:
    description: Files read, modified, and created
    persist: .pi/session-state/files.json
    format: |
      { read: string[], modified: string[], created: string[] }
    strategy: mechanical
    priority: low          # first to trim under pressure

reassemble:
  budget: 12000            # global token budget for all reassembled artifacts
  overflow: trim-lowest    # when over budget: trim lowest-priority artifacts first
  sources:
    - source: .pi/session-state/task.json
      as: "Task state:"
      wrap: task-state
    # ...
```

**Cap enforcement:**

- `maxTokens` on mechanical extracts: during merge, oldest entries are dropped until the artifact fits. Stats record `trimmed: true`.
- `maxTokens` on LLM extracts: included in the extraction prompt as a constraint ("be concise, stay under N tokens").
- `maxEntries` on mechanical extracts: keep the N most recent entries.
- `budget` on reassembly: total token cap for all injected artifacts. When exceeded, artifacts are trimmed or dropped by `priority` (lowest first). `critical` priority artifacts are never dropped.
- `overflow: trim-lowest` (default): drop lowest-priority artifacts entirely until under budget. Alternative: `overflow: truncate-all` — proportionally truncate all non-critical artifacts.

**Priority levels:** `critical > high > normal > low`. Default is `normal`. Under budget pressure, `low` artifacts are dropped first, then `normal`, then `high`. `critical` is never dropped.

### LLM-Initiated Tuning Example

The LLM sees the stats in context:

```
corrections 3.2k tokens (⚠ growing, 47 entries)
```

It can proactively respond:

> "Your corrections artifact is growing unbounded and now uses 3.2k tokens. Want me to add a `maxEntries: 30` cap to keep only the most recent corrections?"

User says yes. LLM reads `.pi/compaction.yaml`, adds the cap, done. Next compaction trims to 30 entries, stats show the reduction.

No special commands, no API, no extension changes. The LLM tunes compaction the same way it edits any other config file.

## Spec Format

### `extracts`

```yaml
extracts:
  <name>:
    description: <string>               # what to extract (used in LLM prompts)
    persist: <relative path>            # artifact file path, resolved from cwd
    format: <string>                    # JSON shape description (used in LLM prompts)
    strategy: mechanical | llm
    maxTokens: <number>                 # optional — cap artifact size
    maxEntries: <number>                # optional — cap array length (mechanical only)
    priority: critical | high | normal | low  # optional — default: normal
```

### `reassemble`

```yaml
reassemble:
  budget: <number>                      # optional — global token cap for all artifacts
  overflow: trim-lowest | truncate-all  # optional — default: trim-lowest
  sources:
    - source: <artifact path>           # matches a persist path from extracts
      as: <prefix text>                 # label shown before the artifact
      wrap: <xml-tag-name>              # XML tag wrapping the artifact data
```

Order of `sources` matters — artifacts are injected in the declared order.

## Key Design Decisions

1. **Artifacts are files on disk**, not embedded in session JSONL. Inspectable, editable, composable.

2. **Mechanical extracts are append-only** — corrections and file tracking accumulate across compactions. LLM extracts are overwritten — task state reflects latest understanding.

3. **Context injection via `context` hook** — ephemeral, fires before every LLM call, no session entry duplication.

4. **Summary composition bakes artifacts into the compaction summary** — the built-in `CompactionEntry.summary` already gets injected by `buildSessionContext()`, so we make it rich.

5. **`CompactionEntry.details` stores an artifact index + stats** — enables the extension to know which artifacts exist, where, and how expensive they are.

6. **Graceful fallback** — if no spec exists, the extension does nothing and built-in compaction proceeds. If LLM calls fail, fall back to built-in.

7. **Model flexibility** — LLM extracts use a cheap model (Gemini Flash) when available, falling back to the conversation model.

8. **Multiple specs, file-based selection** — Specs live in `.pi/compaction/`, active spec is a pointer file. Resolution is fresh every cycle. No restart or `/reload` needed to switch.

9. **Workflow integration via file convention** — No direct dependency on workflow extensions. A `.pi/workflow-state.json` file is the integration surface. Decoupled, inspectable, restart-safe.

10. **LLM is a first-class tuner** — The LLM can create specs, switch between them, and tune their parameters using normal file tools. Stats in context give it the data to make informed changes. No special API needed.

## Resolved Design Questions

- **Context injection gating** — The `context` hook checks for artifact file existence. No files = no injection. No wasted tokens before first compaction.
- **Inspection command** — `/compaction-stats` reads the JSONL log and shows current state + trends, grouped by spec.
- **Token budget for artifacts** — `reassemble.budget` with priority-based overflow handling.
- **Invalid JSON from hand-edits** — `readArtifact()` wraps in try/catch. On parse failure, log a warning via `ctx.ui.notify()`, skip that artifact, continue. Don't crash compaction.
- **Spec reload** — Spec is resolved fresh on every compaction and every `context` event. Edits and spec switches take effect immediately, no `/reload` needed.
- **Per-workflow compaction** — Solved via file convention (`.pi/workflow-state.json`) and multi-spec resolution. Workflow extension writes the signal, compactor reads it. No coupling.
- **Artifact cleanup on spec switch** — Old artifacts are inert, not deleted. `/compaction-clean` command for explicit pruning.

## Open Questions

- Should mechanical extracts support user-defined regex patterns in the YAML, or are the built-in extractors (corrections, file-ops) sufficient for v1?
- Should there be a `strategy: hybrid` that runs mechanical first, then LLM to refine? (Probably overkill for v1.)
- Should the extension ship with a library of pre-built specs (debugging, implementing, reviewing, etc.), or should it only provide `default.yaml` and let users/LLMs create the rest?
- Should spec creation be assisted? E.g., `/compaction-new debugging` opens an interactive wizard or asks the LLM to generate a spec for that work mode.
