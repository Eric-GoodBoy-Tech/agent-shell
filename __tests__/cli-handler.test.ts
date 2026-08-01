/**
 * cli-handler.test.ts — direct unit tests for all 9 CLI handlers.
 *
 * Tests call handler functions directly (no subprocess spawning).
 * Uses mock server for API-dependent handlers (handleCall, handleStream).
 * Uses tmp filesystem dirs for node operations.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
} from "../src/cli-handlers.ts";
import type { StreamHandlerResult } from "../src/cli-handlers.ts";
import { startMockServer } from "../test-utils/mock-server.ts";
import type { MockServerInstance } from "../test-utils/mock-server.ts";

// ── Env helpers ─────────────────────────────────────────────────────────

const originalEnv = { ...process.env };

function setEnv(vars: Record<string, string>) {
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value !== undefined) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

function setApiEnv(baseURL: string) {
  process.env.AGENT_API_KEY = "test-api-key";
  process.env.AGENT_BASE_URL = baseURL;
  process.env.AGENT_MODEL = "test-model";
}

// ── Stdout capture ──────────────────────────────────────────────────────

function captureStdout() {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = ((data: unknown, ..._args: unknown[]) => {
    lines.push(typeof data === "string" ? data : String(data));
    return true;
  }) as typeof process.stdout.write;
  return { lines, restore: () => { (process.stdout.write as unknown) = orig; } };
}

// ── fs helpers for node creation ────────────────────────────────────────

function createNodeOnDisk(
  nodesPath: string,
  id: string,
  parent: string,
  type: "context" | "plug",
  content: string,
  historyEntries?: object[],
) {
  const dir = join(nodesPath, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "parent"), parent, "utf-8");
  if (type === "context") {
    writeFileSync(join(dir, "context"), content, "utf-8");
  } else {
    writeFileSync(join(dir, "plug"), content, "utf-8");
  }
  if (historyEntries && historyEntries.length > 0) {
    writeFileSync(join(dir, "history"), historyEntries.map(e => JSON.stringify([e])).join("\n") + "\n", "utf-8");
  }
}

// ── Test dir paths ──────────────────────────────────────────────────────

const FIXED_TMP = "__tests__/tmp-cli-handler";

// ══════════════════════════════════════════════════════════════════════════
//  handleInit
// ══════════════════════════════════════════════════════════════════════════

describe("handleInit", () => {
  const initDir = FIXED_TMP + "-init";

  beforeEach(() => {
    if (existsSync(initDir)) rmSync(initDir, { recursive: true, force: true });
    restoreEnv();
  });

  afterEach(() => {
    if (existsSync(initDir)) rmSync(initDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("fresh init on tmp dir → exitCode 0, stdout contains 'Root node created'", async () => {
    const result = await handleInit(initDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Root node created");
    expect(existsSync(join(initDir, "root", "context"))).toBe(true);
    expect(existsSync(join(initDir, "root", "parent"))).toBe(true);
  });

  it("re-init on existing dir → exitCode 0, stdout contains 'already exists'", async () => {
    // First init
    await handleInit(initDir);
    // Re-init
    const result = await handleInit(initDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("already exists");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  handleCall
// ══════════════════════════════════════════════════════════════════════════

describe("handleCall", () => {
  let mockServer: MockServerInstance | null = null;

  beforeEach(() => {
    restoreEnv();
  });

  afterEach(() => {
    if (mockServer) {
      mockServer.stop();
      mockServer = null;
    }
    restoreEnv();
  });

  it("valid --messages JSON → exitCode 0, stdout is valid JSON with tool_calls", async () => {
    mockServer = await startMockServer({ responseType: "tool_calls" });
    setApiEnv(mockServer.baseURL);

    const result = await handleCall([
      "--messages",
      JSON.stringify([{ role: "user", content: "list files" }]),
    ]);

    expect(result.exitCode).toBe(0);
    const stdout = JSON.parse(result.stdout!);
    expect(stdout.role).toBe("assistant");
    expect(stdout.tool_calls).toBeDefined();
    expect(stdout.tool_calls.length).toBe(1);
    expect(stdout.tool_calls[0].function.name).toBe("shell");
  });

  it("missing --messages → exitCode 1, stderr contains '--messages'", async () => {
    const result = await handleCall([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--messages");
  });

  it("invalid JSON → exitCode 1, stderr contains 'valid JSON'", async () => {
    const result = await handleCall(["--messages", "not-valid-json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("valid JSON");
  });

  it("--messages-file with valid file → exitCode 0, valid JSON output", async () => {
    mockServer = await startMockServer({ responseType: "tool_calls" });
    setApiEnv(mockServer.baseURL);

    const tmpFile = join(FIXED_TMP, "messages.json");
    mkdirSync(FIXED_TMP, { recursive: true });
    writeFileSync(tmpFile, JSON.stringify([{ role: "user", content: "hi" }]));

    try {
      const result = await handleCall(["--messages-file", tmpFile]);
      expect(result.exitCode).toBe(0);
      const stdout = JSON.parse(result.stdout!);
      expect(stdout.role).toBe("assistant");
    } finally {
      rmSync(tmpFile, { force: true });
    }
  });

  it("--messages-file with missing file → exitCode 1, stderr contains 'failed to read'", async () => {
    const result = await handleCall(["--messages-file", "/nonexistent/path.json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("failed to read");
  });

  it("API error from mock server → exitCode 1", async () => {
    mockServer = await startMockServer({ responseType: "error", httpStatus: 500 });
    setApiEnv(mockServer.baseURL);

    const result = await handleCall([
      "--messages",
      JSON.stringify([{ role: "user", content: "test" }]),
    ]);
    expect(result.exitCode).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  handleStream
// ══════════════════════════════════════════════════════════════════════════

describe("handleStream", () => {
  let mockServer: MockServerInstance | null = null;

  beforeEach(() => {
    restoreEnv();
  });

  afterEach(() => {
    if (mockServer) {
      mockServer.stop();
      mockServer = null;
    }
    restoreEnv();
  });

  it("valid --messages with mock SSE server → exitCode 0, SSE data events emitted", async () => {
    mockServer = await startMockServer({ responseType: "sse", sseChunks: 3, sseDelay: 0 });
    setApiEnv(mockServer.baseURL);

    const { lines, restore } = captureStdout();
    let result: StreamHandlerResult = { exitCode: 1, stdoutLines: [] };
    try {
      result = await handleStream([
        "--messages",
        JSON.stringify([{ role: "user", content: "hi" }]),
      ]);
    } finally {
      restore();
    }

    expect(result.exitCode).toBe(0);
    // Should have emitted some data: events
    const dataLines = lines.filter((l) => l.startsWith("data:"));
    expect(dataLines.length).toBeGreaterThan(0);
  });

  it("missing all sources → exitCode 1, stderr contains 'required'", async () => {
    const result = await handleStream([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("required");
  });

  it("invalid JSON in --messages → exitCode 1", async () => {
    const result = await handleStream(["--messages", "bad-json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("valid JSON");
  });

  it("--messages-file with missing file → exitCode 1", async () => {
    const result = await handleStream(["--messages-file", "/nonexistent/file.json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("failed to read");
  });

  it("fatal SSE event when buildContext throws (cycle in node hierarchy)", async () => {
    const fatalDir = FIXED_TMP + "-stream-fatal";
    if (existsSync(fatalDir)) rmSync(fatalDir, { recursive: true, force: true });
    mkdirSync(fatalDir, { recursive: true });

    // Create cycle: nodeA.parent=nodeB, nodeB.parent=nodeA triggers prefixChain throw
    createNodeOnDisk(fatalDir, "nodeA", "nodeB", "context", "context A");
    createNodeOnDisk(fatalDir, "nodeB", "nodeA", "context", "context B");

    const { lines, restore } = captureStdout();
    let result: StreamHandlerResult = { exitCode: 0, stdoutLines: [] };
    try {
      result = await handleStream(["--cred", "nodeA", "--nodes-path", fatalDir]);
    } finally {
      restore();
      rmSync(fatalDir, { recursive: true, force: true });
    }

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeUndefined();
    // SSE fatal event emitted to stdout
    const sseLines = lines.filter((l) => l.startsWith("data:"));
    expect(sseLines.length).toBe(1);
    expect(sseLines[0]).toContain("fatal");
    expect(sseLines[0]).toContain("Cycle detected");
  });
});


// ══════════════════════════════════════════════════════════════════════════
//  handlePrefixChain
// ══════════════════════════════════════════════════════════════════════════

describe("handlePrefixChain", () => {
  const pcDir = FIXED_TMP + "-pc";

  beforeEach(() => {
    restoreEnv();
    if (existsSync(pcDir)) rmSync(pcDir, { recursive: true, force: true });
    mkdirSync(pcDir, { recursive: true });
    // Set AGENT_NODES_PATH for resolveNodesPath in non-arg paths
    process.env.AGENT_NODES_PATH = pcDir;
  });

  afterEach(() => {
    if (existsSync(pcDir)) rmSync(pcDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("valid --cred for existing node with parent → exitCode 0, stdout contains tab-separated format", () => {
    // root → child
    createNodeOnDisk(pcDir, "root", "", "context", "root content");
    createNodeOnDisk(pcDir, "child", "root", "context", "child content");

    const result = handlePrefixChain(["--cred", "child"]);
    expect(result.exitCode).toBe(0);
    // formatChainOutput returns "id\tcontent" lines
    expect(result.stdout).toContain("root\troot content");
  });

  it("--cred for nonexistent node → exitCode 0, stdout is empty", () => {
    const result = handlePrefixChain(["--cred", "nonexistent"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBeFalsy();
  });

  it("missing --cred → exitCode 1, stderr contains '--cred'", () => {
    const result = handlePrefixChain([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--cred");
  });

  it("--type plug --paths → exitCode 0, stdout contains plug file paths", () => {
    // root(context) → plug-a(plug) → child(context)
    createNodeOnDisk(pcDir, "plug-a", "root", "plug", "echo plug");
    createNodeOnDisk(pcDir, "child", "plug-a", "context", "child content");

    const result = handlePrefixChain(["--cred", "child", "--type", "plug", "--paths"]);
    expect(result.exitCode).toBe(0);
    // formatChainPaths returns join(nodesPath, id, "plug")
    expect(result.stdout).toContain("plug-a");
    expect(result.stdout).toContain("plug");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  handleNodeCreate
// ══════════════════════════════════════════════════════════════════════════

describe("handleNodeCreate", () => {
  const ncDir = FIXED_TMP + "-nc";

  beforeEach(() => {
    restoreEnv();
    if (existsSync(ncDir)) rmSync(ncDir, { recursive: true, force: true });
    mkdirSync(ncDir, { recursive: true });
    // Create root node for parent validation
    createNodeOnDisk(ncDir, "root", "", "context", "root content");
    process.env.AGENT_NODES_PATH = ncDir;
  });

  afterEach(() => {
    if (existsSync(ncDir)) rmSync(ncDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("valid args (--parent root --id test-node --context hello) → exitCode 0, stdout is node id", async () => {
    const result = await handleNodeCreate([
      "node", "create",
      "--parent", "root",
      "--id", "test-node",
      "--context", "hello",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("test-node");
    expect(existsSync(join(ncDir, "test-node", "context"))).toBe(true);
  });

  it("missing --id → exitCode 1, stderr contains '--id'", async () => {
    const result = await handleNodeCreate([
      "node", "create",
      "--parent", "root",
      "--context", "hello",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--id");
  });

  it("invalid ID format → exitCode 1, stderr contains 'Invalid id'", async () => {
    const result = await handleNodeCreate([
      "node", "create",
      "--parent", "root",
      "--id", "my node!",
      "--context", "hello",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid id");
  });

  it("missing --parent → exitCode 1", async () => {
    const result = await handleNodeCreate([
      "node", "create",
      "--id", "test-node",
      "--context", "hello",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--parent");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  handleCredentialValidate
// ══════════════════════════════════════════════════════════════════════════

describe("handleCredentialValidate", () => {
  const cvDir = FIXED_TMP + "-cv";

  beforeEach(() => {
    restoreEnv();
    if (existsSync(cvDir)) rmSync(cvDir, { recursive: true, force: true });
    mkdirSync(cvDir, { recursive: true });
    process.env.AGENT_NODES_PATH = cvDir;
  });

  afterEach(() => {
    if (existsSync(cvDir)) rmSync(cvDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("valid credential with existing node → exitCode 0", () => {
    createNodeOnDisk(cvDir, "good-node", "", "context", "test content");
    const result = handleCredentialValidate(["credential", "validate", "good-node"]);
    expect(result.exitCode).toBe(0);
  });

  it("nonexistent credential → exitCode 1, stderr contains 'credential not found'", () => {
    const result = handleCredentialValidate(["credential", "validate", "nonexistent"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("credential not found");
  });

  it("invalid credential id format → exitCode 1, stderr contains 'invalid credential id'", () => {
    const result = handleCredentialValidate(["credential", "validate", "my node!"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid credential id");
  });

  it("missing credential id → exitCode 1", () => {
    const result = handleCredentialValidate(["credential", "validate"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("credential id is required");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  handleContextBuild
// ══════════════════════════════════════════════════════════════════════════

describe("handleContextBuild", () => {
  const cbDir = FIXED_TMP + "-cb";

  beforeEach(() => {
    restoreEnv();
    if (existsSync(cbDir)) rmSync(cbDir, { recursive: true, force: true });
    mkdirSync(cbDir, { recursive: true });
    process.env.AGENT_NODES_PATH = cbDir;
  });

  afterEach(() => {
    if (existsSync(cbDir)) rmSync(cbDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("valid --cred with nodes → exitCode 0, stdout is JSON messages array", async () => {
    // root → agent (credential)
    createNodeOnDisk(cbDir, "root", "", "context", "root system content");
    createNodeOnDisk(cbDir, "my-agent", "root", "context", "agent content");

    const result = await handleContextBuild(["--cred", "my-agent"]);
    expect(result.exitCode).toBe(0);
    const messages = JSON.parse(result.stdout!);
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
    // Should have system message from root
    const sysMsgs = messages.filter((m: any) => m.role === "system");
    expect(sysMsgs.length).toBeGreaterThan(0);
    expect(sysMsgs[0].content).toContain("root system content");
  });

  it("missing --cred → exitCode 1, stderr contains '--cred'", async () => {
    const result = await handleContextBuild([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--cred");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  handleContextDetectPending
// ══════════════════════════════════════════════════════════════════════════

describe("handleContextDetectPending", () => {
  const cdpDir = FIXED_TMP + "-cdp";

  beforeEach(() => {
    restoreEnv();
    if (existsSync(cdpDir)) rmSync(cdpDir, { recursive: true, force: true });
    mkdirSync(cdpDir, { recursive: true });
    process.env.AGENT_NODES_PATH = cdpDir;
  });

  afterEach(() => {
    if (existsSync(cdpDir)) rmSync(cdpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("no pending tool → exitCode 0, stdout is empty/undefined", () => {
    createNodeOnDisk(cdpDir, "my-agent", "", "context", "agent content");
    const result = handleContextDetectPending(["--cred", "my-agent"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBeFalsy();
  });

  it("pending tool → exitCode 0, stdout is JSON tool call", () => {
    createNodeOnDisk(cdpDir, "my-agent", "", "context", "agent content", [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", function: { name: "shell", arguments: '{"cmd":"ls"}' } },
        ],
      },
    ]);
    const result = handleContextDetectPending(["--cred", "my-agent"]);
    expect(result.exitCode).toBe(0);
    const tool = JSON.parse(result.stdout!);
    expect(tool.id).toBe("call_1");
    expect(tool.function.name).toBe("shell");
  });

  it("missing --cred → exitCode 1, stderr contains '--cred'", () => {
    const result = handleContextDetectPending([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--cred");
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  handleContextRecordTool
// ══════════════════════════════════════════════════════════════════════════

describe("handleContextRecordTool", () => {
  const crtDir = FIXED_TMP + "-crt";

  beforeEach(() => {
    restoreEnv();
    if (existsSync(crtDir)) rmSync(crtDir, { recursive: true, force: true });
    mkdirSync(crtDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(crtDir)) rmSync(crtDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("valid args → exitCode 0, history file written", () => {
    const contentFile = join(crtDir, "tool-output.txt");
    writeFileSync(contentFile, "command output", "utf-8");

    const result = handleContextRecordTool([
      "--cred", "test-agent",
      "--nodes-path", crtDir,
      "--id", "call_123",
      "--content-file", contentFile,
    ]);

    expect(result.exitCode).toBe(0);
    // Verify history file was written
    const historyFile = join(crtDir, "test-agent", "history");
    expect(existsSync(historyFile)).toBe(true);
  });

  it("missing --content-file → exitCode 1", () => {
    const result = handleContextRecordTool([
      "--cred", "test-agent",
      "--nodes-path", crtDir,
      "--id", "call_123",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--content-file");
  });

  it("missing --cred → exitCode 1", () => {
    const result = handleContextRecordTool([
      "--nodes-path", crtDir,
      "--id", "call_123",
      "--content-file", "/tmp/x",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--cred");
  });
});
