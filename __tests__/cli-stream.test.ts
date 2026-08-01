import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Regression test for the stdout-flush / fallthrough bug that caused long
// streams to lose the final `done` event. Before the fix, the `stream` case in
// `src/cli.ts` fell through into the `prefix-chain` case, which either threw
// (without --cred) or wrote extra non-data lines and exited before stdout was
// flushed. With the fix, the final `done` event is flushed and the agent wrapper
// can unlock.

describe("stream CLI", () => {
  let server: ReturnType<typeof Bun.serve>;
  const PORT = 19999;
  const NODES_PATH = ".agsh/nodes";
  const CRED = "test-cred";

  beforeEach(() => {
    process.env.AGENT_API_KEY = "test-api-key";
    process.env.AGENT_BASE_URL = `http://127.0.0.1:${PORT}`;
    process.env.AGENT_MODEL = "test-model";

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

    // Clean up temporary credential node and its history.
    const credDir = join(NODES_PATH, CRED);
    try {
      rmSync(credDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
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

  it("emits progress events during reasoning-only streams", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: "step " }, finish_reason: null }],
        })}`,
      );
    }
    lines.push(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { total_tokens: 100, completion_tokens: 10, reasoning_tokens: 90 },
      })}`,
    );
    lines.push("data: [DONE]");

    // Stream with small delays between chunks so callApiStream observes
    // realistic timing — progress events need elapsed time for speed > 0.
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

    const progressEvents = events
      .map((e) => JSON.parse(e))
      .filter((e) => e.type === "progress");

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents[0]).toHaveProperty("reasoning");
    expect(progressEvents[progressEvents.length - 1].reasoning).toBeGreaterThan(0);
    expect(progressEvents[0]).toHaveProperty("tokens");
    expect(progressEvents[progressEvents.length - 1].tokens).toBeGreaterThan(0);
    expect(progressEvents[0]).toHaveProperty("speed");
    expect(progressEvents[progressEvents.length - 1].speed).toBeGreaterThan(0);

    const tokenEvents = events
      .map((e) => JSON.parse(e))
      .filter((e) => e.type === "token");
    expect(tokenEvents.length).toBeGreaterThan(0);
    expect(tokenEvents[tokenEvents.length - 1].tokens).toBe(100);
    expect(tokenEvents[tokenEvents.length - 1].speed).toBeGreaterThan(0);
    expect(progressEvents[0]).toHaveProperty("reasoning");
    expect(progressEvents[progressEvents.length - 1].reasoning).toBeGreaterThan(0);

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

    const exitCode = await proc.exited;

    const streamCwd = import.meta.dir + "/..";
    // Read the history file written by handleStream (spawn cwd = agent-shell/)
    const historyFile = join(streamCwd, NODES_PATH, CRED, "history");
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
    const messages = await buildContext(CRED, join(streamCwd, NODES_PATH));
    expect(messages.length).toBeGreaterThan(0);
    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThan(0);
});
});
