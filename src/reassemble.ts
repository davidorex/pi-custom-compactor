import * as fs from "node:fs";
import * as path from "node:path";
import { resolveArtifactPath } from "./spec.js";
import { estimateTokens } from "./tokens.js";
import { readStats, formatTrend, formatNumber } from "./stats.js";
import type {
  CompactionSpec,
  Priority,
  OverflowStrategy,
  ReassembleSource,
} from "./types.js";

/** A loaded artifact ready for reassembly. */
export interface ReassembledArtifact {
  /** Artifact path from ReassembleSource.source */
  source: string;
  /** Label prefix from ReassembleSource.as */
  as: string;
  /** XML wrap tag from ReassembleSource.wrap */
  wrap: string;
  /** Raw file content (JSON string) */
  data: string;
  /** Estimated tokens */
  tokens: number;
  /** Priority from matching extract spec */
  priority: Priority;
}

/** Result of budget enforcement. */
export interface BudgetResult {
  artifacts: ReassembledArtifact[];
  dropped: string[];
}

const PRIORITY_ORDER: Record<Priority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

/**
 * Read all artifacts listed in spec.reassemble.sources.
 * Looks up priority from matching extract in spec.extracts.
 * Skips artifacts whose files don't exist or can't be read.
 */
export function readReassemblyArtifacts(
  spec: CompactionSpec,
  cwd: string,
): ReassembledArtifact[] {
  if (!spec.reassemble) return [];

  const artifacts: ReassembledArtifact[] = [];

  for (const source of spec.reassemble.sources) {
    const filePath = resolveArtifactPath(source.source, cwd);
    let data: string;
    try {
      data = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue; // skip missing/unreadable files
    }

    // Find priority from matching extract
    const priority = findPriority(spec, source.source);

    artifacts.push({
      source: source.source,
      as: source.as,
      wrap: source.wrap,
      data,
      tokens: estimateTokens(data),
      priority,
    });
  }

  return artifacts;
}

/**
 * Find the priority for an artifact by matching its source path
 * against extract persist paths. Defaults to "normal".
 */
function findPriority(spec: CompactionSpec, sourcePath: string): Priority {
  for (const extract of Object.values(spec.extracts)) {
    if (extract.persist === sourcePath) {
      return extract.priority ?? "normal";
    }
  }
  return "normal";
}

/**
 * Enforce the global token budget on reassembled artifacts.
 *
 * If no budget is set, returns artifacts unchanged.
 * If under budget, returns unchanged.
 * Otherwise applies the overflow strategy.
 */
export function enforceBudget(
  artifacts: ReassembledArtifact[],
  budget: number | undefined,
  overflow: OverflowStrategy = "trim-lowest",
): BudgetResult {
  if (budget == null) {
    return { artifacts, dropped: [] };
  }

  const total = artifacts.reduce((sum, a) => sum + a.tokens, 0);
  if (total <= budget) {
    return { artifacts, dropped: [] };
  }

  if (overflow === "trim-lowest") {
    return trimLowest(artifacts, budget);
  } else {
    return truncateAll(artifacts, budget);
  }
}

/**
 * Drop entire lowest-priority artifacts until total is under budget.
 * Never drops critical. If still over budget after dropping all non-critical, keep everything.
 */
function trimLowest(
  artifacts: ReassembledArtifact[],
  budget: number,
): BudgetResult {
  // Sort by priority ascending (low first) for dropping order
  const sorted = [...artifacts].sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
  );

  const kept: ReassembledArtifact[] = [...artifacts];
  const dropped: string[] = [];

  // Try dropping from lowest priority first
  for (const candidate of sorted) {
    if (candidate.priority === "critical") continue;

    const currentTotal = kept.reduce((sum, a) => sum + a.tokens, 0);
    if (currentTotal <= budget) break;

    const idx = kept.findIndex((a) => a.source === candidate.source);
    if (idx !== -1) {
      kept.splice(idx, 1);
      dropped.push(candidate.source);
    }
  }

  return { artifacts: kept, dropped };
}

/**
 * Proportionally truncate all non-critical artifact data strings to fit budget.
 * Critical artifacts keep full size.
 */
function truncateAll(
  artifacts: ReassembledArtifact[],
  budget: number,
): BudgetResult {
  const criticalTokens = artifacts
    .filter((a) => a.priority === "critical")
    .reduce((sum, a) => sum + a.tokens, 0);

  const nonCritical = artifacts.filter((a) => a.priority !== "critical");
  const nonCriticalTokens = nonCritical.reduce((sum, a) => sum + a.tokens, 0);

  // Remaining budget after critical artifacts
  const remaining = budget - criticalTokens;

  if (remaining <= 0 || nonCriticalTokens === 0) {
    // Can't fit anything beyond critical — keep everything as-is
    return { artifacts, dropped: [] };
  }

  const ratio = remaining / nonCriticalTokens;

  const result = artifacts.map((a) => {
    if (a.priority === "critical") return a;

    // Proportionally truncate the data string
    const targetChars = Math.floor(a.data.length * ratio);
    if (targetChars >= a.data.length) return a;

    return {
      ...a,
      data: a.data.slice(0, targetChars),
      tokens: estimateTokens(a.data.slice(0, targetChars)),
    };
  });

  return { artifacts: result, dropped: [] };
}

/**
 * Build synthetic AgentMessages from reassembled artifacts.
 * Returns a single user message with all artifacts as tagged sections.
 * Returns empty array if no artifacts.
 */
export function buildArtifactMessages(
  artifacts: ReassembledArtifact[],
): Array<{
  role: "user";
  content: Array<{ type: "text"; text: string }>;
  timestamp: number;
}> {
  if (artifacts.length === 0) return [];

  const sections = artifacts.map(
    (a) => `${a.as}\n\n<${a.wrap}>\n${a.data}\n</${a.wrap}>`,
  );
  const combinedContent = sections.join("\n\n");

  return [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: combinedContent }],
      timestamp: 0,
    },
  ];
}

/**
 * Build a compact XML stats summary block for injection into context.
 * Returns null if no stats exist.
 */
export function buildStatsSummary(
  cwd: string,
  spec: CompactionSpec,
  specName: string,
  specPath: string,
): string | null {
  const allStats = readStats(cwd);
  if (allStats.length === 0) return null;

  const latest = allStats[allStats.length - 1];

  // Format main compaction line
  const beforeStr = formatNumber(latest.tokensBefore);
  const summaryStr = formatNumber(latest.summaryTokens);
  const reassemblyStr = formatNumber(latest.reassemblyTokens);
  const totalInjected = latest.summaryTokens + latest.reassemblyTokens;
  const pct = ((totalInjected / latest.tokensBefore) * 100).toFixed(1);

  // Format artifact lines
  const artifactParts: string[] = [];
  for (const [name, astats] of Object.entries(latest.artifacts)) {
    let part = `${name} ${formatNumber(astats.tokens)}`;
    const trend = formatTrend(allStats, name);
    if (trend.includes("⚠ growing")) {
      const entries = astats.entries != null ? `, ${astats.entries} entries` : "";
      part += ` (⚠ growing${entries})`;
    }
    artifactParts.push(part);
  }

  // Budget line
  let budgetLine = "";
  if (latest.reassemblyBudget != null) {
    const usedStr = formatNumber(latest.reassemblyTokens);
    const budgetStr = formatNumber(latest.reassemblyBudget);
    const budgetPct = Math.round(
      (latest.reassemblyTokens / latest.reassemblyBudget) * 100,
    );
    budgetLine = `\nReassembly budget: ${usedStr} / ${budgetStr} (${budgetPct}%)`;
  }

  // Extract cost line
  const inputCost = formatNumber(latest.totalExtractCost.inputTokens);
  const outputCost = formatNumber(latest.totalExtractCost.outputTokens);

  const lines = [
    `<compaction-stats>`,
    `Last compaction: ${beforeStr} → ${summaryStr} summary + ${reassemblyStr} reassembly (${pct}% of ${beforeStr} context)`,
    `Artifacts: ${artifactParts.join(", ")}`,
  ];

  if (budgetLine) lines.push(budgetLine.trim());
  lines.push(`Extract cost: ${inputCost} input + ${outputCost} output tokens`);
  lines.push(`Spec: ${specPath} (editable)`);
  lines.push(`</compaction-stats>`);

  return lines.join("\n");
}

/**
 * Build the compaction summary text for CompactionEntry.summary.
 * Composes artifact content as tagged sections, optionally including previous summary.
 */
export function composeSummary(
  spec: CompactionSpec,
  cwd: string,
  previousSummary?: string,
): string {
  const sections: string[] = [];

  if (spec.reassemble) {
    for (const source of spec.reassemble.sources) {
      const filePath = resolveArtifactPath(source.source, cwd);
      let data: string;
      try {
        data = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      sections.push(`${source.as}\n\n<${source.wrap}>\n${data}\n</${source.wrap}>`);
    }
  }

  if (previousSummary) {
    sections.push(
      `<previous-summary>\n${previousSummary}\n</previous-summary>`,
    );
  }

  return sections.join("\n\n");
}
