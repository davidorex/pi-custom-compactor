# pi-custom-compactor

Pi extension. Replaces built-in compaction with YAML-declared extraction passes. Multiple specs can coexist for different work modes.

## Install

```bash
pi install git:github.com/davidorex/pi-custom-compactor
```

Project-local:

```bash
pi install git:github.com/davidorex/pi-custom-compactor -l
```

On first `session_start`, if no `.pi/compaction/` directory exists, seed specs are copied there and `default` is set active.

## Hooks

**`session_before_compact`** — Resolves the active spec. For each declared extract, runs either mechanical (regex/tool-call inspection, no LLM) or LLM-based extraction (via `complete()` from `@mariozechner/pi-ai`). Writes JSON artifacts to disk. Composes a summary from artifacts and returns it as the compaction result. Falls back to built-in compaction if no spec exists or on error.

**`context`** — Before each LLM call, reads artifacts from disk, enforces the token budget with priority-based trimming, and prepends them as synthetic user messages. Also injects a stats summary block. Nothing is persisted to the session.

## Commands

| Command | Description |
|---------|-------------|
| `/compaction-use [name]` | Switch active spec. No args shows current + available. Tab-completes spec names. |
| `/compaction-stats` | Shows latest compaction token counts, per-artifact sizes, LLM extract costs, and growth trends. |
| `/compaction-clean [--confirm]` | Lists orphaned artifact files not referenced by any spec. `--confirm` deletes them. |

## Spec Format

Specs are YAML files in `.pi/compaction/`. Each declares extracts and reassembly rules.

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
| `description` | yes | Used in LLM extraction prompts |
| `persist` | yes | Artifact file path, relative to project root |
| `format` | yes | JSON shape description, used in LLM extraction prompts |
| `strategy` | yes | `mechanical` or `llm` |
| `maxTokens` | no | Token cap. For mechanical: oldest array entries trimmed. For LLM: included as prompt constraint. |
| `maxEntries` | no | Array length cap (mechanical only, keeps newest) |
| `priority` | no | `critical` \| `high` \| `normal` (default) \| `low` — used for budget enforcement |

### Reassemble fields

| Field | Required | Description |
|-------|----------|-------------|
| `budget` | no | Global token cap for all injected artifacts |
| `overflow` | no | `trim-lowest` (default): drop lowest-priority artifacts. `truncate-all`: proportionally truncate non-critical. |
| `sources` | yes | Ordered list of `{ source, as, wrap }`. `source` = artifact path, `as` = label prefix, `wrap` = XML tag name. |

## Spec Resolution Order

Resolved fresh on every compaction and context event:

1. `.pi/workflow-state.json` with `"compactionSpec": "<name>"` → `.pi/compaction/<name>.yaml`
2. `.pi/compaction/active` (text file containing spec name) → `.pi/compaction/<name>.yaml`
3. `.pi/compaction/default.yaml`
4. `.pi/compaction.yaml`
5. No spec found → built-in compaction proceeds

Invalid specs at any step are skipped; resolution continues to the next step.

## Seed Specs

Copied to `.pi/compaction/` on first launch if the directory doesn't exist.

| Name | Extracts |
|------|----------|
| `default` | user-corrections (mechanical), decisions (llm), file-awareness (mechanical), task-state (llm) |
| `debugging` | error-observations (mechanical), hypotheses (llm), reproduction-steps (llm), file-awareness (mechanical) |
| `implementing` | task-state (llm), decisions (llm), api-contracts (llm), user-corrections (mechanical), file-awareness (mechanical) |
| `reviewing` | findings (llm), patterns (llm), file-awareness (mechanical) |

## Artifacts

Mechanical extracts are append-only across compactions (arrays concatenated, object arrays deduplicated). LLM extracts are overwritten each compaction.

Artifacts are JSON files at the `persist` paths declared in the spec. They exist independently of the session JSONL and can be read or edited directly.

## Stats

Each compaction appends a JSON line to `.pi/session-state/compaction-stats.jsonl` recording: tokens before/after, per-artifact token counts and byte sizes, LLM extract input/output token costs, active spec name, and context window size.

The `context` hook injects a `<compaction-stats>` block (~100 tokens) with the latest stats so the LLM has visibility into compaction behavior.

## Workflow Integration

Reads `.pi/workflow-state.json` during spec resolution. If a workflow extension writes `{ "compactionSpec": "debugging" }` to that file, the compactor uses that spec. Also listens on pi's event bus for `workflow:compaction` events.

No import dependency between extensions.

## Development

```bash
npm install
npx tsx --test src/*.test.ts
pi -e ./src/index.ts
```

189 tests. See SPEC.md for design rationale and PLAN.md for implementation phases.
