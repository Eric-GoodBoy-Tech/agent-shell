import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CLI subprocess integration tests.
 *
 * These tests spawn `bun src/cli.ts` as a real subprocess and check
 * exit codes, stdout, and stderr for argument parsing, help text,
 * version output, and error messages across all commands.
 *
 * No mocks — just Bun.spawn with piped stdio.
 */

const CWD = join(import.meta.dir, "..");
const NODES_PATH = ".agsh/nodes";

function spawn(args: string[], extraEnv: Record<string, string> = {}) {
  return Bun.spawn({
    cmd: ["bun", "src/cli.ts", ...args],
    cwd: CWD,
    env: {
      ...process.env,
      AGENT_API_KEY: "test-key",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function run(args: string[], extraEnv: Record<string, string> = {}) {
  const proc = spawn(args, extraEnv);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("CLI subprocess", () => {
  beforeEach(() => {
    // Ensure root node exists for init/prefix-chain tests.
    const rootDir = join(CWD, NODES_PATH, "root");
    mkdirSync(rootDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up the nodes dir to avoid pollution across tests.
    try {
      rmSync(join(CWD, NODES_PATH), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ── help ───────────────────────────────────────────────────────────────
  it("--help exits 0 and shows Commands", async () => {
    const { stdout, exitCode } = await run(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
  });

  it("no args exits 1 and shows help text", async () => {
    const { stdout, exitCode } = await run([]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Commands:");
  });

  // ── version ────────────────────────────────────────────────────────────
  it("--version exits 0 and prints version", async () => {
    const { stdout, exitCode } = await run(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("0.1.0\n");
  });

  // ── init ───────────────────────────────────────────────────────────────
  it("init exits 0 and shows root node message", async () => {
    const { stdout, exitCode } = await run(["init"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Root node");
  });

  // ── call ───────────────────────────────────────────────────────────────
  it("call without --messages exits 1", async () => {
    const { stderr, exitCode } = await run(["call"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--messages");
  });

  it("call --messages with bad JSON exits 1", async () => {
    const { stderr, exitCode } = await run(["call", "--messages", "bad-json"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("valid JSON");
  });

  // ── node create ────────────────────────────────────────────────────────
  it("node create missing all required args exits 1", async () => {
    const { stderr, exitCode } = await run(["node", "create"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--id");
  });

  it("node with bad subcommand exits 1", async () => {
    const { stderr, exitCode } = await run(["node", "nonexistent"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown node subcommand");
  });

  // ── prefix-chain ───────────────────────────────────────────────────────
  it("prefix-chain missing --cred exits 1", async () => {
    const { stderr, exitCode } = await run(["prefix-chain"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--cred");
  });

  // ── credential validate ────────────────────────────────────────────────
  it("credential validate missing id exits 1", async () => {
    const { stderr, exitCode } = await run(["credential", "validate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("required");
  });

  it("credential with bad subcommand exits 1", async () => {
    const { stderr, exitCode } = await run(["credential", "nonexistent"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown credential subcommand");
  });

  // ── context build ──────────────────────────────────────────────────────
  it("context build missing --cred exits 1", async () => {
    const { stderr, exitCode } = await run(["context", "build"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--cred");
  });

  it("context with bad subcommand exits 1", async () => {
    const { stderr, exitCode } = await run(["context", "nonexistent"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown context subcommand");
  });

  // ── unknown command ────────────────────────────────────────────────────
  it("unknown command exits 1", async () => {
    const { stderr, exitCode } = await run(["nonexistent-command"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown command");
  });
});
