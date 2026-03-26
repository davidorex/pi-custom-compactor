---
name: pi-custom-compactor
description: >
  Replaces built-in compaction with YAML-driven structured extraction and
  budget-aware reassembly. Use when configuring compaction specs, switching work
  modes, understanding extraction strategies, authoring custom extracts, or
  debugging compaction budget and artifact growth.
---

<commands_reference>
<command name="/compaction-use">
Switch active compaction spec
</command>

<command name="/compaction-stats">
Show compaction statistics and trends
</command>

<command name="/compaction-clean">
Remove orphaned compaction artifacts
</command>

</commands_reference>

<hooks>
- `session_start`
- `session_switch`
- `session_fork`
- `session_before_compact`
- `context`
</hooks>

<event_bus>
Listens on: `workflow:compaction`
</event_bus>

<bundled_resources>
4 seed specs bundled: `debugging`, `default`, `implementing`, `reviewing`.
See references/bundled-resources.md for full inventory.
See references/spec-vocabulary.md for extract and reassembly vocabulary.
</bundled_resources>

<compaction_vocabulary>

**Strategies:** `mechanical` (regex/tool-call inspection, no LLM cost), `llm` (model-driven structured extraction)

**Priorities:** `critical` > `high` > `normal` (default) > `low`

**Overflow:** `trim-lowest` (default, drops lowest-priority artifacts), `truncate-all` (proportionally shrinks non-critical)

**Seed specs:**

| Spec | Extracts | Budget | Overflow |
|------|----------|--------|----------|
| `debugging` | error-observations, hypotheses, file-awareness, reproduction-steps | 10000 | trim-lowest |
| `default` | user-corrections, decisions, file-awareness, task-state | 12000 | trim-lowest |
| `implementing` | task-state, decisions, api-contracts, user-corrections, file-awareness | 12000 | trim-lowest |
| `reviewing` | findings, patterns, file-awareness | 10000 | trim-lowest |

</compaction_vocabulary>

<objective>
pi-custom-compactor replaces the built-in compaction pipeline with a configurable YAML-driven system. Each compaction spec declares named extracts (mechanical or LLM-based) that persist JSON artifacts to disk, and a reassemble section that injects those artifacts back into context with priority-based budget enforcement. Different specs can be swapped per work mode (debugging, implementing, reviewing) so the model retains the information most relevant to the current task.
</objective>

<spec_authoring>
Compaction specs are YAML files in `.pi/compaction/`. Each spec has two top-level sections:

**`extracts`** — named extraction passes, each with:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | yes | What to extract (used in LLM prompts) |
| `persist` | string | yes | Artifact file path relative to cwd |
| `format` | string | yes | JSON shape description (used in LLM prompts) |
| `strategy` | `mechanical` or `llm` | yes | Extraction method |
| `maxTokens` | number | no | Token cap for the artifact |
| `maxEntries` | number | no | Array length cap (mechanical only) |
| `priority` | `critical`, `high`, `normal`, `low` | no | Budget enforcement priority (default: `normal`) |

**`reassemble`** — how artifacts are injected back into context:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `budget` | number | no | Global token budget for all reassembled artifacts |
| `overflow` | `trim-lowest` or `truncate-all` | no | Budget overflow strategy (default: `trim-lowest`) |
| `sources` | array | yes | Ordered list of artifacts to inject |

Each source entry has: `source` (artifact path matching an extract's `persist`), `as` (label prefix shown before content), `wrap` (XML tag name wrapping the data).
</spec_authoring>

<extraction_strategies>
**Mechanical** (`strategy: mechanical`) — regex and tool-call inspection, no LLM cost. Results are merged (append-only for arrays, set-deduplicated for object values) across compaction cycles so information accumulates.

Known mechanical extract names:
- `user-corrections` — scans user messages for correction patterns (no, wrong, instead, don't, should be, prefer, always, never) and captures matching text with timestamps
- `file-awareness` — inspects assistant tool calls for read/write/edit operations and collects file paths into `{ read: string[], modified: string[] }`

Unknown mechanical names return an empty array as graceful fallback.

**LLM** (`strategy: llm`) — sends the conversation text to a cheap summarization model with a structured extraction prompt. The model selection prefers Gemini Flash, then Claude Haiku, then falls back to the session model. Each LLM extract overwrites its artifact on each compaction cycle (not append-only). The `format` field becomes the output schema instruction and `maxTokens` adds a conciseness constraint to the prompt.
</extraction_strategies>

<priority_system>
Four priority levels control what survives under budget pressure:

`critical` (3) > `high` (2) > `normal` (1) > `low` (0)

Default priority is `normal`. When total reassembly tokens exceed the budget, the overflow strategy decides what to trim:

- **`trim-lowest`** (default) — drops entire lowest-priority artifacts first, ascending. Critical artifacts are never dropped. If still over budget after removing all non-critical artifacts, keeps everything (graceful degradation).
- **`truncate-all`** — keeps all artifacts but proportionally truncates non-critical data strings. Critical artifacts retain full size. Others are shrunk by the ratio `(budget - criticalTokens) / nonCriticalTokens`.

Token estimation is intentionally conservative (overestimates) to prevent budget underruns. CJK text is estimated at 1 token per character; other text at 1 token per 4 characters.
</priority_system>

<spec_resolution>
The active spec is resolved fresh on each compaction cycle, checked in order:

1. `.pi/workflow-state.json` `compactionSpec` field — if present and names a valid `.pi/compaction/<name>.yaml`
2. `.pi/compaction/active` pointer file — plain text file containing the spec name
3. `.pi/compaction/default.yaml` — conventional default
4. `.pi/compaction.yaml` — flat file, backward compatibility
5. No spec found — falls back to built-in compaction

Invalid specs at any step are silently skipped and resolution continues to the next step. The `/compaction-use <name>` command writes the active pointer file at step 2.
</spec_resolution>

<workflow_integration>
External workflows can override the active compaction spec through two mechanisms:

1. **workflow-state.json** — a workflow writes `{ "compactionSpec": "<name>" }` to `.pi/workflow-state.json`. This takes precedence in the resolution order (step 1). Persists across compaction cycles until removed.

2. **Event bus** — a workflow emits `workflow:compaction` with payload `{ spec: "<name>" }`. The extension captures this and uses it as a one-shot override for the next compaction cycle only.

Both override mechanisms are reset on session switch and session fork to prevent stale overrides from persisting across branches. No import dependency exists between the compactor extension and the workflow extension — integration is purely through file conventions and the event bus.
</workflow_integration>

<success_criteria>
- Spec YAML validates without errors (tested by `loadAndValidateSpec`)
- Extracts produce artifacts at their declared persist paths after compaction
- Reassembly token total stays within budget when a budget is set
- `/compaction-stats` shows non-zero token counts and artifact sizes
- `/compaction-use <name>` switches the active spec and subsequent compactions use it
- Artifacts persist across compaction cycles (mechanical extracts accumulate, LLM extracts refresh)
- Growth trends flag artifacts with 3+ consecutive increasing token counts
</success_criteria>

*Generated from source by `scripts/generate-skills.ts` — do not edit by hand.*
