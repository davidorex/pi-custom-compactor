import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  readArtifact,
  writeArtifact,
  mergeArtifact,
  enforceMaxTokens,
  enforceMaxEntries,
} from "./artifacts.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifacts-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- readArtifact ---

describe("readArtifact", () => {
  it("reads valid JSON", () => {
    const filePath = path.join(tmpDir, "data.json");
    fs.writeFileSync(filePath, '{"foo": "bar"}');
    const result = readArtifact(filePath);
    assert.deepEqual(result, { foo: "bar" });
  });

  it("returns null for missing file", () => {
    const result = readArtifact(path.join(tmpDir, "nope.json"));
    assert.equal(result, null);
  });

  it("returns null for invalid JSON", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "not json {{{");
    const result = readArtifact(filePath);
    assert.equal(result, null);
  });

  it("reads arrays", () => {
    const filePath = path.join(tmpDir, "arr.json");
    fs.writeFileSync(filePath, '[1, 2, 3]');
    const result = readArtifact(filePath);
    assert.deepEqual(result, [1, 2, 3]);
  });
});

// --- writeArtifact ---

describe("writeArtifact", () => {
  it("writes JSON with 2-space indent", () => {
    const filePath = path.join(tmpDir, "out.json");
    writeArtifact(filePath, { a: 1 });
    const content = fs.readFileSync(filePath, "utf-8");
    assert.equal(content, '{\n  "a": 1\n}');
  });

  it("creates parent directories", () => {
    const filePath = path.join(tmpDir, "deep", "nested", "dir", "data.json");
    writeArtifact(filePath, [1, 2]);
    const result = readArtifact(filePath);
    assert.deepEqual(result, [1, 2]);
  });
});

// --- mergeArtifact ---

describe("mergeArtifact", () => {
  it("returns incoming when existing is null", () => {
    const result = mergeArtifact(null, [1, 2]);
    assert.deepEqual(result, [1, 2]);
  });

  it("concatenates arrays", () => {
    const result = mergeArtifact([1, 2], [3, 4]);
    assert.deepEqual(result, [1, 2, 3, 4]);
  });

  it("concatenates arrays of objects", () => {
    const result = mergeArtifact(
      [{ text: "a" }],
      [{ text: "b" }],
    );
    assert.deepEqual(result, [{ text: "a" }, { text: "b" }]);
  });

  it("merges objects with array values (set dedup)", () => {
    const existing = { read: ["a.ts", "b.ts"], modified: ["c.ts"] };
    const incoming = { read: ["b.ts", "d.ts"], modified: ["c.ts", "e.ts"] };
    const result = mergeArtifact(existing, incoming);
    assert.deepEqual(result, {
      read: ["a.ts", "b.ts", "d.ts"],
      modified: ["c.ts", "e.ts"],
    });
  });

  it("handles objects with disjoint keys", () => {
    const existing = { read: ["a.ts"] };
    const incoming = { modified: ["b.ts"] };
    const result = mergeArtifact(existing, incoming);
    assert.deepEqual(result, {
      read: ["a.ts"],
      modified: ["b.ts"],
    });
  });

  it("overwrites when types differ (existing array, incoming object)", () => {
    const result = mergeArtifact([1, 2], { key: "val" });
    assert.deepEqual(result, { key: "val" });
  });

  it("overwrites when existing is a scalar", () => {
    const result = mergeArtifact("old", "new");
    assert.equal(result, "new");
  });

  it("overwrites when objects have non-array values", () => {
    const result = mergeArtifact({ a: 1 }, { a: 2 });
    assert.deepEqual(result, { a: 2 });
  });
});

// --- enforceMaxTokens ---

describe("enforceMaxTokens", () => {
  it("returns unchanged when under budget", () => {
    const data = ["a", "b"];
    const { data: result, trimmed } = enforceMaxTokens(data, 10000);
    assert.deepEqual(result, ["a", "b"]);
    assert.equal(trimmed, false);
  });

  it("trims oldest entries to fit budget", () => {
    // Create array where each entry is sizable
    const entries = Array.from({ length: 20 }, (_, i) => `entry-${i}-${"x".repeat(100)}`);
    const { data: result, trimmed } = enforceMaxTokens(entries, 200);
    assert.equal(trimmed, true);
    assert.ok(Array.isArray(result));
    // Result should fit within budget
    const tokens = Math.ceil(JSON.stringify(result).length / 4);
    assert.ok(tokens <= 200, `Expected <= 200 tokens, got ${tokens}`);
    // Should keep later entries (newest)
    if ((result as string[]).length > 0) {
      const last = (result as string[])[(result as string[]).length - 1];
      assert.ok(last.startsWith("entry-"), "Should keep entries from end");
    }
  });

  it("returns non-array data unchanged", () => {
    const { data, trimmed } = enforceMaxTokens({ key: "val" }, 10);
    assert.deepEqual(data, { key: "val" });
    assert.equal(trimmed, false);
  });

  it("handles empty array", () => {
    const { data, trimmed } = enforceMaxTokens([], 10);
    assert.deepEqual(data, []);
    assert.equal(trimmed, false);
  });

  it("can trim all entries if none fit", () => {
    const entries = ["x".repeat(400)]; // ~100 tokens for one entry
    const { data: result, trimmed } = enforceMaxTokens(entries, 1);
    assert.deepEqual(result, []);
    assert.equal(trimmed, true);
  });
});

// --- enforceMaxEntries ---

describe("enforceMaxEntries", () => {
  it("returns unchanged when under limit", () => {
    const { data, trimmed } = enforceMaxEntries([1, 2, 3], 5);
    assert.deepEqual(data, [1, 2, 3]);
    assert.equal(trimmed, false);
  });

  it("keeps last N entries", () => {
    const { data, trimmed } = enforceMaxEntries([1, 2, 3, 4, 5], 3);
    assert.deepEqual(data, [3, 4, 5]);
    assert.equal(trimmed, true);
  });

  it("returns non-array data unchanged", () => {
    const { data, trimmed } = enforceMaxEntries("hello", 3);
    assert.equal(data, "hello");
    assert.equal(trimmed, false);
  });

  it("handles exact limit", () => {
    const { data, trimmed } = enforceMaxEntries([1, 2, 3], 3);
    assert.deepEqual(data, [1, 2, 3]);
    assert.equal(trimmed, false);
  });

  it("keeps 1 entry when maxEntries is 1", () => {
    const { data, trimmed } = enforceMaxEntries([1, 2, 3], 1);
    assert.deepEqual(data, [3]);
    assert.equal(trimmed, true);
  });
});
