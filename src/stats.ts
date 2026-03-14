import * as fs from "node:fs";
import * as path from "node:path";
import type { CompactionStats } from "./types.js";

const STATS_RELATIVE_PATH = ".pi/session-state/compaction-stats.jsonl";

function statsPath(cwd: string): string {
  return path.join(cwd, STATS_RELATIVE_PATH);
}

/**
 * Append one CompactionStats entry as a JSON line to the JSONL file.
 * Creates parent directories as needed.
 */
export function appendStats(cwd: string, stats: CompactionStats): void {
  const filePath = statsPath(cwd);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(stats) + "\n";
  fs.appendFileSync(filePath, line, "utf-8");
}

/**
 * Read all CompactionStats entries from the JSONL file.
 * Skips invalid/empty lines. Returns empty array if file doesn't exist.
 */
export function readStats(cwd: string): CompactionStats[] {
  const filePath = statsPath(cwd);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const stats: CompactionStats[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        stats.push(JSON.parse(trimmed) as CompactionStats);
      } catch {
        // Skip invalid lines
      }
    }

    return stats;
  } catch {
    return [];
  }
}

/**
 * Format a trend string for a given artifact across recent compactions.
 *
 * Looks at the last N (default 5) compactions for the given artifact name.
 * Returns a string like "800 → 1,400 → 2,100 ⚠ growing" or "1.9k → 2.1k → 1.8k stable".
 * Flags ⚠ if tokens increased for 3+ consecutive entries.
 */
export function formatTrend(
  stats: CompactionStats[],
  artifactName: string,
  count: number = 5,
): string {
  // Filter stats that have this artifact
  const relevant = stats.filter((s) => s.artifacts[artifactName] != null);

  // Take the last N
  const recent = relevant.slice(-count);

  if (recent.length === 0) return "no data";

  const tokenValues = recent.map((s) => s.artifacts[artifactName].tokens);
  const formatted = tokenValues.map(formatNumber);
  const trend = formatted.join(" → ");

  const growing = isGrowing(tokenValues);
  return growing ? `${trend} ⚠ growing` : `${trend} stable`;
}

/**
 * Detect if a series of values has 3+ consecutive increases.
 */
function isGrowing(values: number[]): boolean {
  if (values.length < 3) return false;

  let consecutive = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1]) {
      consecutive++;
      if (consecutive >= 2) return true; // 2 increases = 3 consecutive increasing entries
    } else {
      consecutive = 0;
    }
  }
  return false;
}

/**
 * Format a number for display: use k suffix for >= 1000, otherwise comma-separated.
 */
function formatNumber(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    // Use one decimal if not whole
    return k === Math.floor(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return n.toLocaleString("en-US");
}
