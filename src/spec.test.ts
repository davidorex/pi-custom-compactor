import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseAndValidateSpec,
  resolveSpec,
  listSpecFiles,
  resolveActiveSpecName,
  writeActivePointer,
  resolveArtifactPath,
  loadAndValidateSpec,
} from "./spec.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "compactor-test-"));
}

function writeFile(base: string, relPath: string, content: string): void {
  const full = path.join(base, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
}

const MINIMAL_SPEC = `
extracts:
  task-state:
    description: Current task state
    persist: .pi/session-state/task.json
    format: "{ goal: string }"
    strategy: llm
`;

const FULL_SPEC = `
extracts:
  corrections:
    description: User corrections
    persist: .pi/session-state/corrections.json
    format: "Array of { text: string }"
    strategy: mechanical
    maxEntries: 50
    maxTokens: 4000
    priority: high
  task-state:
    description: Current task state
    persist: .pi/session-state/task.json
    format: "{ goal: string }"
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
      as: "Corrections:"
      wrap: corrections
`;

// --- parseAndValidateSpec ---

describe("parseAndValidateSpec", () => {
  it("parses a minimal spec", () => {
    const spec = parseAndValidateSpec(MINIMAL_SPEC);
    assert.ok(spec.extracts["task-state"]);
    assert.equal(spec.extracts["task-state"].strategy, "llm");
    assert.equal(spec.extracts["task-state"].persist, ".pi/session-state/task.json");
    assert.equal(spec.reassemble, undefined);
  });

  it("parses a full spec with reassemble", () => {
    const spec = parseAndValidateSpec(FULL_SPEC);
    assert.equal(Object.keys(spec.extracts).length, 2);
    assert.equal(spec.extracts["corrections"].maxEntries, 50);
    assert.equal(spec.extracts["corrections"].maxTokens, 4000);
    assert.equal(spec.extracts["corrections"].priority, "high");
    assert.equal(spec.extracts["task-state"].priority, "critical");
    assert.ok(spec.reassemble);
    assert.equal(spec.reassemble!.budget, 12000);
    assert.equal(spec.reassemble!.overflow, "trim-lowest");
    assert.equal(spec.reassemble!.sources.length, 2);
    assert.equal(spec.reassemble!.sources[0].wrap, "task-state");
  });

  it("rejects missing extracts", () => {
    assert.throws(() => parseAndValidateSpec("reassemble: {}"), /extracts/);
  });

  it("rejects empty document", () => {
    assert.throws(() => parseAndValidateSpec(""), /object/);
  });

  it("rejects invalid strategy", () => {
    const yaml = `
extracts:
  x:
    description: test
    persist: test.json
    format: "{}"
    strategy: magic
`;
    assert.throws(() => parseAndValidateSpec(yaml), /strategy.*magic/);
  });

  it("rejects invalid priority", () => {
    const yaml = `
extracts:
  x:
    description: test
    persist: test.json
    format: "{}"
    strategy: llm
    priority: ultra
`;
    assert.throws(() => parseAndValidateSpec(yaml), /priority.*ultra/);
  });

  it("rejects invalid overflow", () => {
    const yaml = `
extracts:
  x:
    description: test
    persist: test.json
    format: "{}"
    strategy: llm
reassemble:
  overflow: explode
  sources: []
`;
    assert.throws(() => parseAndValidateSpec(yaml), /overflow/);
  });

  it("rejects missing required fields on extract", () => {
    assert.throws(() => parseAndValidateSpec(`
extracts:
  x:
    description: test
    persist: test.json
    strategy: llm
`), /format/);
  });

  it("rejects non-positive maxTokens", () => {
    assert.throws(() => parseAndValidateSpec(`
extracts:
  x:
    description: test
    persist: test.json
    format: "{}"
    strategy: llm
    maxTokens: -1
`), /maxTokens/);
  });

  it("rejects non-positive maxEntries", () => {
    assert.throws(() => parseAndValidateSpec(`
extracts:
  x:
    description: test
    persist: test.json
    format: "{}"
    strategy: mechanical
    maxEntries: 0
`), /maxEntries/);
  });

  it("rejects reassemble without sources array", () => {
    assert.throws(() => parseAndValidateSpec(`
extracts:
  x:
    description: test
    persist: test.json
    format: "{}"
    strategy: llm
reassemble:
  budget: 5000
`), /sources.*array/);
  });

  it("rejects reassemble source missing fields", () => {
    assert.throws(() => parseAndValidateSpec(`
extracts:
  x:
    description: test
    persist: test.json
    format: "{}"
    strategy: llm
reassemble:
  sources:
    - source: test.json
      as: "Test:"
`), /wrap/);
  });

  it("accepts reassemble with truncate-all overflow", () => {
    const spec = parseAndValidateSpec(`
extracts:
  x:
    description: test
    persist: test.json
    format: "{}"
    strategy: llm
reassemble:
  overflow: truncate-all
  sources: []
`);
    assert.equal(spec.reassemble!.overflow, "truncate-all");
  });
});

// --- resolveSpec ---

describe("resolveSpec", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no spec exists", () => {
    assert.equal(resolveSpec(tmpDir), null);
  });

  it("resolves flat file .pi/compaction.yaml", () => {
    writeFile(tmpDir, ".pi/compaction.yaml", MINIMAL_SPEC);
    const result = resolveSpec(tmpDir);
    assert.ok(result);
    assert.equal(result!.name, "compaction");
    assert.ok(result!.spec.extracts["task-state"]);
  });

  it("resolves .pi/compaction/default.yaml", () => {
    writeFile(tmpDir, ".pi/compaction/default.yaml", MINIMAL_SPEC);
    const result = resolveSpec(tmpDir);
    assert.ok(result);
    assert.equal(result!.name, "default");
  });

  it("default.yaml takes precedence over flat file", () => {
    writeFile(tmpDir, ".pi/compaction.yaml", MINIMAL_SPEC);
    writeFile(tmpDir, ".pi/compaction/default.yaml", FULL_SPEC);
    const result = resolveSpec(tmpDir);
    assert.ok(result);
    assert.equal(result!.name, "default");
    assert.equal(Object.keys(result!.spec.extracts).length, 2);
  });

  it("resolves via active pointer", () => {
    writeFile(tmpDir, ".pi/compaction/debugging.yaml", FULL_SPEC);
    writeFile(tmpDir, ".pi/compaction/active", "debugging");
    const result = resolveSpec(tmpDir);
    assert.ok(result);
    assert.equal(result!.name, "debugging");
  });

  it("active pointer takes precedence over default", () => {
    writeFile(tmpDir, ".pi/compaction/default.yaml", MINIMAL_SPEC);
    writeFile(tmpDir, ".pi/compaction/implementing.yaml", FULL_SPEC);
    writeFile(tmpDir, ".pi/compaction/active", "implementing");
    const result = resolveSpec(tmpDir);
    assert.ok(result);
    assert.equal(result!.name, "implementing");
  });

  it("resolves via workflow-state.json", () => {
    writeFile(tmpDir, ".pi/workflow-state.json", JSON.stringify({ compactionSpec: "debugging" }));
    writeFile(tmpDir, ".pi/compaction/debugging.yaml", FULL_SPEC);
    const result = resolveSpec(tmpDir);
    assert.ok(result);
    assert.equal(result!.name, "debugging");
  });

  it("workflow-state takes precedence over active pointer", () => {
    writeFile(tmpDir, ".pi/workflow-state.json", JSON.stringify({ compactionSpec: "reviewing" }));
    writeFile(tmpDir, ".pi/compaction/reviewing.yaml", MINIMAL_SPEC);
    writeFile(tmpDir, ".pi/compaction/active", "debugging");
    writeFile(tmpDir, ".pi/compaction/debugging.yaml", FULL_SPEC);
    const result = resolveSpec(tmpDir);
    assert.ok(result);
    assert.equal(result!.name, "reviewing");
  });

  it("falls through when workflow-state spec file is missing", () => {
    writeFile(tmpDir, ".pi/workflow-state.json", JSON.stringify({ compactionSpec: "nonexistent" }));
    writeFile(tmpDir, ".pi/compaction/default.yaml", MINIMAL_SPEC);
    const result = resolveSpec(tmpDir);
    assert.ok(result);
    assert.equal(result!.name, "default");
  });

  it("falls through when active pointer spec file is missing", () => {
    writeFile(tmpDir, ".pi/compaction/active", "nonexistent");
    writeFile(tmpDir, ".pi/compaction/default.yaml", MINIMAL_SPEC);
    const result = resolveSpec(tmpDir);
    assert.ok(result);
    assert.equal(result!.name, "default");
  });

  it("falls through when workflow-state.json is invalid JSON", () => {
    writeFile(tmpDir, ".pi/workflow-state.json", "not json{{{");
    writeFile(tmpDir, ".pi/compaction/default.yaml", MINIMAL_SPEC);
    const result = resolveSpec(tmpDir);
    assert.ok(result);
    assert.equal(result!.name, "default");
  });

  it("falls through when workflow-state has no compactionSpec field", () => {
    writeFile(tmpDir, ".pi/workflow-state.json", JSON.stringify({ activeWorkflow: "something" }));
    writeFile(tmpDir, ".pi/compaction/default.yaml", MINIMAL_SPEC);
    const result = resolveSpec(tmpDir);
    assert.ok(result);
    assert.equal(result!.name, "default");
  });

  it("skips invalid YAML spec files gracefully", () => {
    writeFile(tmpDir, ".pi/compaction/default.yaml", "not: valid: yaml: [[[");
    writeFile(tmpDir, ".pi/compaction.yaml", MINIMAL_SPEC);
    const result = resolveSpec(tmpDir);
    assert.ok(result);
    assert.equal(result!.name, "compaction");
  });
});

// --- listSpecFiles ---

describe("listSpecFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no .pi/compaction dir", () => {
    assert.deepEqual(listSpecFiles(tmpDir), []);
  });

  it("lists yaml files without extension", () => {
    writeFile(tmpDir, ".pi/compaction/default.yaml", MINIMAL_SPEC);
    writeFile(tmpDir, ".pi/compaction/debugging.yaml", MINIMAL_SPEC);
    writeFile(tmpDir, ".pi/compaction/implementing.yaml", MINIMAL_SPEC);
    writeFile(tmpDir, ".pi/compaction/active", "debugging");
    const names = listSpecFiles(tmpDir);
    assert.deepEqual(names, ["debugging", "default", "implementing"]);
  });

  it("ignores non-yaml files", () => {
    writeFile(tmpDir, ".pi/compaction/notes.txt", "hello");
    writeFile(tmpDir, ".pi/compaction/default.yaml", MINIMAL_SPEC);
    const names = listSpecFiles(tmpDir);
    assert.deepEqual(names, ["default"]);
  });
});

// --- resolveActiveSpecName ---

describe("resolveActiveSpecName", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when nothing exists", () => {
    assert.equal(resolveActiveSpecName(tmpDir), null);
  });

  it("returns name from workflow-state", () => {
    writeFile(tmpDir, ".pi/workflow-state.json", JSON.stringify({ compactionSpec: "debugging" }));
    assert.equal(resolveActiveSpecName(tmpDir), "debugging");
  });

  it("returns name from active pointer", () => {
    writeFile(tmpDir, ".pi/compaction/active", "implementing");
    assert.equal(resolveActiveSpecName(tmpDir), "implementing");
  });

  it("returns 'default' when default.yaml exists", () => {
    writeFile(tmpDir, ".pi/compaction/default.yaml", MINIMAL_SPEC);
    assert.equal(resolveActiveSpecName(tmpDir), "default");
  });

  it("returns 'compaction' for flat file", () => {
    writeFile(tmpDir, ".pi/compaction.yaml", MINIMAL_SPEC);
    assert.equal(resolveActiveSpecName(tmpDir), "compaction");
  });

  it("workflow-state takes precedence", () => {
    writeFile(tmpDir, ".pi/workflow-state.json", JSON.stringify({ compactionSpec: "reviewing" }));
    writeFile(tmpDir, ".pi/compaction/active", "debugging");
    assert.equal(resolveActiveSpecName(tmpDir), "reviewing");
  });
});

// --- writeActivePointer ---

describe("writeActivePointer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates .pi/compaction/active file", () => {
    writeActivePointer(tmpDir, "debugging");
    const content = fs.readFileSync(path.join(tmpDir, ".pi", "compaction", "active"), "utf-8");
    assert.equal(content, "debugging");
  });

  it("overwrites existing pointer", () => {
    writeActivePointer(tmpDir, "debugging");
    writeActivePointer(tmpDir, "implementing");
    const content = fs.readFileSync(path.join(tmpDir, ".pi", "compaction", "active"), "utf-8");
    assert.equal(content, "implementing");
  });

  it("creates directories if they don't exist", () => {
    writeActivePointer(tmpDir, "test");
    assert.ok(fs.existsSync(path.join(tmpDir, ".pi", "compaction", "active")));
  });
});

// --- resolveArtifactPath ---

describe("resolveArtifactPath", () => {
  it("resolves relative path against cwd", () => {
    const result = resolveArtifactPath(".pi/session-state/task.json", "/home/user/project");
    assert.equal(result, path.join("/home/user/project", ".pi/session-state/task.json"));
  });

  it("returns absolute path unchanged", () => {
    const result = resolveArtifactPath("/tmp/artifact.json", "/home/user/project");
    assert.equal(result, "/tmp/artifact.json");
  });
});

// --- loadAndValidateSpec ---

describe("loadAndValidateSpec", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for nonexistent file", () => {
    assert.equal(loadAndValidateSpec(path.join(tmpDir, "nope.yaml")), null);
  });

  it("returns null for invalid YAML", () => {
    const p = path.join(tmpDir, "bad.yaml");
    fs.writeFileSync(p, "extracts: [invalid", "utf-8");
    assert.equal(loadAndValidateSpec(p), null);
  });

  it("returns parsed spec for valid file", () => {
    const p = path.join(tmpDir, "good.yaml");
    fs.writeFileSync(p, MINIMAL_SPEC, "utf-8");
    const spec = loadAndValidateSpec(p);
    assert.ok(spec);
    assert.ok(spec!.extracts["task-state"]);
  });
});
