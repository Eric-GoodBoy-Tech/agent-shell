import { readFileSync, existsSync, appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { prefixChain } from "./prefix-chain.ts";
import type { Message, ToolCall } from "./types.ts";
/**
 * Parses a JSONL history file into a flat array of messages.
 * Each line is a JSON array; all arrays are flattened into one.
 */
function readHistory(historyFile: string): Message[] {
  if (!existsSync(historyFile)) return [];

  try {
    const raw = readFileSync(historyFile, "utf-8").trim();
    if (!raw) return [];

    const allMsgs: Message[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          allMsgs.push(...parsed);
        }
      } catch {
        // skip malformed lines
      }
    }
    return allMsgs;
  } catch {
    return [];
  }
}

/**
 * Deduplicates tool result messages by tool_call_id.
 * When two tool results share the same tool_call_id, only the first is kept.
 */
function dedupToolResults(msgs: Message[]): Message[] {
  const seen = new Set<string>();
  return msgs.filter((m) => {
    if (m.role === "tool" && m.tool_call_id) {
      if (seen.has(m.tool_call_id)) return false;
      seen.add(m.tool_call_id);
    }
    return true;
  });
}

/**
 * Builds the complete AGENT_CONTEXT messages array for an API call.
 *
 * Steps:
 * 1. Build system messages from prefix chain (parent→root of the credential node)
 * 2. Read and deduplicate history from nodes/<cred>/history (JSONL)
 * 3. If history exists, append it; otherwise use credential content as initial user message
 *
 * Output: JSON array of messages to stdout.
 */
export async function buildContext(
  credential: string,
  nodesPath: string,
): Promise<Message[]> {
  const credDir = join(nodesPath, credential);
  const historyFile = join(credDir, "history");
  const contextFile = join(credDir, "context");

  const messages: Message[] = [];

  // Step 1: Build system messages from prefix chain
  const chain = prefixChain(nodesPath, credential, "content");
  for (const node of chain) {
    messages.push({
      role: "system",
      content: `[node-${node.id}]\n${node.content}`,
    });
  }

  // Step 2: Read and deduplicate history
  const allMsgs = readHistory(historyFile);
  const historyMsgs = dedupToolResults(allMsgs);

  // Step 3: Always include credential user message, then append history
  const hasUser = historyMsgs.some((m) => m.role === "user");
  if (!hasUser) {
    let credContent = "";
    try {
      credContent = readFileSync(contextFile, "utf-8").trim();
    } catch {
      // ignore
    }

    messages.push({
      role: "user",
      content: `[node-${credential}]\n${credContent || "Continue."}`,
    });
  }
  messages.push(...historyMsgs);

  // Step 4: Inject recover if last message is text-only assistant
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === "assistant" && !lastMsg.tool_calls?.length) {
    const recoverMsg = {
      role: "system" as const,
      content: [
        "<recover>",
        "Your last response violated the protocol.",
        "",
        "Re-read the root prompt. Re-evaluate.",
        "Determine the correct action. Execute it.",
        "</recover>",
      ].join("\n"),
    };
    // Write to history so the warning accumulates
    try {
      appendFileSync(historyFile, JSON.stringify([recoverMsg]) + "\n", "utf-8");
    } catch {
      // ignore
    }
    // Also include in this API call's messages
    messages.push(recoverMsg);
  }

  return messages;
}

/**
 * Detects the next pending tool call in the history that hasn't been executed yet.
 *
 * Scans the history JSONL for the most recent assistant message with tool_calls,
 * then checks which tool calls lack a corresponding tool result message.
 *
 * Output: JSON object of the first pending tool call to stdout, or empty output if none.
 */
export function detectPendingTool(
  credential: string,
  nodesPath: string,
): ToolCall | null {
  const historyFile = join(nodesPath, credential, "history");
  const allMsgs = readHistory(historyFile);

  if (allMsgs.length === 0) return null;

  // Find the LAST assistant message with tool_calls
  let lastAssistantCalls: ToolCall[] = [];
  for (let i = allMsgs.length - 1; i >= 0; i--) {
    const msg = allMsgs[i];
    if (
      msg.role === "assistant" &&
      msg.tool_calls &&
      msg.tool_calls.length > 0
    ) {
      lastAssistantCalls = msg.tool_calls;
      break;
    }
  }

  if (lastAssistantCalls.length === 0) return null;

  // Find the first call without a matching tool result
  for (const call of lastAssistantCalls) {
    const hasResult = allMsgs.some(
      (m) => m.role === "tool" && m.tool_call_id === call.id,
    );
    if (!hasResult) return call;
  }

  return null;
}

/**
 * Context delta save result.
 */
export interface SaveDeltaResult {
  /** Number of new messages saved to history */
  saved: number;
  /** Total messages in context */
  total: number;
}

/**
 * Saves the delta of new context messages to the history file.
 *
 * Reads the full context from a temp file, computes delta from the given index,
 * appends the delta as a JSON array line to the history JSONL file,
 * and dumps the full context to .agsh/tmp/agent_context_<cred>.json for inspection.
 *
 * Output: JSON { saved, total } to stdout.
 */
export function saveDelta(
  credential: string,
  nodesPath: string,
  contextFilePath: string,
  fromIndex: number,
): SaveDeltaResult {
  const historyFile = join(nodesPath, credential, "history");
  const dumpFile = `.agsh/tmp/agent_context_${credential}.json`;

  let context: Message[];
  try {
    const raw = readFileSync(contextFilePath, "utf-8");
    context = JSON.parse(raw);
  } catch {
    return { saved: 0, total: 0 };
  }

  // Compute delta: messages from fromIndex to end
  let saved = 0;
  if (fromIndex >= 0 && fromIndex < context.length) {
    const delta = context.slice(fromIndex);
    if (delta.length > 0) {
      try {
        appendFileSync(historyFile, JSON.stringify(delta) + "\n", "utf-8");
        saved = delta.length;
      } catch {
        // ignore write errors
      }
    }
  }

  // Dump full context for inspection
  try {
    writeFileSync(dumpFile, JSON.stringify(context), "utf-8");
  } catch {
    // ignore
  }

  return { saved, total: context.length };
}

/**
 * Appends a message to the context array.
 * If the message JSON already has a .role field, it's treated as a complete Message object.
 * Otherwise, it's wrapped as {role, content}.
 *
 * Mirrors the zsh _append_to_context function exactly.
 */
export function appendToContext(
  context: Message[],
  role: string,
  message: string
): Message[] {
  let msgObj: Message;
  try {
    const parsed = JSON.parse(message);
    if (parsed.role) {
      msgObj = parsed as Message;
    } else {
      msgObj = { role, content: message };
    }
  } catch {
    msgObj = { role, content: message };
  }
  return [...context, msgObj];
}

/**
 * Appends a tool result message to the context array.
 * Format: {role: "tool", tool_call_id: toolCallId, content: content}
 *
 * Mirrors the zsh _append_tool_result function exactly.
 */
export function appendToolResult(
  context: Message[],
  toolCallId: string,
  content: string
): Message[] {
  return [...context, {
    role: "tool",
    tool_call_id: toolCallId,
    content,
  }];
}

/**
 * Finalizes the API cycle by constructing the assistant message and appending to context.
 * Reads reasoning content from a temp file (to avoid passing large strings through shell/FIFO).
 *
 * Mirrors the zsh api_done handler's _append_to_context + jq message construction.
 */
export function finalizeContext(
  context: Message[],
  reasoningFile: string,
  content: string,
  toolCallsJson?: string,
): Message[] {
  // Read reasoning from temp file
  let reasoning = "";
  if (reasoningFile) {
    try {
      reasoning = readFileSync(reasoningFile, "utf-8");
      unlinkSync(reasoningFile);  // clean up
    } catch {
      // ignore
    }
  }

  // Construct assistant message
  const msg: Message = {
    role: "assistant",
    content: content || null,
    reasoning_content: reasoning || null,
  };
  if (toolCallsJson) {
    try {
      const calls = JSON.parse(toolCallsJson);
      if (Array.isArray(calls) && calls.length > 0) {
        msg.tool_calls = calls;
      }
    } catch {
      // ignore malformed tool_calls
    }
  }

  // Append to context
  return [...context, msg];
}
