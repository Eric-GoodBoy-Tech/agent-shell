import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prefixChain } from "./prefix-chain.ts";
import type { Message, ToolCall } from "./types.ts";
/**
 * JSONL history: each line is a JSON array (not a single message);
 * all lines are flattened into one array.
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

/** Drop tool-result messages whose tool_call_id already appeared earlier in the list (first occurrence wins). */

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
 * System messages from the prefix chain + deduplicated history (JSONL under
 * <nodesPath>/<credential>/history) + credential node content as the user message.
 */
export async function buildContext(
  credential: string,
  nodesPath: string,
  chain: typeof prefixChain = prefixChain,
): Promise<Message[]> {
  const credDir = join(nodesPath, credential);
  const historyFile = join(credDir, "history");
  const contextFile = join(credDir, "context");

  const messages: Message[] = [];

  const chainNodes = chain(nodesPath, credential, "content");
  for (const node of chainNodes) {
    messages.push({
      role: "system",
      content: `[node-${node.id}]\n${node.content}`,
    });
  }

  const allMsgs = readHistory(historyFile);
  const historyMsgs = dedupToolResults(allMsgs);

  // If history has no user message, inject credential content as the initial user message
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

  // Text-only assistant ending violates protocol; inject <recover> before continuing
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === "assistant" && !lastMsg.tool_calls?.length) {
    const recoverMsg = {
      role: "user" as const,
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

/** Find the newest assistant tool call that has no matching tool response in history yet; null when nothing is pending. */

export function detectPendingTool(
  credential: string,
  nodesPath: string,
): ToolCall | null {
  const historyFile = join(nodesPath, credential, "history");
  const allMsgs = readHistory(historyFile);

  if (allMsgs.length === 0) return null;

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

  for (const call of lastAssistantCalls) {
    const hasResult = allMsgs.some(
      (m) => m.role === "tool" && m.tool_call_id === call.id,
    );
    if (!hasResult) return call;
  }

  return null;
}

export interface SaveDeltaResult {
  saved: number;
  total: number;
}

/**
 * Reads the full context from a temp file, appends the delta (messages from the
 * given index) as a JSON array line to the history JSONL file, and dumps the
 * full context to .agsh/tmp/agent_context_<cred>.json for inspection.
 */
export function saveDelta(
  credential: string,
  nodesPath: string,
  contextFilePath: string,
  fromIndex: number,
  dumpDir: string = ".agsh/tmp",
): SaveDeltaResult {
  const historyFile = join(nodesPath, credential, "history");
  const dumpFile = join(dumpDir, `agent_context_${credential}.json`);

  let context: Message[];
  try {
    const raw = readFileSync(contextFilePath, "utf-8");
    context = JSON.parse(raw);
  } catch {
    return { saved: 0, total: 0 };
  }

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

  try {
    writeFileSync(dumpFile, JSON.stringify(context), "utf-8");
  } catch {
    // ignore
  }

  return { saved, total: context.length };
}

/**
 * Accepts either a full Message JSON (has a .role field) or plain text,
 * which is wrapped as { role, content }.
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
 * Wire format: { role: "tool", tool_call_id: toolCallId, content: content }
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

