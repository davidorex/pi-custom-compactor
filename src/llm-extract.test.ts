import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildExtractionPrompt,
  parseJsonResponse,
  pickSummarizationModel,
} from "./llm-extract.js";
import type { ExtractSpec } from "./types.js";

const baseExtract: ExtractSpec = {
  description: "Architectural decisions with rationale",
  persist: ".pi/session-state/decisions.json",
  format: 'Array of { decision, rationale, files_affected }',
  strategy: "llm",
};

describe("buildExtractionPrompt", () => {
  it("includes extract name", () => {
    const prompt = buildExtractionPrompt("decisions", baseExtract, "some conversation");
    assert.ok(prompt.includes('"decisions"'));
  });

  it("includes description", () => {
    const prompt = buildExtractionPrompt("decisions", baseExtract, "conv");
    assert.ok(prompt.includes("Architectural decisions with rationale"));
  });

  it("includes format", () => {
    const prompt = buildExtractionPrompt("decisions", baseExtract, "conv");
    assert.ok(prompt.includes("Array of { decision, rationale, files_affected }"));
  });

  it("includes conversation text in tags", () => {
    const prompt = buildExtractionPrompt("decisions", baseExtract, "hello world");
    assert.ok(prompt.includes("<conversation>"));
    assert.ok(prompt.includes("hello world"));
    assert.ok(prompt.includes("</conversation>"));
  });

  it("includes JSON output instruction", () => {
    const prompt = buildExtractionPrompt("decisions", baseExtract, "conv");
    assert.ok(prompt.includes("Output valid JSON only"));
  });

  it("does not include token constraint when maxTokens is unset", () => {
    const prompt = buildExtractionPrompt("decisions", baseExtract, "conv");
    assert.ok(!prompt.includes("Keep your output concise"));
  });

  it("includes token constraint when maxTokens is set", () => {
    const extract: ExtractSpec = { ...baseExtract, maxTokens: 2000 };
    const prompt = buildExtractionPrompt("decisions", extract, "conv");
    assert.ok(prompt.includes("under 2000 tokens"));
    assert.ok(prompt.includes("approximately 8000 characters"));
  });

  it("calculates approximate characters correctly", () => {
    const extract: ExtractSpec = { ...baseExtract, maxTokens: 500 };
    const prompt = buildExtractionPrompt("task-state", extract, "conv");
    assert.ok(prompt.includes("approximately 2000 characters"));
  });
});

describe("parseJsonResponse", () => {
  it("parses valid JSON directly", () => {
    const result = parseJsonResponse('{"key": "value"}');
    assert.deepEqual(result, { key: "value" });
  });

  it("parses JSON array", () => {
    const result = parseJsonResponse('[1, 2, 3]');
    assert.deepEqual(result, [1, 2, 3]);
  });

  it("parses JSON from code fence with json tag", () => {
    const text = 'Here is the result:\n```json\n{"key": "value"}\n```\n';
    const result = parseJsonResponse(text);
    assert.deepEqual(result, { key: "value" });
  });

  it("parses JSON from code fence without json tag", () => {
    const text = '```\n[1, 2, 3]\n```';
    const result = parseJsonResponse(text);
    assert.deepEqual(result, [1, 2, 3]);
  });

  it("returns null for invalid text", () => {
    const result = parseJsonResponse("This is just plain text with no JSON");
    assert.equal(result, null);
  });

  it("returns null for empty string", () => {
    const result = parseJsonResponse("");
    assert.equal(result, null);
  });

  it("handles JSON with leading/trailing whitespace in code fence", () => {
    const text = '```json\n  \n  {"hello": "world"}\n  \n```';
    const result = parseJsonResponse(text);
    assert.deepEqual(result, { hello: "world" });
  });

  it("handles complex nested JSON", () => {
    const complex = {
      goal: "implement caching",
      done: ["setup", "basic cache"],
      in_progress: ["eviction policy"],
      blocked: [],
      next_steps: ["add TTL"],
    };
    const text = "```json\n" + JSON.stringify(complex, null, 2) + "\n```";
    const result = parseJsonResponse(text);
    assert.deepEqual(result, complex);
  });

  it("handles code fence with text before and after", () => {
    const text =
      "Here is the extracted data:\n\n```json\n{\"a\": 1}\n```\n\nHope that helps!";
    const result = parseJsonResponse(text);
    assert.deepEqual(result, { a: 1 });
  });

  it("returns null for code fence with invalid JSON", () => {
    const text = "```json\n{invalid json}\n```";
    const result = parseJsonResponse(text);
    assert.equal(result, null);
  });

  it("parses primitives", () => {
    assert.equal(parseJsonResponse("42"), 42);
    assert.equal(parseJsonResponse('"hello"'), "hello");
    assert.equal(parseJsonResponse("true"), true);
    assert.equal(parseJsonResponse("null"), null);
  });
});

describe("pickSummarizationModel", () => {
  it("returns gemini flash if available", () => {
    const ctx = {
      modelRegistry: {
        find: (provider: string, pattern: string) => {
          if (provider === "google" && pattern === "gemini-2.5-flash") {
            return { id: "gemini-2.5-flash", name: "Gemini Flash", provider: "google" };
          }
          return undefined;
        },
      },
      model: { id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
    } as any;

    const result = pickSummarizationModel(ctx);
    assert.equal(result?.id, "gemini-2.5-flash");
  });

  it("falls back to claude haiku if gemini unavailable", () => {
    const ctx = {
      modelRegistry: {
        find: (provider: string, pattern: string) => {
          if (provider === "anthropic" && pattern === "claude-haiku") {
            return { id: "claude-haiku", name: "Claude Haiku", provider: "anthropic" };
          }
          return undefined;
        },
      },
      model: { id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
    } as any;

    const result = pickSummarizationModel(ctx);
    assert.equal(result?.id, "claude-haiku");
  });

  it("falls back to ctx.model if no cheap models available", () => {
    const ctx = {
      modelRegistry: {
        find: () => undefined,
      },
      model: { id: "gpt-4", name: "GPT-4", provider: "openai" },
    } as any;

    const result = pickSummarizationModel(ctx);
    assert.equal(result?.id, "gpt-4");
  });

  it("returns null if no models available at all", () => {
    const ctx = {
      modelRegistry: {
        find: () => undefined,
      },
      model: undefined,
    } as any;

    const result = pickSummarizationModel(ctx);
    assert.equal(result, null);
  });
});
