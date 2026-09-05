/**
 * cli-handlers.ts — Pure domain-logic handlers for each CLI command.
 *
 * Each handler takes parsed arguments and returns a structured result:
 *   { exitCode: number, stdout?: string, stderr?: string } | Promise<same>
 *
 * Handlers NEVER call process.exit(). The dispatcher in cli.ts handles that.
 */
import { agsh } from "./agsh.ts";
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolves the nodes directory path.
 * Priority: $AGENT_NODES_PATH (explicit override) > ./.agsh/nodes (project local)
 */
export function resolveNodesPath(): string {
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

/** init: ensure the nodes directory with a root node exists; relay initCommand's message. */

export async function handleInit(nodesPath: string): Promise<HandlerResult> {
  try {
    const result = await agsh.init.init(nodesPath);
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

/** call: run one non-streaming API call from --messages/--messages-file JSON; assistant message JSON goes to stdout, usage JSON to stderr (keeps stdout parseable). */

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
    const result = await agsh.api.call({ messages });
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

/** stream: relay SSE events from agsh.api.stream to stdout as "data: " lines.
 * With --cred, build messages from history (authoritative source) and on done persist the
 * accumulated assistant message (content/reasoning/tool_calls) to the history JSONL, then
 * emit a compact done event — reasoning_content stays in history, not relayed over the wire. */

export async function handleStream(args: string[]): Promise<StreamHandlerResult> {
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
      sMessages = await agsh.context.build(credential, nodesPath);
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

  const sConfig = agsh.config.load();
  let accumulatedContent = "";
  let accumulatedReasoning = "";
  let accumulatedTcCalls: any = null;

  for await (const event of agsh.api.stream(
    sMessages,
    sConfig.AGENT_API_KEY,
    sConfig.AGENT_BASE_URL,
    sConfig.AGENT_MODEL,
    sConfig.AGENT_REASONING_EFFORT,
  )) {
    // Capture content_done payload for the done record
    if (event.type === "content_done") {
      accumulatedContent = event.content || "";
      accumulatedReasoning = event.reasoning_content || "";
    }

    // Capture tool_calls for the done record
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
      } catch (err) {
        console.warn(
          `Warning: failed to write history for credential ${credential}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      // Emit compact done: reasoning_content stays in history, not relayed over FIFO
      const compact: Record<string, any> = {
        type: "done",
        content: accumulatedContent || undefined,
        usage: event.usage,
      };
      if (accumulatedTcCalls && accumulatedTcCalls.length > 0) {
        compact.tool_calls = accumulatedTcCalls;
      }
      process.stdout.write(`data: ${JSON.stringify(compact)}\n\n`);
    } else if (event.type !== "done") {
      // Relay all other events unchanged
      process.stdout.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }

  return { exitCode: 0, stdoutLines: [], stderr: undefined };
}

// ── handlePrefixChain ─────────────────────────────────────────────────

/** prefix-chain: traverse the chain for --cred; with --type plug --paths print plug file paths, otherwise print formatted context lines. */

export function handlePrefixChain(args: string[]): HandlerResult {
  const credIdx = args.indexOf("--cred");
  if (credIdx === -1 || credIdx + 1 >= args.length) {
    return {
      exitCode: 1,
      stderr: "Error: --cred <id> is required for prefix-chain command",
    };
  }
  const credential = args[credIdx + 1];

  const typeIdx = args.indexOf("--type");
  const isPlug = typeIdx !== -1 && args[typeIdx + 1] === "plug";
  const pathsIdx = args.indexOf("--paths");
  const usePaths = pathsIdx !== -1;

  const nodesPath = resolveNodesPath();
  const nodes = agsh.prefix.chain(nodesPath, credential, usePaths ? "paths" : "content");

  if (isPlug && usePaths) {
    const paths = agsh.prefix.formatPaths(nodesPath, nodes);
    return { exitCode: 0, stdout: paths.join("\n"), stderr: undefined };
  } else {
    const lines = agsh.prefix.formatOutput(nodes);
    return { exitCode: 0, stdout: lines.join("\n"), stderr: undefined };
  }
}
// ── handleNodeCreate ──────────────────────────────────────────────────

/** node create: require --id/--parent and at least one of --context/--plug, delegate to agsh.node.create, print the new node id on success. */

export async function handleNodeCreate(args: string[]): Promise<HandlerResult> {
  const subCmd = args[1];
  if (subCmd !== "create") {
    return {
      exitCode: 1,
      stderr: `Error: unknown node subcommand: ${subCmd}\nUsage: agsh node create --parent <id> --id <node-id> [--context <text>] [--plug <text>]`,
    };
  }

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
    const result = await agsh.node.create({
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

/** credential validate: run the 5-layer check via agsh.credential.validate; failures go to stderr with exit code 1. */

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

  const result = agsh.credential.validate(id, resolveNodesPath());
  if (!result.valid) {
    return {
      exitCode: 1,
      stderr: result.error!,
    };
  }
  return { exitCode: 0 };
}

// ── handleContextBuild ────────────────────────────────────────────────

/** context build: assemble the full messages array for --cred (prefix chain + history) and print it as JSON. */

export async function handleContextBuild(args: string[]): Promise<HandlerResult> {
  const credIdx = args.indexOf("--cred");
  if (credIdx === -1 || credIdx + 1 >= args.length) {
    return {
      exitCode: 1,
      stderr: "Error: --cred <id> is required for context build",
    };
  }
  const credential = args[credIdx + 1];
  const messages = await agsh.context.build(credential, resolveNodesPath());
  return {
    exitCode: 0,
    stdout: JSON.stringify(messages),
  };
}

// ── handleContextDetectPending ────────────────────────────────────────

/** context detect-pending: find the latest assistant tool call lacking a tool response in history; print it as JSON when found. */

export function handleContextDetectPending(args: string[]): HandlerResult {
  const credIdx = args.indexOf("--cred");
  if (credIdx === -1 || credIdx + 1 >= args.length) {
    return {
      exitCode: 1,
      stderr: "Error: --cred <id> is required for context detect-pending",
    };
  }
  const credential = args[credIdx + 1];
  const tool = agsh.context.detectPending(credential, resolveNodesPath());
  return {
    exitCode: 0,
    stdout: tool ? JSON.stringify(tool) : undefined,
  };
}

// ── handleContextRecordTool ───────────────────────────────────────────

/** context record-tool: append a tool-result message (role "tool", content read from --content-file) to the credential's history JSONL, creating the node dir if needed. */

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
