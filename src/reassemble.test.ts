import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  readReassemblyArtifacts,
  enforceBudget,
  buildArtifactMessages,
  buildStatsSummary,
  composeSummary,
} from "./reassemble.js";
import type { ReassembledArtifact } from "./reassemble.js";
import { appendStats } from "./stats.js";
import type { CompactionSpec, CompactionStats, Priority } from "./types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reassemble-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- helpers ---

function makeSpec(overrides: Partial<CompactionSpec> = {}): CompactionSpec {
  return {
    extracts: {
      "task-state": {
        description: "Task state",
        persist: ".pi/session-state/task.json",
        format: "object",
        strategy: "llm",
        priority: "critical",
      },
      corrections: {
        description: "User corrections",
        persist: ".pi/session-state/corrections.json",
        format: "array",
        strategy: "mechanical",
        priority: "high",
      },
      decisions: {
        description: "Decisions",
        persist: ".pi/session-state/decisions.json",
        format: "array",
        strategy: "llm",
        priority: "normal",
      },
      files: {
        description: "File ops",
        persist: ".pi/session-state/files.json",
        format: "object",
        strategy: "mechanical",
        priority: "low",
      },
    },
    reassemble: {
      budget: 12000,
      overflow: "trim-lowest",
      sources: [
        {
          source: ".pi/session-state/task.json",
          as: "Task state:",
          wrap: "task-state",
        },
        {
          source: ".pi/session-state/corrections.json",
          as: "User corrections and preferences (must be honored):",
          wrap: "user-corrections",
        },
        {
          source: ".pi/session-state/decisions.json",
          as: "Architectural decisions made:",
          wrap: "decisions",
        },
        {
          source: ".pi/session-state/files.json",
          as: "Files touched:",
          wrap: "file-context",
        },
      ],
    },
    ...overrides,
  };
}

function writeArtifactFile(relativePath: string, data: unknown): void {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), "utf-8");
}

function makeArtifact(
  overrides: Partial<ReassembledArtifact> = {},
): ReassembledArtifact {
  const data = overrides.data ?? JSON.stringify({ goal: "test" });
  return {
    source: ".pi/session-state/task.json",
    as: "Task state:",
    wrap: "task-state",
    data,
    tokens: Math.ceil(data.length / 4),
    priority: "normal" as Priority,
    ...overrides,
  };
}

function makeStats(
  overrides: Partial<CompactionStats> = {},
): CompactionStats {
  return {
    timestamp: Date.now(),
    tokensBefore: 142000,
    summaryTokens: 4200,
    reassemblyTokens: 8700,
    reassemblyBudget: 12000,
    contextWindow: 200000,
    artifacts: {},
    totalExtractCost: { inputTokens: 6400, outputTokens: 3200 },
    specName: "default",
    specPath: ".pi/compaction/default.yaml",
    ...overrides,
  };
}

// --- readReassemblyArtifacts ---

describe("readReassemblyArtifacts", () => {
  it("reads all existing artifacts with correct priorities", () => {
    const spec = makeSpec();
    writeArtifactFile(".pi/session-state/task.json", { goal: "implement" });
    writeArtifactFile(".pi/session-state/corrections.json", [
      "use tabs",
    ]);
    writeArtifactFile(".pi/session-state/decisions.json", [
      { decision: "use React" },
    ]);
    writeArtifactFile(".pi/session-state/files.json", {
      read: ["a.ts"],
      modified: [],
    });

    const artifacts = readReassemblyArtifacts(spec, tmpDir);

    assert.equal(artifacts.length, 4);
    assert.equal(artifacts[0].priority, "critical"); // task-state
    assert.equal(artifacts[1].priority, "high"); // corrections
    assert.equal(artifacts[2].priority, "normal"); // decisions
    assert.equal(artifacts[3].priority, "low"); // files
    assert.equal(artifacts[0].wrap, "task-state");
    assert.equal(artifacts[1].wrap, "user-corrections");
  });

  it("skips missing artifacts", () => {
    const spec = makeSpec();
    writeArtifactFile(".pi/session-state/task.json", { goal: "test" });
    // Don't create corrections, decisions, files

    const artifacts = readReassemblyArtifacts(spec, tmpDir);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].source, ".pi/session-state/task.json");
  });

  it("returns empty array when no reassemble section", () => {
    const spec: CompactionSpec = {
      extracts: {},
    };
    const artifacts = readReassemblyArtifacts(spec, tmpDir);
    assert.deepEqual(artifacts, []);
  });

  it("defaults priority to normal for unknown sources", () => {
    const spec: CompactionSpec = {
      extracts: {},
      reassemble: {
        sources: [
          { source: ".pi/session-state/unknown.json", as: "Unknown:", wrap: "unknown" },
        ],
      },
    };
    writeArtifactFile(".pi/session-state/unknown.json", { data: "test" });

    const artifacts = readReassemblyArtifacts(spec, tmpDir);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].priority, "normal");
  });

  it("estimates tokens correctly", () => {
    const spec = makeSpec();
    const data = { goal: "implement feature X" };
    writeArtifactFile(".pi/session-state/task.json", data);

    const artifacts = readReassemblyArtifacts(spec, tmpDir);
    const expectedContent = JSON.stringify(data, null, 2);
    const expectedTokens = Math.ceil(expectedContent.length / 4);
    assert.equal(artifacts[0].tokens, expectedTokens);
    assert.equal(artifacts[0].data, expectedContent);
  });
});

// --- enforceBudget ---

describe("enforceBudget", () => {
  it("returns unchanged when no budget set", () => {
    const artifacts = [makeArtifact({ tokens: 5000 })];
    const result = enforceBudget(artifacts, undefined);
    assert.equal(result.artifacts.length, 1);
    assert.deepEqual(result.dropped, []);
  });

  it("returns unchanged when under budget", () => {
    const artifacts = [
      makeArtifact({ tokens: 3000, source: "a.json" }),
      makeArtifact({ tokens: 2000, source: "b.json" }),
    ];
    const result = enforceBudget(artifacts, 10000);
    assert.equal(result.artifacts.length, 2);
    assert.deepEqual(result.dropped, []);
  });

  it("returns unchanged when exactly at budget", () => {
    const artifacts = [
      makeArtifact({ tokens: 5000, source: "a.json" }),
      makeArtifact({ tokens: 5000, source: "b.json" }),
    ];
    const result = enforceBudget(artifacts, 10000);
    assert.equal(result.artifacts.length, 2);
    assert.deepEqual(result.dropped, []);
  });

  describe("trim-lowest", () => {
    it("drops lowest priority first", () => {
      const artifacts = [
        makeArtifact({ tokens: 3000, source: "critical.json", priority: "critical" }),
        makeArtifact({ tokens: 3000, source: "high.json", priority: "high" }),
        makeArtifact({ tokens: 3000, source: "normal.json", priority: "normal" }),
        makeArtifact({ tokens: 3000, source: "low.json", priority: "low" }),
      ];
      // Budget 9000 → need to drop 3000 → drop low
      const result = enforceBudget(artifacts, 9000, "trim-lowest");
      assert.equal(result.artifacts.length, 3);
      assert.deepEqual(result.dropped, ["low.json"]);
      assert.ok(result.artifacts.every((a) => a.source !== "low.json"));
    });

    it("drops multiple low priority artifacts", () => {
      const artifacts = [
        makeArtifact({ tokens: 3000, source: "critical.json", priority: "critical" }),
        makeArtifact({ tokens: 3000, source: "normal.json", priority: "normal" }),
        makeArtifact({ tokens: 3000, source: "low1.json", priority: "low" }),
        makeArtifact({ tokens: 3000, source: "low2.json", priority: "low" }),
      ];
      // Budget 6000 → need to drop 6000 → drop both low
      const result = enforceBudget(artifacts, 6000, "trim-lowest");
      assert.equal(result.artifacts.length, 2);
      assert.ok(result.dropped.includes("low1.json"));
      assert.ok(result.dropped.includes("low2.json"));
    });

    it("never drops critical artifacts", () => {
      const artifacts = [
        makeArtifact({ tokens: 5000, source: "c1.json", priority: "critical" }),
        makeArtifact({ tokens: 5000, source: "c2.json", priority: "critical" }),
      ];
      // Budget 3000 — all critical, can't drop any
      const result = enforceBudget(artifacts, 3000, "trim-lowest");
      assert.equal(result.artifacts.length, 2);
      assert.deepEqual(result.dropped, []);
    });

    it("keeps everything if dropping non-critical still over budget", () => {
      const artifacts = [
        makeArtifact({ tokens: 8000, source: "critical.json", priority: "critical" }),
        makeArtifact({ tokens: 1000, source: "low.json", priority: "low" }),
      ];
      // Budget 5000 — drop low (7000 total still > 5000 but critical can't be dropped)
      // Actually after dropping low, we have 8000 which is > 5000 but that's all critical
      const result = enforceBudget(artifacts, 5000, "trim-lowest");
      assert.equal(result.artifacts.length, 1);
      assert.deepEqual(result.dropped, ["low.json"]);
      // The remaining critical artifact exceeds budget but isn't dropped
      assert.equal(result.artifacts[0].source, "critical.json");
    });

    it("drops in priority order: low → normal → high", () => {
      const artifacts = [
        makeArtifact({ tokens: 2000, source: "critical.json", priority: "critical" }),
        makeArtifact({ tokens: 2000, source: "high.json", priority: "high" }),
        makeArtifact({ tokens: 2000, source: "normal.json", priority: "normal" }),
        makeArtifact({ tokens: 2000, source: "low.json", priority: "low" }),
      ];
      // Budget 4000 → need to drop 4000 → drop low then normal
      const result = enforceBudget(artifacts, 4000, "trim-lowest");
      assert.equal(result.artifacts.length, 2);
      assert.ok(result.dropped.includes("low.json"));
      assert.ok(result.dropped.includes("normal.json"));
      assert.ok(result.artifacts.some((a) => a.source === "critical.json"));
      assert.ok(result.artifacts.some((a) => a.source === "high.json"));
    });
  });

  describe("truncate-all", () => {
    it("proportionally truncates non-critical artifacts", () => {
      const longData = "x".repeat(4000); // 1000 tokens
      const artifacts = [
        makeArtifact({
          tokens: 1000,
          source: "critical.json",
          priority: "critical",
          data: "c".repeat(4000),
        }),
        makeArtifact({
          tokens: 1000,
          source: "normal1.json",
          priority: "normal",
          data: longData,
        }),
        makeArtifact({
          tokens: 1000,
          source: "normal2.json",
          priority: "normal",
          data: longData,
        }),
      ];
      // Budget 2000 → critical takes 1000, remaining 1000 for 2 normals
      // Each normal should be halved
      const result = enforceBudget(artifacts, 2000, "truncate-all");
      assert.equal(result.artifacts.length, 3);
      assert.deepEqual(result.dropped, []);

      // Critical unchanged
      const critical = result.artifacts.find(
        (a) => a.source === "critical.json",
      )!;
      assert.equal(critical.data.length, 4000);

      // Non-critical truncated to ~half
      const normal1 = result.artifacts.find(
        (a) => a.source === "normal1.json",
      )!;
      assert.ok(
        normal1.data.length < 4000,
        `Expected truncation, got ${normal1.data.length}`,
      );
      assert.ok(
        normal1.data.length > 0,
        "Should not be empty",
      );
    });

    it("does not drop anything", () => {
      const artifacts = [
        makeArtifact({ tokens: 5000, source: "a.json", priority: "normal", data: "x".repeat(20000) }),
        makeArtifact({ tokens: 5000, source: "b.json", priority: "low", data: "y".repeat(20000) }),
      ];
      const result = enforceBudget(artifacts, 3000, "truncate-all");
      assert.equal(result.artifacts.length, 2);
      assert.deepEqual(result.dropped, []);
    });

    it("keeps critical at full size", () => {
      const criticalData = "c".repeat(8000); // 2000 tokens
      const artifacts = [
        makeArtifact({
          tokens: 2000,
          source: "critical.json",
          priority: "critical",
          data: criticalData,
        }),
        makeArtifact({
          tokens: 2000,
          source: "normal.json",
          priority: "normal",
          data: "n".repeat(8000),
        }),
      ];
      // Budget 3000 → critical 2000, remaining 1000 for normal (was 2000)
      const result = enforceBudget(artifacts, 3000, "truncate-all");
      const critical = result.artifacts.find(
        (a) => a.source === "critical.json",
      )!;
      assert.equal(critical.data, criticalData);
    });

    it("handles all-critical gracefully", () => {
      const artifacts = [
        makeArtifact({ tokens: 5000, source: "c1.json", priority: "critical", data: "a".repeat(20000) }),
        makeArtifact({ tokens: 5000, source: "c2.json", priority: "critical", data: "b".repeat(20000) }),
      ];
      const result = enforceBudget(artifacts, 3000, "truncate-all");
      assert.equal(result.artifacts.length, 2);
      assert.deepEqual(result.dropped, []);
      // Data unchanged since all critical
      assert.equal(result.artifacts[0].data.length, 20000);
      assert.equal(result.artifacts[1].data.length, 20000);
    });
  });
});

// --- buildArtifactMessages ---

describe("buildArtifactMessages", () => {
  it("returns empty array for empty artifacts", () => {
    const result = buildArtifactMessages([]);
    assert.deepEqual(result, []);
  });

  it("builds single message with all artifacts", () => {
    const artifacts = [
      makeArtifact({
        as: "Task state:",
        wrap: "task-state",
        data: '{"goal":"implement"}',
      }),
      makeArtifact({
        as: "User corrections:",
        wrap: "user-corrections",
        data: '["use tabs"]',
      }),
    ];

    const messages = buildArtifactMessages(artifacts);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].timestamp, 0);
    assert.equal(messages[0].content.length, 1);
    assert.equal(messages[0].content[0].type, "text");

    const text = messages[0].content[0].text;
    assert.ok(text.includes("Task state:"));
    assert.ok(text.includes("<task-state>"));
    assert.ok(text.includes('{"goal":"implement"}'));
    assert.ok(text.includes("</task-state>"));
    assert.ok(text.includes("User corrections:"));
    assert.ok(text.includes("<user-corrections>"));
    assert.ok(text.includes('["use tabs"]'));
    assert.ok(text.includes("</user-corrections>"));
  });

  it("wraps each artifact with correct XML tags", () => {
    const artifacts = [
      makeArtifact({
        as: "Label:",
        wrap: "my-tag",
        data: "content here",
      }),
    ];

    const messages = buildArtifactMessages(artifacts);
    const text = messages[0].content[0].text;
    assert.ok(text.includes("Label:\n\n<my-tag>\ncontent here\n</my-tag>"));
  });
});

// --- buildStatsSummary ---

describe("buildStatsSummary", () => {
  it("returns null when no stats exist", () => {
    const spec = makeSpec();
    const result = buildStatsSummary(tmpDir, spec, "default", ".pi/compaction/default.yaml");
    assert.equal(result, null);
  });

  it("builds stats summary from latest compaction", () => {
    const spec = makeSpec();
    appendStats(
      tmpDir,
      makeStats({
        tokensBefore: 142000,
        summaryTokens: 4200,
        reassemblyTokens: 8700,
        reassemblyBudget: 12000,
        artifacts: {
          "task-state": {
            path: ".pi/session-state/task.json",
            tokens: 2100,
            sizeBytes: 8400,
            strategy: "llm",
          },
          decisions: {
            path: ".pi/session-state/decisions.json",
            tokens: 1800,
            sizeBytes: 7200,
            strategy: "llm",
          },
        },
        totalExtractCost: { inputTokens: 6400, outputTokens: 3200 },
        specPath: ".pi/compaction/debugging.yaml",
      }),
    );

    const result = buildStatsSummary(
      tmpDir,
      spec,
      "debugging",
      ".pi/compaction/debugging.yaml",
    );

    assert.ok(result !== null);
    assert.ok(result!.includes("<compaction-stats>"));
    assert.ok(result!.includes("</compaction-stats>"));
    assert.ok(result!.includes("142k"));
    assert.ok(result!.includes("4.2k summary"));
    assert.ok(result!.includes("8.7k reassembly"));
    assert.ok(result!.includes("task-state 2.1k"));
    assert.ok(result!.includes("decisions 1.8k"));
    assert.ok(result!.includes("8.7k / 12k"));
    assert.ok(result!.includes("6.4k input"));
    assert.ok(result!.includes("3.2k output"));
    assert.ok(result!.includes(".pi/compaction/debugging.yaml (editable)"));
  });

  it("flags growing artifacts", () => {
    const spec = makeSpec();
    // Create 3 consecutive increases for corrections
    for (let i = 0; i < 3; i++) {
      appendStats(
        tmpDir,
        makeStats({
          timestamp: i,
          artifacts: {
            corrections: {
              path: ".pi/session-state/corrections.json",
              tokens: 1000 + i * 500,
              sizeBytes: 4000 + i * 2000,
              entries: 10 + i * 10,
              strategy: "mechanical",
            },
          },
        }),
      );
    }

    const result = buildStatsSummary(
      tmpDir,
      spec,
      "default",
      ".pi/compaction/default.yaml",
    );

    assert.ok(result !== null);
    assert.ok(
      result!.includes("⚠ growing"),
      `Expected growing flag in: ${result}`,
    );
  });

  it("omits budget line when no budget set", () => {
    const spec = makeSpec();
    appendStats(
      tmpDir,
      makeStats({
        reassemblyBudget: null,
        artifacts: {
          "task-state": {
            path: ".pi/session-state/task.json",
            tokens: 2000,
            sizeBytes: 8000,
            strategy: "llm",
          },
        },
      }),
    );

    const result = buildStatsSummary(tmpDir, spec, "default", ".pi/compaction/default.yaml");
    assert.ok(result !== null);
    assert.ok(
      !result!.includes("Reassembly budget:"),
      `Should not have budget line: ${result}`,
    );
  });
});

// --- composeSummary ---

describe("composeSummary", () => {
  it("composes artifact content as tagged sections", () => {
    const spec = makeSpec();
    writeArtifactFile(".pi/session-state/task.json", { goal: "test" });
    writeArtifactFile(".pi/session-state/corrections.json", ["prefer tabs"]);

    const result = composeSummary(spec, tmpDir);

    assert.ok(result.includes("Task state:"));
    assert.ok(result.includes("<task-state>"));
    assert.ok(result.includes("</task-state>"));
    assert.ok(result.includes("User corrections and preferences (must be honored):"));
    assert.ok(result.includes("<user-corrections>"));
    assert.ok(result.includes("</user-corrections>"));
  });

  it("skips missing artifacts", () => {
    const spec = makeSpec();
    writeArtifactFile(".pi/session-state/task.json", { goal: "test" });
    // Don't create other files

    const result = composeSummary(spec, tmpDir);
    assert.ok(result.includes("Task state:"));
    assert.ok(!result.includes("User corrections"));
  });

  it("includes previous summary when provided", () => {
    const spec = makeSpec();
    writeArtifactFile(".pi/session-state/task.json", { goal: "test" });

    const result = composeSummary(spec, tmpDir, "Previous context here");

    assert.ok(result.includes("<previous-summary>"));
    assert.ok(result.includes("Previous context here"));
    assert.ok(result.includes("</previous-summary>"));
  });

  it("returns only previous summary when no artifacts exist", () => {
    const spec = makeSpec();

    const result = composeSummary(spec, tmpDir, "Previous context");
    assert.ok(result.includes("<previous-summary>"));
    assert.ok(result.includes("Previous context"));
  });

  it("returns empty string when no artifacts and no previous summary", () => {
    const spec = makeSpec();
    const result = composeSummary(spec, tmpDir);
    assert.equal(result, "");
  });

  it("handles spec without reassemble section", () => {
    const spec: CompactionSpec = { extracts: {} };
    const result = composeSummary(spec, tmpDir, "previous");
    assert.ok(result.includes("<previous-summary>"));
    assert.ok(result.includes("previous"));
  });
});
