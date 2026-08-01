#!/usr/bin/env bun
/**
 * agsh — Agent Shell CLI
 * Main entry point for the agsh command-line tool.
 */

import {
  handleInit,
  handleCall,
  handleStream,
  handlePrefixChain,
  handleNodeCreate,
  handleCredentialValidate,
  handleContextBuild,
  handleContextDetectPending,
  handleContextRecordTool,
} from "./cli-handlers.ts";

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
const VERSION = "0.1.0";

function printHelp(): void {
  console.log(`agsh — Agent Shell CLI v${VERSION}

Usage: agsh <command> [options]

Commands:
  init                          Initialize the nodes directory with root node
  call --messages <json>        Make an LLM API call with the shell tool
  stream --messages <json>      Stream LLM API response via SSE events
  prefix-chain --cred <id>      Traverse the prefix chain (context nodes)
  prefix-chain --cred <id> --type plug --paths
                                Traverse the prefix chain (plug paths)
  node create --parent <id> --id <node-id> [--context <text>] [--plug <text>]
                                Create a new node. At least one of --context or --plug.
  context build --cred <id>     Build full AGENT_CONTEXT messages array
  context detect-pending --cred <id>
                                Detect next unexecuted tool call in history
  credential validate <id>         Validate a credential ID (4-layer check)
  context record-tool --cred <id> --nodes-path <path> --id <id> --content-file <path>
                                   Write a tool result message to history JSONL
  --help                        Show this help message
  --version                     Show version number`);
}

function printVersion(): void {
  console.log(VERSION);
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2); // Skip bun and script path

  if (args.length === 0 || args[0] === "--help") {
    printHelp();
    process.exit(args.length === 0 ? 1 : 0);
  }

  if (args[0] === "--version") {
    printVersion();
    process.exit(0);
  }

  const command = args[0];

  try {
    switch (command) {
      case "init": {
        const result = await handleInit(resolveNodesPath());
        if (result.stdout !== undefined) console.log(result.stdout);
        if (result.stderr) console.error(result.stderr);
        process.exit(result.exitCode);
      }

      case "call": {
        const result = await handleCall(args);
        if (result.stdout !== undefined) console.log(result.stdout);
        if (result.stderr) console.error(result.stderr);
        process.exit(result.exitCode);
      }

      case "stream": {
        const result = await handleStream(args);
        if (result.stderr) console.error(result.stderr);
        process.exit(result.exitCode);
      }

      case "prefix-chain": {
        const result = handlePrefixChain(args);
        if (result.stdout !== undefined) console.log(result.stdout);
        if (result.stderr) console.error(result.stderr);
        process.exit(result.exitCode);
      }

      case "node": {
        const result = await handleNodeCreate(args);
        if (result.stdout !== undefined) console.log(result.stdout);
        if (result.stderr) console.error(result.stderr);
        process.exit(result.exitCode);
      }

      case "credential": {
        const result = handleCredentialValidate(args);
        if (result.stdout !== undefined) console.log(result.stdout);
        if (result.stderr) console.error(result.stderr);
        process.exit(result.exitCode);
      }

      case "context": {
        const ctxSubCmd = args[1];

        if (ctxSubCmd === "build") {
          const result = await handleContextBuild(args);
          if (result.stdout !== undefined) console.log(result.stdout);
          if (result.stderr) console.error(result.stderr);
          process.exit(result.exitCode);
        }

        if (ctxSubCmd === "detect-pending") {
          const result = handleContextDetectPending(args);
          if (result.stdout !== undefined) console.log(result.stdout);
          if (result.stderr) console.error(result.stderr);
          process.exit(result.exitCode);
        }

        if (ctxSubCmd === "record-tool") {
          const result = handleContextRecordTool(args);
          if (result.stdout !== undefined) console.log(result.stdout);
          if (result.stderr) console.error(result.stderr);
          process.exit(result.exitCode);
        }

        console.error(`Error: unknown context subcommand: ${ctxSubCmd}`);
        console.error("Usage: agsh context {build|detect-pending|record-tool}");
        process.exit(1);
      }

      default:
        console.error(`Error: unknown command '${command}'`);
        console.error("Run 'agsh --help' for usage information.");
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
