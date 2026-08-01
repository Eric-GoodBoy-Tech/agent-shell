/**
 * cli-handlers.ts — Pure domain-logic handler functions extracted from cli.ts.
 *
 * Each handler takes parsed arguments and returns a structured result:
 *   { exitCode: number, stdout?: string, stderr?: string } | Promise<same>
 *
 * Handlers NEVER call process.exit(). The dispatcher in cli.ts handles that.
 */
import { loadConfig } from "./config.ts";
import { initCommand } from "./init.ts";
import { prefixChain, formatChainOutput, formatChainPaths } from "./prefix-chain.ts";
import { callApi, callApiStream } from "./call.ts";
import { createNode } from "./node-create.ts";
import { buildContext, detectPendingTool } from "./context.ts";
import { validateCredential } from "./credential.ts";
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolves the nodes directory path.
 * Priority: $AGENT_NODES_PATH (explicit override) > ./.agsh/nodes (project local)
 */
function resolveNodesPath(): string {
  if (process.env.AGENT_NODES_PATH) {
    return process.env.AGENT_NODES_PATH;
  }
  return ".agsh/nodes";
}

// ── Handler result types ──────────────────────────────────────────────

export interface HandlerResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface StreamHandlerResult {
  exitCode: number;
  stdoutLines: string[];
  stderr?: string;
}

// ── handleInit ────────────────────────────────────────────────────────

/**
 * Initialize the nodes directory with root node.
 * Contains the init command logic from cli.ts lines 74-78.
 */
export async function handleInit(nodesPath: string): Promise<HandlerResult> {
  try {
    const result = await initCommand(nodesPath);
    return {
      exitCode: result.success ? 0 : 1,
      stdout: result.message,
    };
  } catch (error) {
    return {
      exitCode: 1,
      stderr: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── handleCall ────────────────────────────────────────────────────────

/**
 * Make an LLM API call with the shell tool.
 * Parses --messages or --messages-file from args.
 * Contains lines 80-116.
 */
export async function handleCall(args: string[]): Promise<HandlerResult> {
  const messagesIdx = args.indexOf("--messages");
  const messagesFileIdx = args.indexOf("--messages-file");

  let messages;
  if (messagesFileIdx !== -1 && messagesFileIdx + 1 < args.length) {
    try {
      const content = await Bun.file(args[messagesFileIdx + 1]).text();
      messages = JSON.parse(content);
    } catch (e) {
      return {
        exitCode: 1,
        stderr: `Error: failed to read messages file: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } else if (messagesIdx !== -1 && messagesIdx + 1 < args.length) {
    try {
      messages = JSON.parse(args[messagesIdx + 1]);
    } catch {
      return {
        exitCode: 1,
        stderr: "Error: --messages must be valid JSON",
      };
    }
  } else {
    return {
      exitCode: 1,
      stderr: "Error: --messages <json> or --messages-file <path> is required for call command",
    };
  }

  try {
    const result = await callApi({ messages });
    if (result.exitCode !== 0) {
      return {
        exitCode: 1,
        stderr: result.error || "API error",
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify(result.message),
      stderr: result.usage ? JSON.stringify(result.usage) : undefined,
    };
  } catch (error) {
    return {
      exitCode: 1,
      stderr: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── handleStream ──────────────────────────────────────────────────────

/**
 * Stream LLM API response via SSE events.
 * SSE data events are written directly to process.stdout inside the handler.
 * Contains lines 118-221.
 */
export async function handleStream(args: string[]): Promise<StreamHandlerResult> {
  // Parse arguments
  const sMessagesIdx = args.indexOf("--messages");
  const sMessagesFileIdx = args.indexOf("--messages-file");
  const credIdx = args.indexOf("--cred");
  const nodesIdx = args.indexOf("--nodes-path");

  const credential = credIdx !== -1 && credIdx + 1 < args.length ? args[credIdx + 1] : undefined;
  const nodesPath = nodesIdx !== -1 && nodesIdx + 1 < args.length ? args[nodesIdx + 1] : ".agsh/nodes";

  let sMessages: any[];
  if (credential) {
    // History is the authoritative source — build context from it
    try {
      sMessages = await buildContext(credential, nodesPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stdout.write("data: " + JSON.stringify({ type: "fatal", error: msg }) + "\n\n");
      return { exitCode: 1, stdoutLines: [], stderr: undefined };
    }
  } else if (sMessagesFileIdx !== -1 && sMessagesFileIdx + 1 < args.length) {
    try {
      const content = await Bun.file(args[sMessagesFileIdx + 1]).text();
      sMessages = JSON.parse(content);
    } catch (e) {
      return {
        exitCode: 1,
        stdoutLines: [],
        stderr: `Error: failed to read messages file: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } else if (sMessagesIdx !== -1 && sMessagesIdx + 1 < args.length) {
    try {
      sMessages = JSON.parse(args[sMessagesIdx + 1]);
    } catch {
      return {
        exitCode: 1,
        stdoutLines: [],
        stderr: "Error: --messages must be valid JSON",
      };
    }
  } else {
    return {
      exitCode: 1,
      stdoutLines: [],
      stderr: "Error: --cred <id>, --messages <json>, or --messages-file <path> is required for stream command",
    };
  }

  const sConfig = loadConfig();
  let accumulatedContent = "";
  let accumulatedReasoning = "";
  let accumulatedTcCalls: any = null;
  let reasoningFile = "";

  for await (const event of callApiStream(
    sMessages,
    sConfig.AGENT_API_KEY,
    sConfig.AGENT_BASE_URL,
    sConfig.AGENT_MODEL,
    sConfig.AGENT_REASONING_EFFORT,
  )) {
    // Intercept content_done: capture content + write reasoning to file
    if (event.type === "content_done") {
      accumulatedContent = event.content || "";
      accumulatedReasoning = event.reasoning_content || "";
      if (accumulatedReasoning && credential) {
        reasoningFile = `.agsh/tmp/agent_reasoning_${credential}.txt`;
        try {
          await Bun.write(reasoningFile, accumulatedReasoning);
        } catch {
          /* ignore */
        }
      }
    }

    // Intercept tool_calls: capture for history
    if (event.type === "tool_calls") {
      accumulatedTcCalls = event.calls;
    }

    // Intercept done: write history JSONL, emit compact state without reasoning_content
    if (event.type === "done" && credential) {
      const historyFile = join(nodesPath, credential, "history");
      const msg: Record<string, any> = {
        role: "assistant",
        content: accumulatedContent || null,
        reasoning_content: accumulatedReasoning || null,
      };
      if (accumulatedTcCalls && accumulatedTcCalls.length > 0) {
        msg.tool_calls = accumulatedTcCalls;
      }
      try {
        const dir = join(nodesPath, credential);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(historyFile, JSON.stringify([msg]) + "\n", "utf-8");
      } catch {
        /* ignore write errors */
      }

      // Emit compact done: reasoning_file path instead of full reasoning_content
      const compact: Record<string, any> = {
        type: "done",
        reasoning_file: reasoningFile || undefined,
        content: accumulatedContent || undefined,
        usage: event.usage,
      };
      if (accumulatedTcCalls && accumulatedTcCalls.length > 0) {
        compact.tool_calls = accumulatedTcCalls;
      }
      process.stdout.write(`data: ${JSON.stringify(compact)}\n\n`);
    } else if (event.type !== "done") {
      // Pass through all non-done events unchanged
      process.stdout.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }

  return { exitCode: 0, stdoutLines: [], stderr: undefined };
}

// ── handlePrefixChain ─────────────────────────────────────────────────

/**
 * Traverse the prefix chain (context nodes or plug paths).
 * Contains lines 223-254.
 */
export function handlePrefixChain(args: string[]): HandlerResult {
  // Parse --cred argument
  const credIdx = args.indexOf("--cred");
  if (credIdx === -1 || credIdx + 1 >= args.length) {
    return {
      exitCode: 1,
      stderr: "Error: --cred <id> is required for prefix-chain command",
    };
  }
  const credential = args[credIdx + 1];

  // Check for plug mode
  const typeIdx = args.indexOf("--type");
  const isPlug = typeIdx !== -1 && args[typeIdx + 1] === "plug";
  const pathsIdx = args.indexOf("--paths");
  const usePaths = pathsIdx !== -1;

  const nodesPath = resolveNodesPath();
  const nodes = prefixChain(nodesPath, credential, usePaths ? "paths" : "content");

  if (isPlug && usePaths) {
    // Plug mode — output file paths
    const paths = formatChainPaths(nodesPath, nodes);
    return { exitCode: 0, stdout: paths.join("\n"), stderr: undefined };
  } else {
    // Context mode — output id\tcontent
    const lines = formatChainOutput(nodes);
    return { exitCode: 0, stdout: lines.join("\n"), stderr: undefined };
  }
}
// ── handleNodeCreate ──────────────────────────────────────────────────

/**
 * Create a new node.
 * Contains lines 256-300.
 */
export async function handleNodeCreate(args: string[]): Promise<HandlerResult> {
  const subCmd = args[1];
  if (subCmd !== "create") {
    return {
      exitCode: 1,
      stderr: `Error: unknown node subcommand: ${subCmd}\nUsage: agsh node create --parent <id> --id <node-id> [--context <text>] [--plug <text>]`,
    };
  }

  // Parse arguments
  const idIdx = args.indexOf("--id");
  const parentIdx = args.indexOf("--parent");
  const contextIdx = args.indexOf("--context");
  const plugIdx = args.indexOf("--plug");

  if (idIdx === -1 || parentIdx === -1 || (contextIdx === -1 && plugIdx === -1)) {
    return {
      exitCode: 1,
      stderr: "Error: --id, --parent, and at least one of --context or --plug are required for node create",
    };
  }

  const parent = args[parentIdx + 1];
  const context = contextIdx !== -1 ? args[contextIdx + 1] : undefined;
  const plug = plugIdx !== -1 ? args[plugIdx + 1] : undefined;
  const customId = args[idIdx + 1];

  if (!parent || (context === undefined && plug === undefined) || !customId) {
    return {
      exitCode: 1,
      stderr: "Error: --id, --parent, and at least one of --context or --plug values are required",
    };
  }

  try {
    const result = await createNode({
      nodesPath: resolveNodesPath(),
      parent,
      context,
      plug,
      id: customId,
    });

    if (!result.success) {
      return {
        exitCode: 1,
        stderr: `Error: ${result.error}`,
      };
    }

    return {
      exitCode: 0,
      stdout: result.id!,
    };
  } catch (error) {
    return {
      exitCode: 1,
      stderr: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── handleCredentialValidate ──────────────────────────────────────────

/**
 * Validate a credential ID (4-layer check).
 * Contains lines 302-322.
 */
export function handleCredentialValidate(args: string[]): HandlerResult {
  const subCmd = args[1];
  if (subCmd !== "validate") {
    return {
      exitCode: 1,
      stderr: `Error: unknown credential subcommand: ${subCmd}\nUsage: agsh credential validate <id>`,
    };
  }

  const id = args[2];
  if (!id) {
    return {
      exitCode: 1,
      stderr: "Error: credential id is required",
    };
  }

  const result = validateCredential(id, resolveNodesPath());
  if (!result.valid) {
    return {
      exitCode: 1,
      stderr: result.error!,
    };
  }
  return { exitCode: 0 };
}

// ── handleContextBuild ────────────────────────────────────────────────

/**
 * Build full AGENT_CONTEXT messages array.
 * Contains lines 326-336.
 */
export async function handleContextBuild(args: string[]): Promise<HandlerResult> {
  const credIdx = args.indexOf("--cred");
  if (credIdx === -1 || credIdx + 1 >= args.length) {
    return {
      exitCode: 1,
      stderr: "Error: --cred <id> is required for context build",
    };
  }
  const credential = args[credIdx + 1];
  const messages = await buildContext(credential, resolveNodesPath());
  return {
    exitCode: 0,
    stdout: JSON.stringify(messages),
  };
}

// ── handleContextDetectPending ────────────────────────────────────────

/**
 * Detect next unexecuted tool call in history.
 * Contains lines 339-351.
 */
export function handleContextDetectPending(args: string[]): HandlerResult {
  const credIdx = args.indexOf("--cred");
  if (credIdx === -1 || credIdx + 1 >= args.length) {
    return {
      exitCode: 1,
      stderr: "Error: --cred <id> is required for context detect-pending",
    };
  }
  const credential = args[credIdx + 1];
  const tool = detectPendingTool(credential, resolveNodesPath());
  return {
    exitCode: 0,
    stdout: tool ? JSON.stringify(tool) : undefined,
  };
}

// ── handleContextRecordTool ───────────────────────────────────────────

/**
 * Write a tool result message to history JSONL.
 * Contains lines 353-372.
 */
export function handleContextRecordTool(args: string[]): HandlerResult {
  const credIdx2 = args.indexOf("--cred");
  const nodesIdx2 = args.indexOf("--nodes-path");
  const idIdx2 = args.indexOf("--id");
  const contentFileIdx2 = args.indexOf("--content-file");
  if (credIdx2 === -1 || nodesIdx2 === -1 || idIdx2 === -1 || contentFileIdx2 === -1) {
    return {
      exitCode: 1,
      stderr: "Error: --cred, --nodes-path, --id, and --content-file are required for context record-tool",
    };
  }
  const cred = args[credIdx2 + 1];
  const np = args[nodesIdx2 + 1];
  const tid = args[idIdx2 + 1];
  const cf = args[contentFileIdx2 + 1];
  const toolContent = readFileSync(cf, "utf-8");
  const histFile = join(np, cred, "history");
  const dir = join(np, cred);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(histFile, JSON.stringify([{ role: "tool", tool_call_id: tid, content: toolContent }]) + "\n", "utf-8");
  return { exitCode: 0 };
}
