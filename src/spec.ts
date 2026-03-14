import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { CompactionSpec, ExtractSpec, ReassembleSpec, Strategy, Priority, OverflowStrategy } from "./types.js";

const VALID_STRATEGIES: Strategy[] = ["mechanical", "llm"];
const VALID_PRIORITIES: Priority[] = ["critical", "high", "normal", "low"];
const VALID_OVERFLOW: OverflowStrategy[] = ["trim-lowest", "truncate-all"];

/** Result of spec resolution including the resolved name and path. */
export interface ResolvedSpec {
  spec: CompactionSpec;
  name: string;
  path: string;
}

/**
 * Resolve the active compaction spec for a given working directory.
 *
 * Resolution order:
 * 1. .pi/workflow-state.json → compactionSpec field → .pi/compaction/<name>.yaml
 * 2. .pi/compaction/active pointer file → .pi/compaction/<name>.yaml
 * 3. .pi/compaction/default.yaml
 * 4. .pi/compaction.yaml (flat file, backward compat)
 * 5. null (no spec)
 */
export function resolveSpec(cwd: string): ResolvedSpec | null {
  // 1. Workflow state
  const workflowStatePath = path.join(cwd, ".pi", "workflow-state.json");
  if (fs.existsSync(workflowStatePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(workflowStatePath, "utf-8"));
      if (state.compactionSpec && typeof state.compactionSpec === "string") {
        const specPath = path.join(cwd, ".pi", "compaction", `${state.compactionSpec}.yaml`);
        const spec = loadAndValidateSpec(specPath);
        if (spec) return { spec, name: state.compactionSpec, path: specPath };
      }
    } catch {
      // Invalid JSON, continue to next resolution step
    }
  }

  // 2. Active pointer file
  const activePath = path.join(cwd, ".pi", "compaction", "active");
  if (fs.existsSync(activePath)) {
    try {
      const name = fs.readFileSync(activePath, "utf-8").trim();
      if (name) {
        const specPath = path.join(cwd, ".pi", "compaction", `${name}.yaml`);
        const spec = loadAndValidateSpec(specPath);
        if (spec) return { spec, name, path: specPath };
      }
    } catch {
      // Can't read pointer, continue
    }
  }

  // 3. Default spec
  const defaultPath = path.join(cwd, ".pi", "compaction", "default.yaml");
  {
    const spec = loadAndValidateSpec(defaultPath);
    if (spec) return { spec, name: "default", path: defaultPath };
  }

  // 4. Flat file (backward compat)
  const flatPath = path.join(cwd, ".pi", "compaction.yaml");
  {
    const spec = loadAndValidateSpec(flatPath);
    if (spec) return { spec, name: "compaction", path: flatPath };
  }

  // 5. No spec
  return null;
}

/**
 * Load and validate a spec from a YAML file path.
 * Returns null if file doesn't exist or validation fails.
 */
export function loadAndValidateSpec(filePath: string): CompactionSpec | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return parseAndValidateSpec(content);
  } catch {
    return null;
  }
}

/**
 * Parse YAML string and validate as a CompactionSpec.
 * Throws on validation errors.
 */
export function parseAndValidateSpec(yamlContent: string): CompactionSpec {
  const raw = parseYaml(yamlContent);
  if (!raw || typeof raw !== "object") {
    throw new Error("Spec must be a YAML object");
  }

  // Validate extracts
  if (!raw.extracts || typeof raw.extracts !== "object") {
    throw new Error("Spec must have an 'extracts' object");
  }

  const extracts: Record<string, ExtractSpec> = {};
  for (const [name, rawExtract] of Object.entries(raw.extracts)) {
    extracts[name] = validateExtract(name, rawExtract);
  }

  const spec: CompactionSpec = { extracts };

  // Validate reassemble (optional)
  if (raw.reassemble) {
    spec.reassemble = validateReassemble(raw.reassemble);
  }

  return spec;
}

function validateExtract(name: string, raw: unknown): ExtractSpec {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Extract '${name}' must be an object`);
  }
  const r = raw as Record<string, unknown>;

  if (!r.description || typeof r.description !== "string") {
    throw new Error(`Extract '${name}' must have a 'description' string`);
  }
  if (!r.persist || typeof r.persist !== "string") {
    throw new Error(`Extract '${name}' must have a 'persist' string`);
  }
  if (!r.format || typeof r.format !== "string") {
    throw new Error(`Extract '${name}' must have a 'format' string`);
  }
  if (!r.strategy || typeof r.strategy !== "string") {
    throw new Error(`Extract '${name}' must have a 'strategy' string`);
  }
  if (!VALID_STRATEGIES.includes(r.strategy as Strategy)) {
    throw new Error(`Extract '${name}' has invalid strategy '${r.strategy}'. Must be one of: ${VALID_STRATEGIES.join(", ")}`);
  }

  const extract: ExtractSpec = {
    description: r.description,
    persist: r.persist,
    format: r.format,
    strategy: r.strategy as Strategy,
  };

  if (r.maxTokens !== undefined) {
    if (typeof r.maxTokens !== "number" || r.maxTokens <= 0) {
      throw new Error(`Extract '${name}' maxTokens must be a positive number`);
    }
    extract.maxTokens = r.maxTokens;
  }

  if (r.maxEntries !== undefined) {
    if (typeof r.maxEntries !== "number" || r.maxEntries <= 0) {
      throw new Error(`Extract '${name}' maxEntries must be a positive number`);
    }
    extract.maxEntries = r.maxEntries;
  }

  if (r.priority !== undefined) {
    if (typeof r.priority !== "string" || !VALID_PRIORITIES.includes(r.priority as Priority)) {
      throw new Error(`Extract '${name}' has invalid priority '${r.priority}'. Must be one of: ${VALID_PRIORITIES.join(", ")}`);
    }
    extract.priority = r.priority as Priority;
  }

  return extract;
}

function validateReassemble(raw: unknown): ReassembleSpec {
  if (!raw || typeof raw !== "object") {
    throw new Error("'reassemble' must be an object");
  }
  const r = raw as Record<string, unknown>;

  const reassemble: ReassembleSpec = { sources: [] };

  if (r.budget !== undefined) {
    if (typeof r.budget !== "number" || r.budget <= 0) {
      throw new Error("reassemble.budget must be a positive number");
    }
    reassemble.budget = r.budget;
  }

  if (r.overflow !== undefined) {
    if (typeof r.overflow !== "string" || !VALID_OVERFLOW.includes(r.overflow as OverflowStrategy)) {
      throw new Error(`reassemble.overflow must be one of: ${VALID_OVERFLOW.join(", ")}`);
    }
    reassemble.overflow = r.overflow as OverflowStrategy;
  }

  if (!Array.isArray(r.sources)) {
    throw new Error("reassemble must have a 'sources' array");
  }

  for (let i = 0; i < r.sources.length; i++) {
    const src = r.sources[i];
    if (!src || typeof src !== "object") {
      throw new Error(`reassemble.sources[${i}] must be an object`);
    }
    if (!src.source || typeof src.source !== "string") {
      throw new Error(`reassemble.sources[${i}] must have a 'source' string`);
    }
    if (!src.as || typeof src.as !== "string") {
      throw new Error(`reassemble.sources[${i}] must have an 'as' string`);
    }
    if (!src.wrap || typeof src.wrap !== "string") {
      throw new Error(`reassemble.sources[${i}] must have a 'wrap' string`);
    }
    reassemble.sources.push({
      source: src.source,
      as: src.as,
      wrap: src.wrap,
    });
  }

  return reassemble;
}

/**
 * List available spec files in .pi/compaction/*.yaml.
 * Returns spec names (without .yaml extension).
 */
export function listSpecFiles(cwd: string): string[] {
  const dir = path.join(cwd, ".pi", "compaction");
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".yaml") && f !== "active")
      .map(f => f.replace(/\.yaml$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve the name of the currently active spec (without loading it).
 * Returns the spec name or null.
 */
export function resolveActiveSpecName(cwd: string): string | null {
  // 1. Workflow state
  const workflowStatePath = path.join(cwd, ".pi", "workflow-state.json");
  if (fs.existsSync(workflowStatePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(workflowStatePath, "utf-8"));
      if (state.compactionSpec && typeof state.compactionSpec === "string") {
        return state.compactionSpec;
      }
    } catch {
      // continue
    }
  }

  // 2. Active pointer
  const activePath = path.join(cwd, ".pi", "compaction", "active");
  if (fs.existsSync(activePath)) {
    try {
      const name = fs.readFileSync(activePath, "utf-8").trim();
      if (name) return name;
    } catch {
      // continue
    }
  }

  // 3. Default
  const defaultPath = path.join(cwd, ".pi", "compaction", "default.yaml");
  if (fs.existsSync(defaultPath)) return "default";

  // 4. Flat file
  const flatPath = path.join(cwd, ".pi", "compaction.yaml");
  if (fs.existsSync(flatPath)) return "compaction";

  return null;
}

/**
 * Write the active pointer file to select a spec.
 */
export function writeActivePointer(cwd: string, name: string): void {
  const dir = path.join(cwd, ".pi", "compaction");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "active"), name, "utf-8");
}

/**
 * Resolve an artifact persist path relative to cwd.
 */
export function resolveArtifactPath(persist: string, cwd: string): string {
  if (path.isAbsolute(persist)) return persist;
  return path.join(cwd, persist);
}
