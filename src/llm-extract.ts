import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ExtractSpec } from "./types.js";

/** Result from an LLM extraction, including parsed data and optional usage stats. */
export interface LlmExtractResult {
  data: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  /** Present when the extraction failed — carries the underlying error message. */
  error?: string;
}

/**
 * Pick a model for summarization extraction.
 *
 * Tries to find a cheaper model (Claude Haiku) with a usable API key.
 * Falls back to ctx.model — the session model already in use, which is
 * guaranteed to have working authentication.
 * Returns null only if ctx.model is also undefined.
 */
export async function pickSummarizationModel(ctx: ExtensionContext): Promise<Model<any> | null> {
  // Try a cheaper model if available and authenticated
  const haiku = ctx.modelRegistry.find("anthropic", "claude-haiku");
  if (haiku) {
    const apiKey = await ctx.modelRegistry.getApiKey(haiku);
    if (apiKey) return haiku;
  }

  // Fall back to the session model (already in use, already authenticated)
  return ctx.model ?? null;
}

/**
 * Build the extraction prompt for an LLM extract.
 *
 * Includes the extract name, description, format, and conversation text.
 * If maxTokens is set, adds a conciseness constraint.
 */
export function buildExtractionPrompt(
  name: string,
  extract: ExtractSpec,
  conversationText: string,
): string {
  const parts: string[] = [];

  parts.push(`Extract "${name}" from the following conversation.`);
  parts.push(`Description: ${extract.description}`);
  parts.push(`Output format: ${extract.format}`);

  if (extract.maxTokens) {
    const approxChars = extract.maxTokens * 4;
    parts.push(
      `Keep your output concise, aiming for under ${extract.maxTokens} tokens (approximately ${approxChars} characters).`,
    );
  }

  parts.push(`Output valid JSON only, no explanation.`);
  parts.push("");
  parts.push("<conversation>");
  parts.push(conversationText);
  parts.push("</conversation>");

  return parts.join("\n");
}

/**
 * Parse JSON from an LLM response.
 *
 * Strategy:
 * 1. Try direct JSON.parse
 * 2. Try extracting from markdown code fences (```json ... ``` or ``` ... ```)
 * 3. Return null on failure
 */
export function parseJsonResponse(text: string): unknown {
  // 1. Direct parse
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  // 2. Try markdown code fences
  const fencePattern = /```(?:json)?\s*\n?([\s\S]*?)```/;
  const match = text.match(fencePattern);
  if (match) {
    try {
      return JSON.parse(match[1].trim());
    } catch {
      // continue
    }
  }

  return null;
}

/**
 * Run an LLM-based extraction on the given messages.
 *
 * Serializes messages, builds a prompt, calls complete(), and parses the JSON response.
 * Returns the parsed data and usage stats, or null on failure.
 */
export async function runLlmExtract(
  name: string,
  extract: ExtractSpec,
  messages: AgentMessage[],
  model: Model<any>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<LlmExtractResult | null> {
  try {
    const llmMessages = convertToLlm(messages);
    const conversationText = serializeConversation(llmMessages);
    const prompt = buildExtractionPrompt(name, extract, conversationText);

    const response = await complete(
      model,
      {
        messages: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: 4096,
        signal,
      },
    );

    // Extract text from response
    const responseText = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const data = parseJsonResponse(responseText);

    const usage = response.usage
      ? {
          inputTokens: response.usage.input,
          outputTokens: response.usage.output,
        }
      : undefined;

    return { data, usage };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { data: null, error: errorMsg };
  }
}
