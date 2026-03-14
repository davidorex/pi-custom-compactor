import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  extractText,
  extractCorrections,
  extractFileOps,
  runMechanicalExtract,
} from "./mechanical.js";
import type { ExtractSpec } from "./types.js";

// Helper to create a user message
function userMsg(text: string, timestamp = Date.now()) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp,
  };
}

// Helper to create an assistant message
function assistantMsg(text: string, timestamp = Date.now()) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "completions" as any,
    provider: "test" as any,
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop" as const,
    timestamp,
  };
}

// Helper to create an assistant message with tool calls
function assistantToolCallMsg(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  timestamp = Date.now(),
) {
  return {
    role: "assistant" as const,
    content: toolCalls.map((tc) => ({
      type: "toolCall" as const,
      id: `call_${Math.random().toString(36).slice(2)}`,
      name: tc.name,
      args: tc.args,
    })),
    api: "completions" as any,
    provider: "test" as any,
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "toolUse" as const,
    timestamp,
  };
}

// Dummy extract spec for dispatcher tests
const dummyExtract: ExtractSpec = {
  description: "test",
  persist: "test.json",
  format: "test",
  strategy: "mechanical",
};

describe("extractText", () => {
  it("extracts text from user message with TextContent", () => {
    const msg = userMsg("hello world");
    assert.equal(extractText(msg), "hello world");
  });

  it("joins multiple text blocks", () => {
    const msg = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "first" },
        { type: "text" as const, text: "second" },
      ],
      timestamp: Date.now(),
    };
    assert.equal(extractText(msg), "first\nsecond");
  });

  it("skips image content", () => {
    const msg = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "look at this" },
        { type: "image" as const, data: "base64data", mimeType: "image/png" },
      ],
      timestamp: Date.now(),
    };
    assert.equal(extractText(msg), "look at this");
  });

  it("returns empty string for assistant messages", () => {
    const msg = assistantMsg("I am the assistant");
    assert.equal(extractText(msg), "");
  });

  it("handles string content", () => {
    const msg = {
      role: "user" as const,
      content: "plain string content",
      timestamp: Date.now(),
    };
    assert.equal(extractText(msg), "plain string content");
  });

  it("returns empty for empty content array", () => {
    const msg = {
      role: "user" as const,
      content: [] as any[],
      timestamp: Date.now(),
    };
    assert.equal(extractText(msg), "");
  });
});

describe("extractCorrections", () => {
  it("detects 'no,' pattern", () => {
    const messages = [userMsg("No, that's not right")];
    const result = extractCorrections(messages);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "No, that's not right");
  });

  it("detects 'wrong' pattern", () => {
    const messages = [userMsg("That's wrong, please fix it")];
    const result = extractCorrections(messages);
    assert.equal(result.length, 1);
  });

  it("detects 'should be' pattern", () => {
    const messages = [userMsg("The function name should be calculateTotal")];
    const result = extractCorrections(messages);
    assert.equal(result.length, 1);
  });

  it("detects 'actually' pattern", () => {
    const messages = [userMsg("Actually, use TypeScript instead")];
    const result = extractCorrections(messages);
    assert.equal(result.length, 1);
  });

  it("detects 'prefer' pattern", () => {
    const messages = [userMsg("I prefer functional style")];
    const result = extractCorrections(messages);
    assert.equal(result.length, 1);
  });

  it("detects 'always' pattern", () => {
    const messages = [userMsg("Always use const instead of let")];
    const result = extractCorrections(messages);
    assert.equal(result.length, 1);
  });

  it("detects 'never' pattern", () => {
    const messages = [userMsg("Never use any type")];
    const result = extractCorrections(messages);
    assert.equal(result.length, 1);
  });

  it("ignores non-correction messages", () => {
    const messages = [
      userMsg("Please create a new file called utils.ts"),
      userMsg("Add a function to calculate the sum"),
    ];
    const result = extractCorrections(messages);
    assert.equal(result.length, 0);
  });

  it("ignores assistant messages", () => {
    const messages = [
      assistantMsg("No, I think we should do it differently"),
    ];
    const result = extractCorrections(messages);
    assert.equal(result.length, 0);
  });

  it("preserves timestamps", () => {
    const ts = 1700000000000;
    const messages = [userMsg("No, that's wrong", ts)];
    const result = extractCorrections(messages);
    assert.equal(result[0].timestamp, ts);
  });

  it("truncates long text to 500 chars", () => {
    const longText = "No, " + "x".repeat(600);
    const messages = [userMsg(longText)];
    const result = extractCorrections(messages);
    assert.equal(result[0].text.length, 500);
  });

  it("finds multiple corrections", () => {
    const messages = [
      userMsg("No, use a different approach"),
      userMsg("Build the component"),
      userMsg("Actually, use React instead"),
      userMsg("That looks good"),
      userMsg("Wrong file, should be in src/"),
    ];
    const result = extractCorrections(messages);
    assert.equal(result.length, 3);
  });
});

describe("extractFileOps", () => {
  it("extracts read operations from tool calls", () => {
    const messages = [
      assistantToolCallMsg([{ name: "read", args: { path: "src/index.ts" } }]),
    ];
    const result = extractFileOps(messages);
    assert.deepEqual(result.read, ["src/index.ts"]);
    assert.deepEqual(result.modified, []);
  });

  it("extracts write operations from tool calls", () => {
    const messages = [
      assistantToolCallMsg([{ name: "write", args: { path: "src/new.ts" } }]),
    ];
    const result = extractFileOps(messages);
    assert.deepEqual(result.read, []);
    assert.deepEqual(result.modified, ["src/new.ts"]);
  });

  it("extracts edit operations from tool calls", () => {
    const messages = [
      assistantToolCallMsg([{ name: "edit", args: { path: "src/utils.ts" } }]),
    ];
    const result = extractFileOps(messages);
    assert.deepEqual(result.modified, ["src/utils.ts"]);
  });

  it("deduplicates file paths", () => {
    const messages = [
      assistantToolCallMsg([{ name: "read", args: { path: "src/index.ts" } }]),
      assistantToolCallMsg([{ name: "read", args: { path: "src/index.ts" } }]),
    ];
    const result = extractFileOps(messages);
    assert.deepEqual(result.read, ["src/index.ts"]);
  });

  it("sorts file paths", () => {
    const messages = [
      assistantToolCallMsg([
        { name: "read", args: { path: "src/z.ts" } },
        { name: "read", args: { path: "src/a.ts" } },
      ]),
    ];
    const result = extractFileOps(messages);
    assert.deepEqual(result.read, ["src/a.ts", "src/z.ts"]);
  });

  it("handles mixed operations", () => {
    const messages = [
      assistantToolCallMsg([
        { name: "read", args: { path: "src/old.ts" } },
        { name: "write", args: { path: "src/new.ts" } },
        { name: "edit", args: { path: "src/existing.ts" } },
      ]),
    ];
    const result = extractFileOps(messages);
    assert.deepEqual(result.read, ["src/old.ts"]);
    assert.deepEqual(result.modified, ["src/existing.ts", "src/new.ts"]);
  });

  it("returns empty arrays for no tool calls", () => {
    const messages = [
      userMsg("hello"),
      assistantMsg("hi there"),
    ];
    const result = extractFileOps(messages);
    assert.deepEqual(result.read, []);
    assert.deepEqual(result.modified, []);
  });

  it("handles empty messages", () => {
    const result = extractFileOps([]);
    assert.deepEqual(result.read, []);
    assert.deepEqual(result.modified, []);
  });
});

describe("runMechanicalExtract", () => {
  it("dispatches user-corrections", () => {
    const messages = [userMsg("No, that's wrong")];
    const result = runMechanicalExtract("user-corrections", dummyExtract, messages);
    assert.ok(Array.isArray(result));
    assert.equal((result as any[]).length, 1);
  });

  it("dispatches file-awareness", () => {
    const messages = [
      assistantToolCallMsg([{ name: "read", args: { path: "test.ts" } }]),
    ];
    const result = runMechanicalExtract("file-awareness", dummyExtract, messages);
    assert.ok(result != null && typeof result === "object");
    assert.deepEqual((result as any).read, ["test.ts"]);
  });

  it("returns empty array for unknown names", () => {
    const messages = [userMsg("hello")];
    const result = runMechanicalExtract("unknown-extract", dummyExtract, messages);
    assert.deepEqual(result, []);
  });
});
