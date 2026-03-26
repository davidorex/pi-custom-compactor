/**
 * pi-custom-compactor — YAML-driven structured compaction extension for Pi.
 *
 * Replaces Pi's built-in compaction with a configurable pipeline that extracts
 * artifacts (mechanical or LLM-based) according to a YAML spec, persists them
 * to disk, and reassembles them into context on each turn.
 *
 * Hooks:
 *   session_start       — bootstraps seed compaction specs on first use
 *   session_before_compact — runs the extract pipeline, writes artifacts, composes summary
 *   session_switch      — resets event-bus spec override on branch switch
 *   session_fork        — resets event-bus spec override on session fork
 *   context             — injects reassembled artifacts and stats into the context
 *
 * Commands:
 *   /compaction-use     — switch active compaction spec (with tab completion)
 *   /compaction-stats   — display compaction statistics and trends
 *   /compaction-clean   — remove orphaned compaction artifacts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  resolveSpec,
  listSpecFiles,
  resolveActiveSpecName,
  writeActivePointer,
  resolveArtifactPath,
  loadAndValidateSpec,
} from "./spec.js";
import {
  readArtifact,
  writeArtifact,
  mergeArtifact,
  enforceMaxTokens,
  enforceMaxEntries,
} from "./artifacts.js";
import { estimateTokens, estimateArtifactTokens } from "./tokens.js";
import { appendStats, readStats, formatTrend, formatNumber } from "./stats.js";
import { runMechanicalExtract } from "./mechanical.js";
import {
  runLlmExtract,
  pickSummarizationModel,
  type LlmExtractResult,
} from "./llm-extract.js";
import {
  readReassemblyArtifacts,
  enforceBudget,
  buildArtifactMessages,
  buildStatsSummary,
  composeSummary,
} from "./reassemble.js";
import type {
  CompactionStats,
  ArtifactStats,
  CompactionDetails,
} from "./types.js";

export default function (pi: ExtensionAPI) {
  // Mutable state for event bus override
  let activeSpecOverride: string | null = null;
  // Cached cwd captured from session_start for use in getArgumentCompletions
  // (which receives only a prefix argument, with no access to ctx).
  let cachedCwd: string | null = null;

  // ─── Hook 0: session_start — bootstrap seed specs on first use ──────
  pi.on("session_start", async (_event, ctx) => {
    cachedCwd = ctx.cwd;
    try {
      // Check if any spec exists via resolution
      const existing = resolveSpec(ctx.cwd);
      if (existing) return; // Already configured, don't touch

      // Check if .pi/compaction/ directory exists (user may have set up but with invalid specs)
      const compactionDir = path.join(ctx.cwd, ".pi", "compaction");
      if (fs.existsSync(compactionDir)) return; // Directory exists, user is managing it

      // Bootstrap: copy seeds to .pi/compaction/
      const seedsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "seeds");
      if (!fs.existsSync(seedsDir)) return; // Seeds not found (shouldn't happen)

      fs.mkdirSync(compactionDir, { recursive: true });

      const seedFiles = fs
        .readdirSync(seedsDir)
        .filter((f) => f.endsWith(".yaml"));
      for (const file of seedFiles) {
        const src = path.join(seedsDir, file);
        const dest = path.join(compactionDir, file);
        fs.copyFileSync(src, dest);
      }

      // Set default as active
      writeActivePointer(ctx.cwd, "default");

      ctx.ui.notify(
        `Compaction specs initialized in .pi/compaction/ (active: default)\n` +
          `Available: ${seedFiles.map((f) => f.replace(/\.yaml$/, "")).join(", ")}\n` +
          `Switch with /compaction-use <name>`,
        "info",
      );
    } catch {
      // Bootstrap is best-effort, don't crash
    }
  });

  // Event bus listener for workflow integration
  pi.events.on("workflow:compaction", (data: unknown) => {
    if (data && typeof data === "object" && "spec" in data && typeof (data as { spec: unknown }).spec === "string") {
      activeSpecOverride = (data as { spec: string }).spec;
    }
  });

  // Shared helper: resolve spec with event-bus override, then fall back to disk resolution.
  function resolveSpecWithOverride(cwd: string) {
    if (activeSpecOverride) {
      const specPath = path.join(cwd, ".pi", "compaction", `${activeSpecOverride}.yaml`);
      const spec = loadAndValidateSpec(specPath);
      if (spec) return { spec, name: activeSpecOverride, path: specPath };
    }
    return resolveSpec(cwd);
  }

  // Reset event-bus override on branch switch, fork, and tree navigation so
  // stale overrides from a previous branch do not persist.
  pi.on("session_switch", async (_event, ctx) => {
    activeSpecOverride = null;
    cachedCwd = ctx.cwd;
  });
  pi.on("session_fork", async (_event, ctx) => {
    activeSpecOverride = null;
    cachedCwd = ctx.cwd;
  });
  pi.on("session_tree", async (_event, ctx) => {
    activeSpecOverride = null;
    cachedCwd = ctx.cwd;
  });

  // ─── Hook 1: session_before_compact ───────────────────────────────────
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      const resolved = resolveSpecWithOverride(ctx.cwd);
      if (!resolved) return undefined; // fall back to built-in

      const { preparation, signal } = event;
      const {
        messagesToSummarize,
        turnPrefixMessages,
        previousSummary,
        firstKeptEntryId,
        tokensBefore,
      } = preparation;

      const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

      // Track per-artifact stats
      const artifactStatsMap: Record<string, ArtifactStats> = {};
      const totalExtractCost = { inputTokens: 0, outputTokens: 0 };

      // Run each declared extract
      for (const [name, extract] of Object.entries(resolved.spec.extracts)) {
        // Check abort signal
        if (signal.aborted) return undefined;

        const artifactPath = resolveArtifactPath(extract.persist, ctx.cwd);

        if (extract.strategy === "mechanical") {
          const result = runMechanicalExtract(name, extract, allMessages);
          const existing = readArtifact(artifactPath);
          let merged = mergeArtifact(existing, result);

          let trimmed = false;

          // Apply caps
          if (extract.maxEntries != null) {
            const capped = enforceMaxEntries(merged, extract.maxEntries);
            merged = capped.data;
            if (capped.trimmed) trimmed = true;
          }

          if (extract.maxTokens != null) {
            const capped = enforceMaxTokens(merged, extract.maxTokens);
            merged = capped.data;
            if (capped.trimmed) trimmed = true;
          }

          writeArtifact(artifactPath, merged);

          // Track stats
          const serialized = JSON.stringify(merged);
          artifactStatsMap[name] = {
            path: extract.persist,
            tokens: estimateTokens(serialized),
            sizeBytes: Buffer.byteLength(serialized, "utf-8"),
            entries: Array.isArray(merged) ? merged.length : undefined,
            strategy: "mechanical",
            trimmed: trimmed || undefined,
          };
        } else if (extract.strategy === "llm") {
          const model = pickSummarizationModel(ctx);
          if (!model) {
            ctx.ui.notify(
              `Skipping LLM extract "${name}": no model available`,
              "warning",
            );
            continue;
          }

          const apiKey = await ctx.modelRegistry.getApiKey(model);
          if (!apiKey) {
            ctx.ui.notify(
              `Skipping LLM extract "${name}": no API key for ${model.name}`,
              "warning",
            );
            continue;
          }

          const result = await runLlmExtract(
            name,
            extract,
            allMessages,
            model,
            apiKey,
            signal,
          );

          if (!result || result.data == null) {
            const detail = result?.error ? `: ${result.error}` : "";
            ctx.ui.notify(
              `LLM extract "${name}" returned no result${detail}`,
              "warning",
            );
            continue;
          }

          let data = result.data;
          let trimmed = false;

          // Apply maxTokens cap if set
          if (extract.maxTokens != null) {
            const capped = enforceMaxTokens(data, extract.maxTokens);
            data = capped.data;
            if (capped.trimmed) trimmed = true;
          }

          writeArtifact(artifactPath, data);

          // Track stats
          const serialized = JSON.stringify(data);
          artifactStatsMap[name] = {
            path: extract.persist,
            tokens: estimateTokens(serialized),
            sizeBytes: Buffer.byteLength(serialized, "utf-8"),
            strategy: "llm",
            trimmed: trimmed || undefined,
            extractCost: result.usage,
          };

          if (result.usage) {
            totalExtractCost.inputTokens += result.usage.inputTokens;
            totalExtractCost.outputTokens += result.usage.outputTokens;
          }
        }
      }

      // Check abort signal again before composing summary
      if (signal.aborted) return undefined;

      // Compose summary from artifacts
      const summary = composeSummary(resolved.spec, ctx.cwd, previousSummary);
      const summaryTokens = estimateTokens(summary);

      // Calculate reassembly tokens
      let reassemblyTokens = 0;
      for (const stats of Object.values(artifactStatsMap)) {
        reassemblyTokens += stats.tokens;
      }

      // Get context window
      const contextUsage = ctx.getContextUsage();
      const contextWindow = contextUsage?.contextWindow ?? 200000;

      // Build artifact index for details
      const artifactIndex: Record<string, { path: string; strategy: string }> =
        {};
      for (const [name, extract] of Object.entries(resolved.spec.extracts)) {
        artifactIndex[name] = {
          path: extract.persist,
          strategy: extract.strategy,
        };
      }

      // Build CompactionStats and append
      const compactionStats: CompactionStats = {
        timestamp: Date.now(),
        tokensBefore,
        summaryTokens,
        reassemblyTokens,
        reassemblyBudget: resolved.spec.reassemble?.budget ?? null,
        contextWindow,
        artifacts: artifactStatsMap,
        totalExtractCost,
        specName: resolved.name,
        specPath: resolved.path,
      };

      appendStats(ctx.cwd, compactionStats);

      // Build details
      const details: CompactionDetails = {
        artifactIndex,
        stats: compactionStats,
      };

      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore,
          details,
        },
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown compaction error";
      ctx.ui.notify(`Custom compaction failed: ${message}`, "error");
      return undefined;
    }
  });

  // ─── Hook 2: context ──────────────────────────────────────────────────
  pi.on("context", async (event, ctx) => {
    try {
      const resolved = resolveSpecWithOverride(ctx.cwd);
      if (!resolved || !resolved.spec.reassemble) return;

      // Read artifacts
      const artifacts = readReassemblyArtifacts(resolved.spec, ctx.cwd);
      if (artifacts.length === 0) return;

      // Enforce budget
      const budgetResult = enforceBudget(
        artifacts,
        resolved.spec.reassemble.budget,
        resolved.spec.reassemble.overflow,
      );

      // Build artifact messages
      const artifactMessages = buildArtifactMessages(budgetResult.artifacts);

      // Build stats summary
      const statsSummary = buildStatsSummary(
        ctx.cwd,
        resolved.spec,
        resolved.name,
        resolved.path,
      );

      // Build synthetic messages
      const synthetic: typeof event.messages = [...artifactMessages];

      if (statsSummary) {
        synthetic.push({
          role: "user" as const,
          content: [{ type: "text" as const, text: statsSummary }],
          timestamp: 0,
        });
      }

      if (synthetic.length === 0) return;

      return { messages: [...synthetic, ...event.messages] };
    } catch {
      // Don't modify context, don't crash
      return undefined;
    }
  });

  // ─── Command: /compaction-use ─────────────────────────────────────────
  pi.registerCommand("compaction-use", {
    description: "Switch active compaction spec",
    getArgumentCompletions: (prefix) => {
      if (!cachedCwd) return [];
      const specs = listSpecFiles(cachedCwd);
      return specs
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s }));
    },
    handler: async (args, ctx) => {
      if (!args.trim()) {
        const current = resolveActiveSpecName(ctx.cwd);
        const available = listSpecFiles(ctx.cwd);
        ctx.ui.notify(
          `Active: ${current ?? "none"}\nAvailable: ${available.length ? available.join(", ") : "none"}`,
          "info",
        );
        return;
      }
      const name = args.trim();
      // Verify the spec file exists
      const specPath = path.join(
        ctx.cwd,
        ".pi",
        "compaction",
        `${name}.yaml`,
      );
      if (!fs.existsSync(specPath)) {
        ctx.ui.notify(
          `Spec not found: ${name} (expected ${specPath})`,
          "error",
        );
        return;
      }
      writeActivePointer(ctx.cwd, name);
      activeSpecOverride = null; // Clear any event bus override
      ctx.ui.notify(`Compaction spec: ${name}`, "info");
    },
  });

  // ─── Command: /compaction-stats ───────────────────────────────────────
  pi.registerCommand("compaction-stats", {
    description: "Show compaction statistics and trends",
    handler: async (_args, ctx) => {
      const allStats = readStats(ctx.cwd);
      if (allStats.length === 0) {
        ctx.ui.notify("No compaction stats yet.", "info");
        return;
      }

      const latest = allStats[allStats.length - 1];
      const lines: string[] = [];

      // Last compaction header
      lines.push(`Last compaction (spec: ${latest.specName}):`);

      // Context stats
      lines.push(
        `  Context before:     ${formatNumber(latest.tokensBefore)} tokens`,
      );
      lines.push(
        `  Summary produced:   ${formatNumber(latest.summaryTokens)} tokens`,
      );
      const pct =
        latest.contextWindow > 0
          ? (
              (latest.reassemblyTokens / latest.contextWindow) *
              100
            ).toFixed(1)
          : "?";
      lines.push(
        `  Reassembly total:   ${formatNumber(latest.reassemblyTokens)} tokens (${pct}% of context window)`,
      );

      // Artifacts
      lines.push("");
      lines.push("  Artifacts:");
      for (const [name, astats] of Object.entries(latest.artifacts)) {
        let line = `    ${name.padEnd(20)} ${formatNumber(astats.tokens)} tokens  (${astats.strategy}`;
        if (astats.extractCost) {
          line += `, cost: ${formatNumber(astats.extractCost.inputTokens)} in / ${formatNumber(astats.extractCost.outputTokens)} out`;
        }
        if (astats.entries != null) {
          line += `, ${astats.entries} entries`;
        }
        line += ")";

        // Check if growing
        const trend = formatTrend(allStats, name);
        if (trend.includes("⚠ growing")) {
          line += " ⚠ growing";
        }

        lines.push(line);
      }

      // Total extract cost
      if (
        latest.totalExtractCost.inputTokens > 0 ||
        latest.totalExtractCost.outputTokens > 0
      ) {
        lines.push("");
        lines.push(
          `  Total extract cost: ${formatNumber(latest.totalExtractCost.inputTokens)} input / ${formatNumber(latest.totalExtractCost.outputTokens)} output tokens`,
        );
      }

      // Trend section
      const artifactNames = Object.keys(latest.artifacts);
      if (allStats.length > 1 && artifactNames.length > 0) {
        lines.push("");
        lines.push(
          `Trend (last ${Math.min(allStats.length, 5)} compactions):`,
        );
        for (const name of artifactNames) {
          const trend = formatTrend(allStats, name);
          lines.push(`  ${name.padEnd(20)} ${trend}`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─── Command: /compaction-clean ───────────────────────────────────────
  pi.registerCommand("compaction-clean", {
    description: "Remove orphaned compaction artifacts",
    handler: async (args, ctx) => {
      const confirm = args.trim() === "--confirm";

      // Collect all artifact paths referenced by any spec
      const referencedPaths = new Set<string>();
      const specNames = listSpecFiles(ctx.cwd);
      for (const specName of specNames) {
        const specPath = path.join(
          ctx.cwd,
          ".pi",
          "compaction",
          `${specName}.yaml`,
        );
        const spec = loadAndValidateSpec(specPath);
        if (!spec) continue;
        for (const extract of Object.values(spec.extracts)) {
          referencedPaths.add(resolveArtifactPath(extract.persist, ctx.cwd));
        }
      }

      // Also check flat file
      const flatPath = path.join(ctx.cwd, ".pi", "compaction.yaml");
      const flatSpec = loadAndValidateSpec(flatPath);
      if (flatSpec) {
        for (const extract of Object.values(flatSpec.extracts)) {
          referencedPaths.add(resolveArtifactPath(extract.persist, ctx.cwd));
        }
      }

      // Scan session-state directory for JSON files
      const stateDir = path.join(ctx.cwd, ".pi", "session-state");
      if (!fs.existsSync(stateDir)) {
        ctx.ui.notify("No session state directory found.", "info");
        return;
      }

      const orphaned: string[] = [];
      scanDirectory(stateDir, (filePath) => {
        if (!filePath.endsWith(".json")) return;
        // Skip the stats file
        if (filePath.endsWith("compaction-stats.jsonl")) return;
        if (!referencedPaths.has(filePath)) {
          orphaned.push(filePath);
        }
      });

      if (orphaned.length === 0) {
        ctx.ui.notify("No orphaned artifacts found.", "info");
        return;
      }

      if (!confirm) {
        const lines = [
          `Found ${orphaned.length} orphaned artifact(s):`,
          ...orphaned.map((p) => `  ${path.relative(ctx.cwd, p)}`),
          "",
          "Run /compaction-clean --confirm to delete.",
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // Delete orphaned files
      let deleted = 0;
      for (const filePath of orphaned) {
        try {
          fs.unlinkSync(filePath);
          deleted++;
        } catch {
          // Skip files that can't be deleted
        }
      }

      ctx.ui.notify(`Deleted ${deleted} orphaned artifact(s).`, "info");
    },
  });
}

/** Recursively scan a directory, calling callback for each file. */
function scanDirectory(dir: string, callback: (filePath: string) => void): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDirectory(fullPath, callback);
      } else if (entry.isFile()) {
        callback(fullPath);
      }
    }
  } catch {
    // Skip unreadable directories
  }
}
