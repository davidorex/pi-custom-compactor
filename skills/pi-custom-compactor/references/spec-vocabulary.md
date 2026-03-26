# Spec Vocabulary

Extracted from seed specs. Defines the vocabulary of extract names, strategies, priorities, formats, and reassembly configurations available out of the box.

## Type Enums

| Type | Values |
|------|--------|
| Priority | `critical`, `high`, `normal` (default), `low` |
| Strategy | `mechanical`, `llm` |
| OverflowStrategy | `trim-lowest` (default), `truncate-all` |

## debugging

Budget: 10000 | Overflow: trim-lowest

### Extracts

| Name | Strategy | Priority | Caps | Description |
|------|----------|----------|------|-------------|
| `error-observations` | mechanical | high | maxEntries: 30 | Error messages, stack traces, and failure patterns observed |
| `hypotheses` | llm | critical | maxTokens: 2000 | Debugging hypotheses — what has been tried, ruled out, and what looks promising |
| `file-awareness` | mechanical | low | none | Files read, modified, and created during debugging |
| `reproduction-steps` | llm | high | maxTokens: 1500 | Steps to reproduce the issue being debugged |

### Format Schemas

**error-observations:**
```
Array of { timestamp: number, error: string, context: string }
```

**hypotheses:**
```
{ tried: Array<{ hypothesis: string, result: string }>, ruled_out: string[], promising: string[] }
```

**file-awareness:**
```
{ read: string[], modified: string[] }
```

**reproduction-steps:**
```
{ steps: string[], environment: string, triggers: string[] }
```

### Reassembly Sources

| Source | Label | Wrap Tag |
|--------|-------|----------|
| `.pi/session-state/debugging/hypotheses.json` | Debugging hypotheses (what has been tried and what is promising): | `<hypotheses>` |
| `.pi/session-state/debugging/errors.json` | Error observations: | `<error-observations>` |
| `.pi/session-state/debugging/reproduction.json` | Reproduction steps: | `<reproduction-steps>` |
| `.pi/session-state/debugging/files.json` | Files investigated: | `<file-context>` |

## default

Budget: 12000 | Overflow: trim-lowest

### Extracts

| Name | Strategy | Priority | Caps | Description |
|------|----------|----------|------|-------------|
| `user-corrections` | mechanical | high | maxEntries: 50 | User corrections, redirects, and stated preferences |
| `decisions` | llm | high | maxTokens: 2000 | Architectural decisions with rationale |
| `file-awareness` | mechanical | low | none | Files read, modified, and created during the session |
| `task-state` | llm | critical | maxTokens: 2000 | Current goal, progress, blockers, and next steps |

### Format Schemas

**user-corrections:**
```
Array of { timestamp: number, correction: string, context: string }
```

**decisions:**
```
Array of { decision: string, rationale: string, files_affected: string[] }
```

**file-awareness:**
```
{ read: string[], modified: string[] }
```

**task-state:**
```
{ goal: string, constraints: string[], done: string[], in_progress: string[], blocked: string[], next_steps: string[] }
```

### Reassembly Sources

| Source | Label | Wrap Tag |
|--------|-------|----------|
| `.pi/session-state/task.json` | Task state: | `<task-state>` |
| `.pi/session-state/corrections.json` | User corrections and preferences (must be honored): | `<user-corrections>` |
| `.pi/session-state/decisions.json` | Architectural decisions made: | `<decisions>` |
| `.pi/session-state/files.json` | Files touched: | `<file-context>` |

## implementing

Budget: 12000 | Overflow: trim-lowest

### Extracts

| Name | Strategy | Priority | Caps | Description |
|------|----------|----------|------|-------------|
| `task-state` | llm | critical | maxTokens: 2000 | Current implementation goal, progress, blockers, and next steps |
| `decisions` | llm | high | maxTokens: 2000 | Design and architectural decisions with rationale |
| `api-contracts` | llm | high | maxTokens: 1500 | API interfaces, type signatures, and contracts defined or modified |
| `user-corrections` | mechanical | high | maxEntries: 30 | User corrections and stated preferences |
| `file-awareness` | mechanical | low | none | Files read, modified, and created |

### Format Schemas

**task-state:**
```
{ goal: string, constraints: string[], done: string[], in_progress: string[], blocked: string[], next_steps: string[] }
```

**decisions:**
```
Array of { decision: string, rationale: string, alternatives_considered: string[], files_affected: string[] }
```

**api-contracts:**
```
Array of { name: string, type: string, signature: string, file: string }
```

**user-corrections:**
```
Array of { timestamp: number, correction: string, context: string }
```

**file-awareness:**
```
{ read: string[], modified: string[] }
```

### Reassembly Sources

| Source | Label | Wrap Tag |
|--------|-------|----------|
| `.pi/session-state/implementing/task.json` | Implementation progress: | `<task-state>` |
| `.pi/session-state/implementing/decisions.json` | Design decisions made: | `<decisions>` |
| `.pi/session-state/implementing/api-contracts.json` | API contracts defined: | `<api-contracts>` |
| `.pi/session-state/implementing/corrections.json` | User corrections (must be honored): | `<user-corrections>` |
| `.pi/session-state/implementing/files.json` | Files touched: | `<file-context>` |

## reviewing

Budget: 10000 | Overflow: trim-lowest

### Extracts

| Name | Strategy | Priority | Caps | Description |
|------|----------|----------|------|-------------|
| `findings` | llm | critical | maxTokens: 3000 | Code review findings with severity and location |
| `patterns` | llm | high | maxTokens: 1500 | Recurring patterns or anti-patterns observed across files |
| `file-awareness` | mechanical | low | none | Files reviewed |

### Format Schemas

**findings:**
```
Array of { severity: string, file: string, line: number | null, finding: string, suggestion: string }
```

**patterns:**
```
Array of { pattern: string, occurrences: string[], recommendation: string }
```

**file-awareness:**
```
{ read: string[], modified: string[] }
```

### Reassembly Sources

| Source | Label | Wrap Tag |
|--------|-------|----------|
| `.pi/session-state/reviewing/findings.json` | Review findings: | `<findings>` |
| `.pi/session-state/reviewing/patterns.json` | Observed patterns: | `<patterns>` |
| `.pi/session-state/reviewing/files.json` | Files reviewed: | `<file-context>` |
