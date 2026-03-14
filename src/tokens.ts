import * as fs from "node:fs";

/**
 * Estimate token count using chars/4 heuristic (same as pi uses internally).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
