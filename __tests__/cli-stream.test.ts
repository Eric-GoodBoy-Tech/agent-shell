import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir, removeTempDir } from "./setup.ts";

// Regression test for the stdout-flush / fallthrough bug that caused long
// streams to lose the final `done` event. Before the fix, the `stream` case in
// `src/cli.ts` fell through into the `prefix-chain` case, which either threw
// (without --cred) or wrote extra non-data lines and exited before stdout was
// flushed. With the fix, the final `done` event is flushed and the agent wrapper
// can unlock.

describe("stream CLI", () => {
  let server: ReturnType<typeof Bun.serve>;
  const PORT = 19999;
  // Isolated temp dir per test — never touches the real .agsh/nodes.
  let NODES_PATH = "";
  const CRED = "test-cred";

  beforeEach(() => {
    process.env.AGENT_API_KEY = "test-api-key";
    process.env.AGENT_BASE_URL = `http://127.0.0.1:${PORT}`;
    process.env.AGENT_MODEL = "test-model";

    // Isolated temp dir so tests never touch the real .agsh/nodes.
    NODES_PATH = createTempDir("agsh-stream-");

    // Create a minimal credential node so --cred works.
    const credDir = join(NODES_PATH, CRED);
    mkdirSync(credDir, { recursive: true });
    writeFileSync(join(credDir, "content"), "test agent");
    writeFileSync(join(credDir, "parent"), "root");
    writeFileSync(join(credDir, "type"), "context");
  });

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = undefined as any;
    }
    delete process.env.AGENT_API_KEY;
    delete process.env.AGENT_BASE_URL;
    delete process.env.AGENT_MODEL;

    // Clean up the isolated temp dir.
    removeTempDir(NODES_PATH);
  });

  it("flushes the final done event for long reasoning streams", async () => {
    // Build an OpenAI-compatible SSE response with a long reasoning chain.
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: { reasoning_content: "y".repeat(100) },
              finish_reason: null,
            },
          ],
        })}`,
      );
    }
    // Final finish chunk with usage.
    lines.push(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { total_tokens: 10000, completion_tokens: 5000 },
      })}`,
    );
    // SSE terminator.
    lines.push("data: [DONE]");
    const body = lines.join("\n") + "\n";

    server = Bun.serve({
      port: PORT,
      fetch: () =>
        new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    });

    const proc = Bun.spawn({
      cmd: [
        "bun",
        "src/cli.ts",
        "stream",
        "--cred",
        CRED,
        "--nodes-path",
        NODES_PATH,
      ],
      cwd: import.meta.dir + "/..",
      env: { ...process.env, AGENT_BASE_URL: `http://127.0.0.1:${PORT}` },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.log("STDERR:", stderr);
      console.log("STDOUT tail:", stdout.slice(-500));
    }

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    // Catch the `stream` → `prefix-chain` fallthrough: prefix-chain emits
    // lines like "id\tcontent" that are not SSE data lines.
    const nonDataLines = stdout
      .trim()
      .split("\n")
      .filter((line) => line && !line.startsWith("data: "));
    expect(nonDataLines).toEqual([]);

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("data: "));

    expect(events.length).toBeGreaterThan(0);
    const lastEvent = events[events.length - 1];
    expect(lastEvent).toContain('"type":"done"');
  });

  it("does not emit progress/token events by default (stats moved to plugin)", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: "step " }, finish_reason: null }],
        })}`
      );
    }
    lines.push(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { total_tokens: 100, completion_tokens: 10, reasoning_tokens: 90 },
      })}`
    );
    lines.push("data: [DONE]");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for (let i = 0; i < lines.length; i++) {
          controller.enqueue(encoder.encode(lines[i] + "\n"));
          if (i < lines.length - 1) await Bun.sleep(3);
        }
        controller.close();
      },
    });

    server = Bun.serve({
      port: PORT,
      fetch: () =>
        new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    });

    const proc = Bun.spawn({
      cmd: [
        "bun",
        "src/cli.ts",
        "stream",
        "--cred",
        CRED,
        "--nodes-path",
        NODES_PATH,
      ],
      cwd: import.meta.dir + "/..",
      env: { ...process.env, AGENT_BASE_URL: `http://127.0.0.1:${PORT}` },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.log("STDERR:", stderr);
      console.log("STDOUT tail:", stdout.slice(-500));
    }

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const events = stdout
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));

    // Core default emits no progress/token stats events
    const progressEvents = events.map((e) => JSON.parse(e)).filter((e) => e.type === "progress");
    expect(progressEvents.length).toBe(0);
    const tokenEvents = events.map((e) => JSON.parse(e)).filter((e) => e.type === "token");
    expect(tokenEvents.length).toBe(0);

    // Content deltas still flow (reasoning stream)
    const contentEvents = events.map((e) => JSON.parse(e)).filter((e) => e.type === "content");
    expect(contentEvents.length).toBeGreaterThan(0);

    // done carries the raw usage from the final chunk
    const lastEvent = JSON.parse(events[events.length - 1]);
    expect(lastEvent.type).toBe("done");
    expect(lastEvent.usage.reasoning_tokens).toBe(90);
  });

  it("writes valid JSONL history that can be roundtripped via readHistory", async () => {

    // Simple SSE response: content delta + final chunk with usage
    const lines = [
      `data: ${JSON.stringify({
        choices: [{
          delta: { content: "hello" },
          finish_reason: null,
        }],
      })}`,
    ];
    lines.push(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { total_tokens: 50, completion_tokens: 30 },
      })}`,
    );
    lines.push("data: [DONE]");
    server = Bun.serve({
      port: PORT,
      fetch: () =>
        new Response(lines.join("\n") + "\n", {
          headers: { "Content-Type": "text/event-stream" },
        }),
    });

    const proc = Bun.spawn({
      cmd: [
        "bun",
        "src/cli.ts",
        "stream",
        "--cred",
        CRED,
        "--nodes-path",
        NODES_PATH,
      ],
      cwd: import.meta.dir + "/..",
      env: { ...process.env, AGENT_BASE_URL: `http://127.0.0.1:${PORT}` },
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;

    // Read the history file written by handleStream (isolated temp dir).
    const historyFile = join(NODES_PATH, CRED, "history");
    expect(existsSync(historyFile)).toBe(true);
    expect(readFileSync(historyFile, "utf-8").length).toBeGreaterThan(0);
    const historyRaw = readFileSync(historyFile, "utf-8");
    const historyLines = historyRaw
      .trim()
      .split("\n")
      .filter((l) => l.trim());

    expect(historyLines.length).toBeGreaterThan(0);

    // Every line must be valid JSON (JSONL integrity)
    for (const line of historyLines) {
      const parsed = JSON.parse(line);
      expect(Array.isArray(parsed)).toBe(true);
      for (const msg of parsed) {
        expect(msg.role).toBeDefined();
      }
    }

    // Verify we can rebuild context from this history
    const { buildContext } = await import("../src/context.ts");
    const messages = await buildContext(CRED, NODES_PATH);
    expect(messages.length).toBeGreaterThan(0);
    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThan(0);
  });
});