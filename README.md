# pi-custom-compactor

A [pi](https://github.com/badlogic/pi-mono) extension that replaces built-in compaction with declarative, structured extraction passes defined in YAML.

Instead of "LLM summarizes everything, keep recent 20k tokens," you declare what to extract, how to persist it, and how to reassemble context — with different strategies for different kinds of work.

## Install

```bash
pi install git:github.com/davidorex/pi-custom-compactor
```

Or project-local:

```bash
pi install git:github.com/davidorex/pi-custom-compactor -l
```

On first launch, the extension copies four seed specs to `.pi/compaction/` and activates `default`. No configuration needed to start.

## How It Works

### Extraction

When compaction triggers (automatic or `/compact`), the extension runs declared extraction passes against the messages being compacted:

- **Mechanical** — regex pattern matching and tool-call inspection. No LLM cost. User corrections, file operations.
- **LLM** — semantic extraction via a cheap model (Gemini Flash, Haiku, or falls back to the conversation model). Architectural decisions, task state.

Each extract writes a JSON artifact to `.pi/session-state/`.

### Reassembly

Before every LLM call, the extension reads artifacts from disk and injects them as context — tagged XML sections with labels. This is ephemeral (not persisted in the session), avoiding duplication.

A token budget with priority-based trimming keeps injection size bounded.

### Stats

Every compaction records token counts, artifact sizes, LLM extract costs, and growth trends to `.pi/session-state/compaction-stats.jsonl`. A compact stats block is injected into LLM context so the model can reason about compaction health and suggest tuning.

## Seed Specs

| Spec | Focus | Extracts |
|------|-------|----------|
| `default` | General-purpose | corrections, decisions, file-awareness, task-state |
| `debugging` | Bug investigation | error-observations, hypotheses, reproduction-steps, file-awareness |
| `implementing` | Feature work | task-state, decisions, api-contracts, corrections, file-awareness |
| `reviewing` | Code review | findings, patterns, file-awareness |

## Commands

| Command | Description |
|---------|-------------|
| `/compaction-use [name]` | Switch active spec (tab-completion). No args shows current + available. |
| `/compaction-stats` | Show latest compaction stats and per-artifact trends. |
| `/compaction-clean [--confirm]` | Find orphaned artifacts. `--confirm` to delete. |

## Spec Format

Specs live in `.pi/compaction/*.yaml`. Example:

```yaml
extracts:
  user-corrections:
    description: User corrections, redirects, and stated preferences
    persist: .pi/session-state/corrections.json
    format: |
      Array of { timestamp: number, correction: string, context: string }
    strategy: mechanical
    maxEntries: 50
    priority: high

  task-state:
    description: Current goal, progress, blockers, and next steps
    persist: .pi/session-state/task.json
    format: |
      { goal: string, constraints: string[], done: string[], in_progress: string[], blocked: string[], next_steps: string[] }
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
      as: "User corrections (must be honored):"
      wrap: user-corrections
```

### Extract fields

| Field | Required | Description |
|-------|----------|-------------|
| `description` | yes | What to extract (used in LLM prompts) |
| `persist` | yes | Artifact file path, relative to project root |
| `format` | yes | JSON shape description (used in LLM prompts) |
| `strategy` | yes | `mechanical` or `llm` |
| `maxTokens` | no | Cap artifact size (oldest entries trimmed) |
| `maxEntries` | no | Cap array length (mechanical only) |
| `priority` | no | `critical`, `high`, `normal` (default), `low` |

### Reassemble fields

| Field | Required | Description |
|-------|----------|-------------|
| `budget` | no | Global token cap for all injected artifacts |
| `overflow` | no | `trim-lowest` (default) or `truncate-all` |
| `sources` | yes | Ordered list of `{ source, as, wrap }` |

## Spec Resolution

The active spec is resolved fresh on every compaction and context event:

1. `.pi/workflow-state.json` → `compactionSpec` field → `.pi/compaction/<name>.yaml`
2. `.pi/compaction/active` pointer file → `.pi/compaction/<name>.yaml`
3. `.pi/compaction/default.yaml`
4. `.pi/compaction.yaml` (flat file, backward compat)
5. No spec → built-in compaction

## Dynamic Specs

The LLM can create and switch specs using normal file tools:

```
"We're debugging a memory leak — let me set up compaction for that."
→ writes .pi/compaction/memory-leak.yaml
→ writes "memory-leak" to .pi/compaction/active
```

Stats in context give the LLM data to tune specs — add caps, adjust priorities, create new extracts.

## Workflow Integration

If a workflow extension writes `.pi/workflow-state.json` with a `compactionSpec` field, that spec takes priority. No direct dependency between extensions — file convention only.

The extension also listens on pi's event bus for `workflow:compaction` events for real-time spec switching.

## Development

```bash
git clone https://github.com/davidorex/pi-custom-compactor
cd pi-custom-compactor
npm install
npx tsx --test src/*.test.ts     # 189 tests
pi -e ./src/index.ts             # test with pi
```
