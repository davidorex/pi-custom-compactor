import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { estimateTokens } from "./tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    assert.equal(estimateTokens(""), 0);
  });

  it("pure ASCII matches Math.ceil(length / 4) — no regression", () => {
    const texts = [
      "Hello world",
      "Hello world, this is a test string for estimation.",
      "a",
      "ab",
      "abc",
      "abcd",
      JSON.stringify({ key: "value", nested: { arr: [1, 2, 3] } }),
    ];
    for (const text of texts) {
      assert.equal(
        estimateTokens(text),
        Math.ceil(text.length / 4),
        `ASCII regression for: "${text.slice(0, 30)}..."`,
      );
    }
  });

  it("pure CJK Chinese — 1 token per character", () => {
    // "你好世界" = 4 CJK chars = 4 tokens
    assert.equal(estimateTokens("你好世界"), 4);
  });

  it("pure Hiragana — 1 token per character", () => {
    // "こんにちは" = 5 chars = 5 tokens
    assert.equal(estimateTokens("こんにちは"), 5);
  });

  it("pure Katakana — 1 token per character", () => {
    // "カタカナ" = 4 chars = 4 tokens
    assert.equal(estimateTokens("カタカナ"), 4);
  });

  it("pure Hangul — 1 token per character", () => {
    // "한국어" = 3 chars = 3 tokens
    assert.equal(estimateTokens("한국어"), 3);
  });

  it("mixed English and CJK", () => {
    // "Hello 你好 World 世界"
    // ASCII: "Hello  World " = 13 chars → ceil(13/4) = 4
    // CJK: "你好世界" = 4 chars → 4
    // Total: 8
    assert.equal(estimateTokens("Hello 你好 World 世界"), 8);
  });

  it("JSON with CJK values — simulates real artifact content", () => {
    const json = JSON.stringify({ task: "修复CJK错误" });
    // JSON: {"task":"修复CJK错误"}
    // ASCII parts: {"task":"CJK"} = ~14 chars → ceil(14/4) = 4
    // CJK parts: 修复错误 = 4 chars → 4
    // Total should be significantly more than pure chars/4
    const naiveEstimate = Math.ceil(json.length / 4);
    const cjkEstimate = estimateTokens(json);
    assert.ok(
      cjkEstimate > naiveEstimate,
      `CJK-aware (${cjkEstimate}) should exceed naive (${naiveEstimate}) for CJK JSON`,
    );
  });

  it("fullwidth forms count as CJK density", () => {
    // Fullwidth A, B, C: U+FF21, U+FF22, U+FF23
    assert.equal(estimateTokens("\uFF21\uFF22\uFF23"), 3);
  });

  it("CJK punctuation counts as CJK density", () => {
    // 「」、。 = U+300C, U+300D, U+3001, U+3002
    assert.equal(estimateTokens("「」、。"), 4);
  });

  it("supplementary plane CJK — surrogate pair counts as 2 tokens", () => {
    // U+20000 (CJK Extension B) = surrogate pair \uD840\uDC00
    assert.equal(estimateTokens("\uD840\uDC00"), 2);
  });

  it("mixed supplementary and BMP CJK", () => {
    // "你" (BMP, 1 token) + U+20000 (supp, 2 tokens) + "好" (BMP, 1 token)
    assert.equal(estimateTokens("你\uD840\uDC00好"), 4);
  });

  it("CJK-heavy string significantly exceeds naive chars/4", () => {
    // 8 CJK characters
    const cjk = "你好世界测试文本";
    const naive = Math.ceil(cjk.length / 4); // ceil(8/4) = 2
    const aware = estimateTokens(cjk); // should be 8
    assert.equal(naive, 2, "naive should undercount");
    assert.equal(aware, 8, "CJK-aware should count correctly");
  });
});
