import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { appendStats, readStats, formatTrend } from "./stats.js";
import type { CompactionStats } from "./types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeStats(overrides: Partial<CompactionStats> = {}): CompactionStats {
  return {
    timestamp: Date.now(),
    tokensBefore: 100000,
    summaryTokens: 4000,
    reassemblyTokens: 8000,
    reassemblyBudget: 12000,
    contextWindow: 200000,
    artifacts: {},
    totalExtractCost: { inputTokens: 0, outputTokens: 0 },
    specName: "default",
    specPath: ".pi/compaction/default.yaml",
    ...overrides,
  };
}

// --- appendStats / readStats ---

describe("appendStats and readStats", () => {
  it("appends and reads a single stat", () => {
    const stats = makeStats({ timestamp: 1000 });
    appendStats(tmpDir, stats);
    const result = readStats(tmpDir);
    assert.equal(result.length, 1);
    assert.equal(result[0].timestamp, 1000);
  });

  it("appends multiple stats", () => {
    appendStats(tmpDir, makeStats({ timestamp: 1 }));
    appendStats(tmpDir, makeStats({ timestamp: 2 }));
    appendStats(tmpDir, makeStats({ timestamp: 3 }));
    const result = readStats(tmpDir);
    assert.equal(result.length, 3);
    assert.deepEqual(
      result.map((s) => s.timestamp),
      [1, 2, 3],
    );
  });

  it("creates parent directories", () => {
    const nested = path.join(tmpDir, "a", "b");
    // The stats path is relative to cwd, so we need to set up properly
    appendStats(tmpDir, makeStats());
    const statsFile = path.join(tmpDir, ".pi", "session-state", "compaction-stats.jsonl");
    assert.ok(fs.existsSync(statsFile));
  });

  it("returns empty array for missing file", () => {
    const result = readStats(tmpDir);
    assert.deepEqual(result, []);
  });

  it("skips invalid JSON lines", () => {
    const statsFile = path.join(tmpDir, ".pi", "session-state", "compaction-stats.jsonl");
    fs.mkdirSync(path.dirname(statsFile), { recursive: true });
    const valid = makeStats({ timestamp: 42 });
    fs.writeFileSync(
      statsFile,
      `${JSON.stringify(valid)}\ninvalid json line\n${JSON.stringify(makeStats({ timestamp: 99 }))}\n`,
    );
    const result = readStats(tmpDir);
    assert.equal(result.length, 2);
    assert.equal(result[0].timestamp, 42);
    assert.equal(result[1].timestamp, 99);
  });

  it("handles empty lines gracefully", () => {
    const statsFile = path.join(tmpDir, ".pi", "session-state", "compaction-stats.jsonl");
    fs.mkdirSync(path.dirname(statsFile), { recursive: true });
    fs.writeFileSync(statsFile, `\n\n${JSON.stringify(makeStats({ timestamp: 1 }))}\n\n`);
    const result = readStats(tmpDir);
    assert.equal(result.length, 1);
  });
});

// --- formatTrend ---

describe("formatTrend", () => {
  it("returns 'no data' when no stats exist", () => {
    const result = formatTrend([], "corrections");
    assert.equal(result, "no data");
  });

  it("returns 'no data' when artifact not present in any stats", () => {
    const stats = [makeStats({ artifacts: { other: { path: "x", tokens: 100, sizeBytes: 400, strategy: "mechanical" } } })];
    const result = formatTrend(stats, "corrections");
    assert.equal(result, "no data");
  });

  it("shows stable for flat/decreasing values", () => {
    const stats = [
      makeStats({ artifacts: { corrections: { path: "c.json", tokens: 1900, sizeBytes: 7600, strategy: "mechanical" } } }),
      makeStats({ artifacts: { corrections: { path: "c.json", tokens: 2100, sizeBytes: 8400, strategy: "mechanical" } } }),
      makeStats({ artifacts: { corrections: { path: "c.json", tokens: 1800, sizeBytes: 7200, strategy: "mechanical" } } }),
    ];
    const result = formatTrend(stats, "corrections");
    assert.ok(result.includes("stable"), `Expected 'stable' in: ${result}`);
    assert.ok(!result.includes("⚠"), `Should not have warning in: ${result}`);
  });

  it("detects growing pattern (3+ consecutive increases)", () => {
    const stats = [
      makeStats({ artifacts: { corrections: { path: "c.json", tokens: 800, sizeBytes: 3200, strategy: "mechanical" } } }),
      makeStats({ artifacts: { corrections: { path: "c.json", tokens: 1400, sizeBytes: 5600, strategy: "mechanical" } } }),
      makeStats({ artifacts: { corrections: { path: "c.json", tokens: 2100, sizeBytes: 8400, strategy: "mechanical" } } }),
    ];
    const result = formatTrend(stats, "corrections");
    assert.ok(result.includes("⚠ growing"), `Expected '⚠ growing' in: ${result}`);
  });

  it("uses k suffix for large numbers", () => {
    const stats = [
      makeStats({ artifacts: { decisions: { path: "d.json", tokens: 1900, sizeBytes: 7600, strategy: "llm" } } }),
      makeStats({ artifacts: { decisions: { path: "d.json", tokens: 2100, sizeBytes: 8400, strategy: "llm" } } }),
    ];
    const result = formatTrend(stats, "decisions");
    assert.ok(result.includes("1.9k"), `Expected '1.9k' in: ${result}`);
    assert.ok(result.includes("2.1k"), `Expected '2.1k' in: ${result}`);
  });

  it("respects count parameter", () => {
    const stats = Array.from({ length: 10 }, (_, i) =>
      makeStats({
        artifacts: { a: { path: "a.json", tokens: (i + 1) * 100, sizeBytes: (i + 1) * 400, strategy: "mechanical" } },
      }),
    );
    const result = formatTrend(stats, "a", 3);
    // Should show last 3: 800, 900, 1000
    assert.ok(result.includes("→"), `Expected arrows in: ${result}`);
    // Count the arrows - should be 2 for 3 values
    const arrows = result.split("→").length - 1;
    assert.equal(arrows, 2, `Expected 2 arrows in: ${result}`);
  });

  it("shows numbers < 1000 without k suffix", () => {
    const stats = [
      makeStats({ artifacts: { x: { path: "x.json", tokens: 500, sizeBytes: 2000, strategy: "mechanical" } } }),
      makeStats({ artifacts: { x: { path: "x.json", tokens: 300, sizeBytes: 1200, strategy: "mechanical" } } }),
    ];
    const result = formatTrend(stats, "x");
    assert.ok(result.includes("500"), `Expected '500' in: ${result}`);
    assert.ok(result.includes("300"), `Expected '300' in: ${result}`);
  });

  it("shows growing for 4 consecutive increases", () => {
    const stats = [
      makeStats({ artifacts: { a: { path: "a.json", tokens: 100, sizeBytes: 400, strategy: "mechanical" } } }),
      makeStats({ artifacts: { a: { path: "a.json", tokens: 200, sizeBytes: 800, strategy: "mechanical" } } }),
      makeStats({ artifacts: { a: { path: "a.json", tokens: 300, sizeBytes: 1200, strategy: "mechanical" } } }),
      makeStats({ artifacts: { a: { path: "a.json", tokens: 400, sizeBytes: 1600, strategy: "mechanical" } } }),
    ];
    const result = formatTrend(stats, "a");
    assert.ok(result.includes("⚠ growing"), `Expected '⚠ growing' in: ${result}`);
  });

  it("stable when increase streak broken", () => {
    const stats = [
      makeStats({ artifacts: { a: { path: "a.json", tokens: 100, sizeBytes: 400, strategy: "mechanical" } } }),
      makeStats({ artifacts: { a: { path: "a.json", tokens: 200, sizeBytes: 800, strategy: "mechanical" } } }),
      makeStats({ artifacts: { a: { path: "a.json", tokens: 150, sizeBytes: 600, strategy: "mechanical" } } }),
      makeStats({ artifacts: { a: { path: "a.json", tokens: 300, sizeBytes: 1200, strategy: "mechanical" } } }),
    ];
    const result = formatTrend(stats, "a");
    assert.ok(result.includes("stable"), `Expected 'stable' in: ${result}`);
  });
});
