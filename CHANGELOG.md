# Changelog

All notable changes to this project will be documented in this file.

## v0.1.1


### 🩹 Fixes

- CJK-aware token estimation — addresses pi-mono#2562 ([#2562](https://github.com/davidorex/pi-custom-compactor/issues/2562))

### ❤️ Contributors

- David Ryan <davidryan@gmail.com>

## v0.1.0

Initial release.

### Added

- YAML-driven compaction specs with declarative extract definitions
- Mechanical extraction: user corrections (regex), file operations (tool call parsing)
- LLM extraction: structured semantic extraction via configurable model (Gemini Flash, Claude Haiku, or conversation model)
- Artifact persistence to `.pi/session-state/` JSON files — survives independently of session JSONL
- Append-only merge for mechanical extracts, overwrite for LLM extracts
- Token budget enforcement with priority-based overflow (trim-lowest, truncate-all)
- Per-extract caps: maxTokens, maxEntries
- Multi-spec support: `.pi/compaction/` directory with named YAML specs
- Spec resolution chain: workflow-state.json, active pointer, default.yaml, flat compaction.yaml
- Seed specs: default, debugging, implementing, reviewing
- Auto-bootstrap: copies seed specs on first session if no specs exist
- Context hook: ephemeral artifact injection before every LLM call
- Compaction stats: JSONL log with per-artifact token tracking, trend detection, growth warnings
- Stats injection into LLM context for self-tuning awareness
- `/compaction-use` command: switch active spec with tab completions
- `/compaction-stats` command: show compaction statistics and trends
- `/compaction-clean` command: prune orphaned artifacts
- Workflow integration via `.pi/workflow-state.json` file convention and event bus
