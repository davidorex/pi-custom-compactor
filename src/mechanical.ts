import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtractSpec } from "./types.js";

/**
 * Regex pattern for detecting user corrections and redirects.
 * Uses per-alternative \b placement since some patterns end in non-word chars (no,. don't).
 */
const CORRECTION_REGEX =
  /\b(?:no[,.]|wrong\b|not what\b|instead\b|actually\b|don't|stop\b|should be\b|prefer\b|always\b|never\b)/i;

/**
 * Safely extract text content from any AgentMessage.
 *
 * User messages have `content: (TextContent | ImageContent)[]`.
 * Filter for `type === "text"` blocks and join their text.
 * For non-user messages or unexpected shapes, return empty string.
 */
export function extractText(msg: AgentMessage): string {
  if (msg.role !== "user") return "";
  const content = (msg as any).content;
  if (!Array.isArray(content)) {
    if (typeof content === "string") return content;
    return "";
  }
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

/**
 * Scan user messages for correction patterns.
 * Returns matching messages with timestamp and truncated text (max 500 chars).
 */
export function extractCorrections(
  messages: AgentMessage[],
): Array<{ timestamp: number; text: string }> {
  const corrections: Array<{ timestamp: number; text: string }> = [];

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const text = extractText(msg);
    if (!text) continue;
    if (CORRECTION_REGEX.test(text)) {
      corrections.push({
        timestamp: msg.timestamp,
        text: text.slice(0, 500),
      });
    }
  }

  return corrections;
}

/**
 * Extract file operations from messages by inspecting tool calls and results.
 *
 * Looks at assistant messages for tool calls (read, write, edit) and
 * extracts file paths from their arguments.
 */
export function extractFileOps(
  messages: AgentMessage[],
): { read: string[]; modified: string[] } {
  const readSet = new Set<string>();
  const modifiedSet = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      // Look for tool calls in assistant messages
      const content = (msg as any).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== "toolCall") continue;
        const toolName = block.name ?? block.toolName;
        const args = block.args ?? block.arguments ?? block.input;
        if (!args) continue;
        const filePath = typeof args === "object" ? (args.path ?? args.file) : undefined;
        if (!filePath || typeof filePath !== "string") continue;

        if (toolName === "read") {
          readSet.add(filePath);
        } else if (toolName === "write" || toolName === "edit") {
          modifiedSet.add(filePath);
        }
      }
    } else if (msg.role === "toolResult") {
      // Tool results can also indicate file operations
      const toolName = (msg as any).toolName;
      const filePath = (msg as any).details?.path;
      if (filePath && typeof filePath === "string") {
        if (toolName === "read") {
          readSet.add(filePath);
        } else if (toolName === "write" || toolName === "edit") {
          modifiedSet.add(filePath);
        }
      }
    }
  }

  return {
    read: [...readSet].sort(),
    modified: [...modifiedSet].sort(),
  };
}

/**
 * Dispatcher for mechanical extraction strategies.
 *
 * Known names:
 * - "user-corrections": extractCorrections
 * - "file-awareness": extractFileOps
 *
 * Unknown names return [] as a graceful fallback.
 */
export function runMechanicalExtract(
  name: string,
  _extract: ExtractSpec,
  messages: AgentMessage[],
): unknown {
  if (name === "user-corrections") {
    return extractCorrections(messages);
  }
  if (name === "file-awareness") {
    return extractFileOps(messages);
  }
  // Graceful fallback for unknown mechanical extracts
  return [];
}
