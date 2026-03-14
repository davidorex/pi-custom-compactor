/** Priority levels for extract artifacts. Higher priority = kept under budget pressure. */
export type Priority = "critical" | "high" | "normal" | "low";

/** Extraction strategy. */
export type Strategy = "mechanical" | "llm";

/** Overflow strategy when reassembly exceeds token budget. */
export type OverflowStrategy = "trim-lowest" | "truncate-all";

/** A single extract declaration from the compaction spec. */
export interface ExtractSpec {
  /** What to extract — used in LLM prompts. */
  description: string;
  /** Artifact file path (relative to cwd). */
  persist: string;
  /** JSON shape description — used in LLM prompts. */
  format: string;
  /** Extraction strategy. */
  strategy: Strategy;
  /** Optional token cap for the artifact. */
  maxTokens?: number;
  /** Optional entry count cap (mechanical only). */
  maxEntries?: number;
  /** Priority for budget enforcement. Default: "normal". */
  priority?: Priority;
}

/** A source entry in the reassemble section. */
export interface ReassembleSource {
  /** Artifact path — should match a persist path from extracts. */
  source: string;
  /** Label prefix shown before the artifact content. */
  as: string;
  /** XML tag name wrapping the artifact data. */
  wrap: string;
}

/** Reassembly configuration. */
export interface ReassembleSpec {
  /** Global token budget for all reassembled artifacts. */
  budget?: number;
  /** Overflow handling strategy. Default: "trim-lowest". */
  overflow?: OverflowStrategy;
  /** Ordered list of artifact sources to inject. */
  sources: ReassembleSource[];
}

/** Top-level compaction spec parsed from YAML. */
export interface CompactionSpec {
  /** Named extract declarations. */
  extracts: Record<string, ExtractSpec>;
  /** Reassembly configuration. */
  reassemble?: ReassembleSpec;
}

/** Per-artifact stats recorded after compaction. */
export interface ArtifactStats {
  path: string;
  /** Estimated tokens (chars/4 heuristic). */
  tokens: number;
  /** Raw file size in bytes. */
  sizeBytes: number;
  /** Item count for array artifacts. */
  entries?: number;
  strategy: Strategy;
  /** True if maxTokens/maxEntries cap was applied. */
  trimmed?: boolean;
  /** LLM extraction cost (only for strategy: "llm"). */
  extractCost?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/** Stats recorded per compaction cycle. */
export interface CompactionStats {
  timestamp: number;
  /** Pre-compaction context token count. */
  tokensBefore: number;
  /** Tokens in the composed summary. */
  summaryTokens: number;
  /** Total tokens injected by context hook. */
  reassemblyTokens: number;
  /** From spec, null if uncapped. */
  reassemblyBudget: number | null;
  /** Model's context window size. */
  contextWindow: number;
  /** Per-artifact stats. */
  artifacts: Record<string, ArtifactStats>;
  /** Total LLM extraction cost. */
  totalExtractCost: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Which spec produced this compaction. */
  specName: string;
  /** Resolved path to the YAML file. */
  specPath: string;
}

/** Stored in CompactionEntry.details. */
export interface CompactionDetails {
  artifactIndex: Record<string, { path: string; strategy: string }>;
  stats: CompactionStats;
}
