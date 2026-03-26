# Changelog

All notable changes to this project will be documented in this file.

## v0.1.5

[compare changes](https://github.com/davidorex/pi-custom-compactor/compare/v0.1.4...v0.1.5)

### 🩹 Fixes

- PickSummarizationModel now checks API key before selecting candidate ([22eb616](https://github.com/davidorex/pi-custom-compactor/commit/22eb616))

### ❤️ Contributors

- David Ryan <davidryan@gmail.com>

## v0.1.4

[compare changes](https://github.com/davidorex/pi-custom-compactor/compare/v0.1.3...v0.1.4)

### 🚀 Enhancements

- Add compaction_dry_run tool for LLM-invocable dry-run + inject command output into LLM context ([b1f3d21](https://github.com/davidorex/pi-custom-compactor/commit/b1f3d21))

### ❤️ Contributors

- David Ryan <davidryan@gmail.com>

## v0.1.3

[compare changes](https://github.com/davidorex/pi-custom-compactor/compare/v0.1.2...v0.1.3)

### 🚀 Enhancements

- Add /compaction-dry-run command for previewing compaction output ([12a5126](https://github.com/davidorex/pi-custom-compactor/commit/12a5126))

### ❤️ Contributors

- David Ryan <davidryan@gmail.com>

## v0.1.2

[compare changes](https://github.com/davidorex/pi-custom-compactor/compare/v0.1.1...v0.1.2)

### ✨ Features

- Auto-generated SKILL.md via build-time introspection of extension registrations ([ff09022](https://github.com/davidorex/pi-custom-compactor/commit/ff09022))
  - `scripts/generate-skills.ts` introspects extension factory with mock pi, parses seed YAML vocabulary, splices hand-authored `skill-narrative.md`
  - Generates `skills/pi-custom-compactor/SKILL.md` with XML-tagged sections, activation-first description
  - Reference files: `bundled-resources.md`, `spec-vocabulary.md` with per-spec extract tables and format schemas
  - `package.json`: added `pi.skills`, `generate-skills` script, `skills/` in files array

### 🩹 Fixes

- Add `session_tree` handler to reset stale `activeSpecOverride` on branch navigation ([dcd8c28](https://github.com/davidorex/pi-custom-compactor/commit/dcd8c28))
- Extract `resolveSpecWithOverride()` shared helper, eliminating duplicate 13-line IIFEs in `session_before_compact` and `context` hooks ([dcd8c28](https://github.com/davidorex/pi-custom-compactor/commit/dcd8c28))

### 🏡 Chore

- Add .claude/, .project/, .workflows/ to gitignore ([484ef66](https://github.com/davidorex/pi-custom-compactor/commit/484ef66))

### ❤️ Contributors

- David Ryan <davidryan@gmail.com>

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
