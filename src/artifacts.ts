import * as fs from "node:fs";
import * as path from "node:path";
import { estimateTokens } from "./tokens.js";

/**
 * Read a JSON artifact from disk.
 * Returns parsed data or null on any error (missing file, invalid JSON).
 * Never throws.
 */
export function readArtifact(filePath: string): unknown | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write a JSON artifact to disk with 2-space indent.
 * Creates parent directories as needed.
 */
export function writeArtifact(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Merge artifacts for append-only mechanical extracts.
 *
 * - If both are arrays: concatenate [...existing, ...incoming]
 * - If both are objects with array values (like file-ops { read: [], modified: [] }):
 *   merge each array with Set dedup
 * - Otherwise: return incoming (overwrite)
 */
export function mergeArtifact(existing: unknown, incoming: unknown): unknown {
  // If existing is null/undefined, just return incoming
  if (existing == null) return incoming;

  // Both arrays: concatenate
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    return [...existing, ...incoming];
  }

  // Both plain objects: check if they have array values for set-merge
  if (
    isPlainObject(existing) &&
    isPlainObject(incoming) &&
    hasArrayValues(existing) &&
    hasArrayValues(incoming)
  ) {
    return mergeObjectArrays(
      existing as Record<string, unknown>,
      incoming as Record<string, unknown>,
    );
  }

  // Otherwise: overwrite with incoming
  return incoming;
}

/**
 * Enforce maxTokens on array data by removing oldest entries (from front)
 * until estimateTokens(JSON.stringify(data)) <= maxTokens.
 */
export function enforceMaxTokens(
  data: unknown,
  maxTokens: number,
): { data: unknown; trimmed: boolean } {
  if (!Array.isArray(data)) {
    return { data, trimmed: false };
  }

  let arr = [...data];
  const original = arr.length;

  while (arr.length > 0 && estimateTokens(JSON.stringify(arr)) > maxTokens) {
    arr.shift();
  }

  return { data: arr, trimmed: arr.length < original };
}

/**
 * Enforce maxEntries on array data by keeping only the last N entries.
 */
export function enforceMaxEntries(
  data: unknown,
  maxEntries: number,
): { data: unknown; trimmed: boolean } {
  if (!Array.isArray(data)) {
    return { data, trimmed: false };
  }

  if (data.length <= maxEntries) {
    return { data, trimmed: false };
  }

  return { data: data.slice(-maxEntries), trimmed: true };
}

// --- helpers ---

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasArrayValues(obj: Record<string, unknown>): boolean {
  const values = Object.values(obj);
  return values.length > 0 && values.every((v) => Array.isArray(v));
}

function mergeObjectArrays(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const allKeys = new Set([...Object.keys(existing), ...Object.keys(incoming)]);

  for (const key of allKeys) {
    const existingArr = Array.isArray(existing[key]) ? (existing[key] as unknown[]) : [];
    const incomingArr = Array.isArray(incoming[key]) ? (incoming[key] as unknown[]) : [];

    // Set dedup using JSON serialization for complex values
    const seen = new Set<string>();
    const merged: unknown[] = [];

    for (const item of [...existingArr, ...incomingArr]) {
      const serialized = typeof item === "string" ? item : JSON.stringify(item);
      if (!seen.has(serialized)) {
        seen.add(serialized);
        merged.push(item);
      }
    }

    result[key] = merged;
  }

  return result;
}
