import * as fs from "node:fs";

/**
 * Estimate token count using character-density heuristics.
 *
 * Non-CJK text: ~1 token per 4 characters (conservative for English).
 * CJK text: ~1 token per character (Chinese, Japanese, Korean).
 * Supplementary-plane CJK: ~2 tokens per character.
 *
 * Intentionally conservative (overestimates rather than underestimates)
 * because underestimation causes budget enforcement to fail silently.
 *
 * Addresses pi-mono#2562: chars/4 undercounts CJK by 2.7-4x.
 */
export function estimateTokens(text: string): number {
  let cjkCount = 0;
  let otherCount = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    if (
      (code >= 0x3000 && code <= 0x9FFF) || // CJK symbols, hiragana, katakana, CJK unified ideographs
      (code >= 0xAC00 && code <= 0xD7AF) || // Hangul syllables
      (code >= 0xF900 && code <= 0xFAFF) || // CJK compatibility ideographs
      (code >= 0xFF00 && code <= 0xFFEF)    // Fullwidth forms
    ) {
      cjkCount++;
    } else if (code >= 0xD800 && code <= 0xDBFF) {
      // High surrogate — supplementary plane character (likely CJK Extension B+)
      cjkCount += 2;
      i++; // Skip the low surrogate
    } else {
      otherCount++;
    }
  }

  return Math.ceil(cjkCount + otherCount / 4);
}

/**
 * Estimate tokens for a JSON artifact on disk.
 * Returns 0 if the file doesn't exist or can't be read.
 */
export function estimateArtifactTokens(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return estimateTokens(content);
  } catch {
    return 0;
  }
}
