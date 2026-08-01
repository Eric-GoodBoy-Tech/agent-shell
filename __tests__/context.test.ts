import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildContext,
  detectPendingTool,
  saveDelta,
  appendToContext,
  appendToolResult,
  finalizeContext,
} from "../src/context.ts";
import type { Message } from "../src/types.ts";

const TEST_DIR = "__tests__/tmp-test-context";

describe("context", () => {
  beforeEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
    await mkdir(TEST_DIR, { recursive: true });
    // saveDelta writes dump files here
    await mkdir(".agsh/tmp", { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
    if (existsSync(".agsh")) {
      await rm(".agsh", { recursive: true, force: true });
    }
  });

  // ── helpers ──────────────────────────────────────────────

  async function createNode(
    id: string,
    parent: string,
    type: string,
    content: string,
  ) {
    const dir = join(TEST_DIR, id);
    await mkdir(dir, { recursive: true });
    if (type === "context") {
      await writeFile(join(dir, "context"), content, "utf-8");
    } else {
      await writeFile(join(dir, "plug"), content, "utf-8");
    }
    await writeFile(join(dir, "parent"), parent, "utf-8");
  }

  async function writeHistory(
    credential: string,
    messages: Message[],
  ) {
    const credDir = join(TEST_DIR, credential);
    await mkdir(credDir, { recursive: true });
    const historyFile = join(credDir, "history");
    await writeFile(historyFile, JSON.stringify(messages) + "\n", "utf-8");
  }

  /** Write raw JSONL content directly to a credential's history file */
  async function writeHistoryRaw(credential: string, raw: string) {
    const credDir = join(TEST_DIR, credential);
    await mkdir(credDir, { recursive: true });
    await writeFile(join(credDir, "history"), raw, "utf-8");
  }

  // ══════════════════════════════════════════════════════════
  //  readHistory  (tested indirectly via buildContext & detectPendingTool)
  // ══════════════════════════════════════════════════════════

  describe("readHistory (via buildContext)", () => {
    it("history file does not exist → returns [] (credential content used)", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");

      const messages = await buildContext("agent", TEST_DIR);

      // No history → falls back to credential content as user message
      const userMsgs = messages.filter((m) => m.role === "user");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toContain("agent content");
    });

    it("empty history file → returns []", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");
      await writeHistoryRaw("agent", "");

      const messages = await buildContext("agent", TEST_DIR);

      const userMsgs = messages.filter((m) => m.role === "user");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toContain("agent content");
    });

    it("whitespace-only history file → returns []", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");
      await writeHistoryRaw("agent", "   \n  \t  \n");

      const messages = await buildContext("agent", TEST_DIR);

      const userMsgs = messages.filter((m) => m.role === "user");
      expect(userMsgs).toHaveLength(1);
    });

    it("single valid JSON array line → returns array contents in context", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");
      const histMsgs: Message[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ];
      await writeHistory("agent", histMsgs);

      const messages = await buildContext("agent", TEST_DIR);

      // History takes priority → credential user message NOT added; history's own user message IS present
      expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
      const assistants = messages.filter((m) => m.role === "assistant");
      expect(assistants).toHaveLength(1);
      expect(assistants[0].content).toBe("hi there");
    });

    it("multiple valid JSONL lines → returns flat concatenation of all messages", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");
      const line1: Message[] = [
        { role: "user", content: "first" },
      ];
      const line2: Message[] = [
        { role: "assistant", content: "second" },
        { role: "tool", content: "third", tool_call_id: "t1" },
      ];
      const credDir = join(TEST_DIR, "agent");
      await mkdir(credDir, { recursive: true });
      await writeFile(
        join(credDir, "history"),
        JSON.stringify(line1) + "\n" + JSON.stringify(line2) + "\n",
        "utf-8",
      );

      const messages = await buildContext("agent", TEST_DIR);

      expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
      expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
      expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
    });

    it("malformed JSON line mixed with valid lines → skips malformed, returns valid content", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");
      await writeHistoryRaw(
        "agent",
        '[{"role":"user","content":"good"}]\nthis is not json\n[{"role":"assistant","content":"also good"}]\n',
      );

      const messages = await buildContext("agent", TEST_DIR);

      // Only the valid JSONL lines are parsed
      expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
      expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    });

    it("file with only malformed JSON → returns []", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");
      await writeHistoryRaw("agent", "garbage\n{not:json}\nstill bad\n");

      const messages = await buildContext("agent", TEST_DIR);

      // Falls back to credential content
      const userMsgs = messages.filter((m) => m.role === "user");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toContain("agent content");
    });

    it("line is valid JSON but not an array → skipped", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");
      await writeHistoryRaw(
        "agent",
        '{"role":"user","content":"not-an-array"}\n',
      );

      const messages = await buildContext("agent", TEST_DIR);

      // Not wrapped in array → skipped by readHistory
      const userMsgs = messages.filter((m) => m.role === "user");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toContain("agent content");
    });
  });

    it("concatenated JSONL without newline separator (regression for \\n bug) → gracefully degrades", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");

      // Simulate the \\n bug: two JSON arrays concatenated on one line
      const line1 = JSON.stringify([{ role: "user", content: "hello" }]);
      const line2 = JSON.stringify([{ role: "assistant", content: "hi" }]);
      // The bug wrote literal "\\n" text instead of actual newline, resulting in:
      // [line1]\\n[line2]  on the same line — JSON.parse fails
      const corrupted = line1 + "\\n" + line2;
      await writeHistoryRaw("agent", corrupted);

      const messages = await buildContext("agent", TEST_DIR);

      // Graceful degradation: the corrupted line is skipped, system falls back
      const userMsgs = messages.filter((m) => m.role === "user");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toContain("agent content");
    });

  // ══════════════════════════════════════════════════════════
  //  dedupToolResults  (tested indirectly via buildContext)
  // ══════════════════════════════════════════════════════════

  describe("dedupToolResults (via buildContext)", () => {
    it("all unique tool_call_ids → all tool messages pass through", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");
      await writeHistory("agent", [
        { role: "tool", content: "r1", tool_call_id: "c1" },
        { role: "tool", content: "r2", tool_call_id: "c2" },
        { role: "tool", content: "r3", tool_call_id: "c3" },
      ]);

      const messages = await buildContext("agent", TEST_DIR);
      const tools = messages.filter((m) => m.role === "tool");
      expect(tools).toHaveLength(3);
    });

    it("all duplicate tool_call_ids → only first occurrence kept", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");
      await writeHistory("agent", [
        { role: "tool", content: "first", tool_call_id: "dup" },
        { role: "tool", content: "second", tool_call_id: "dup" },
        { role: "tool", content: "third", tool_call_id: "dup" },
      ]);

      const messages = await buildContext("agent", TEST_DIR);
      const tools = messages.filter((m) => m.role === "tool");
      expect(tools).toHaveLength(1);
      expect(tools[0].content).toBe("first");
    });

    it("non-tool messages pass through unchanged", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");
      await writeHistory("agent", [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "tool", content: "r1", tool_call_id: "c1" },
        { role: "tool", content: "r2", tool_call_id: "c1" }, // duplicate
        { role: "user", content: "world" },
      ]);

      const messages = await buildContext("agent", TEST_DIR);
      expect(messages.filter((m) => m.role === "user")).toHaveLength(2);
      expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
      expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
    });

    it("messages with undefined tool_call_id → pass through as unique", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");
      await writeHistory("agent", [
        { role: "tool", content: "no-id-1" },
        { role: "tool", content: "no-id-2" },
        { role: "tool", content: "no-id-3" },
      ]);

      const messages = await buildContext("agent", TEST_DIR);
      const tools = messages.filter((m) => m.role === "tool");
      // All pass through because undefind tool_call_id never matches seen set
      expect(tools).toHaveLength(3);
    });

    it("mixed duplicate and unique tool_call_ids → only duplicates removed", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");
      await writeHistory("agent", [
        { role: "tool", content: "a1", tool_call_id: "a" },
        { role: "tool", content: "b1", tool_call_id: "b" },
        { role: "tool", content: "a2", tool_call_id: "a" }, // dup of a
        { role: "tool", content: "c1", tool_call_id: "c" },
        { role: "tool", content: "b2", tool_call_id: "b" }, // dup of b
      ]);

      const messages = await buildContext("agent", TEST_DIR);
      const tools = messages.filter((m) => m.role === "tool");
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.content)).toEqual(["a1", "b1", "c1"]);
    });
  });

  // ══════════════════════════════════════════════════════════
  //  detectPendingTool
  // ══════════════════════════════════════════════════════════

  describe("detectPendingTool", () => {
    it("no history file → returns null", () => {
      const result = detectPendingTool("agent", TEST_DIR);
      expect(result).toBeNull();
    });

    it("empty history file → returns null", async () => {
      await writeHistoryRaw("agent", "");
      const result = detectPendingTool("agent", TEST_DIR);
      expect(result).toBeNull();
    });

    it("history with no assistant messages → returns null", async () => {
      await writeHistory("agent", [
        { role: "user", content: "hello" },
      ]);
      const result = detectPendingTool("agent", TEST_DIR);
      expect(result).toBeNull();
    });

    it("single assistant message with 1 tool_call and no tool result → returns that call", async () => {
      const call: Message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            function: { name: "run_cmd", arguments: '{"cmd":"ls"}' },
          },
        ],
      };
      await writeHistory("agent", [call]);

      const result = detectPendingTool("agent", TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("call_1");
      expect(result!.function.name).toBe("run_cmd");
    });

    it("single assistant message with 2 tool_calls, first has result → returns second call", async () => {
      const calls: Message[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              function: { name: "fn1", arguments: "{}" },
            },
            {
              id: "call_2",
              function: { name: "fn2", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "result1", tool_call_id: "call_1" },
      ];
      await writeHistory("agent", calls);

      const result = detectPendingTool("agent", TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("call_2");
    });

    it("assistant message with all tool_calls having results → returns null", async () => {
      const calls: Message[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              function: { name: "fn1", arguments: "{}" },
            },
            {
              id: "call_2",
              function: { name: "fn2", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "r1", tool_call_id: "call_1" },
        { role: "tool", content: "r2", tool_call_id: "call_2" },
      ];
      await writeHistory("agent", calls);

      const result = detectPendingTool("agent", TEST_DIR);
      expect(result).toBeNull();
    });

    it("multiple assistant messages → checks only last one with tool_calls", async () => {
      // First assistant with pending calls that SHOULD be ignored
      const line1: Message[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "old_call", function: { name: "old", arguments: "{}" } },
          ],
        },
      ];
      // Second assistant with its own pending call
      const line2: Message[] = [
        { role: "user", content: "next" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "new_call", function: { name: "new", arguments: "{}" } },
          ],
        },
      ];
      const credDir = join(TEST_DIR, "agent");
      await mkdir(credDir, { recursive: true });
      await writeFile(
        join(credDir, "history"),
        JSON.stringify(line1) + "\n" + JSON.stringify(line2) + "\n",
        "utf-8",
      );

      const result = detectPendingTool("agent", TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("new_call");
    });

    it("assistant message with empty tool_calls array → returns null", async () => {
      await writeHistory("agent", [
        {
          role: "assistant",
          content: "done",
          tool_calls: [],
        },
      ]);

      const result = detectPendingTool("agent", TEST_DIR);
      expect(result).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════
  //  saveDelta
  // ══════════════════════════════════════════════════════════

  describe("saveDelta", () => {
    it("context file does not exist → returns {saved: 0, total: 0}", async () => {
      const credDir = join(TEST_DIR, "agent");
      await mkdir(credDir, { recursive: true });
      const ctxPath = join(TEST_DIR, "nonexistent.json");

      const result = saveDelta("agent", TEST_DIR, ctxPath, 0);
      expect(result).toEqual({ saved: 0, total: 0 });
    });

    it("fromIndex < 0 → returns {saved: 0, total: context.length}", async () => {
      const credDir = join(TEST_DIR, "agent");
      await mkdir(credDir, { recursive: true });
      const ctxPath = join(TEST_DIR, "ctx.json");
      const msgs: Message[] = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ];
      await writeFile(ctxPath, JSON.stringify(msgs), "utf-8");

      const result = saveDelta("agent", TEST_DIR, ctxPath, -1);
      expect(result).toEqual({ saved: 0, total: 2 });
    });

    it("fromIndex >= context.length → returns {saved: 0, total: context.length}", async () => {
      const credDir = join(TEST_DIR, "agent");
      await mkdir(credDir, { recursive: true });
      const ctxPath = join(TEST_DIR, "ctx.json");
      const msgs: Message[] = [
        { role: "user", content: "hi" },
      ];
      await writeFile(ctxPath, JSON.stringify(msgs), "utf-8");

      const result = saveDelta("agent", TEST_DIR, ctxPath, 10);
      expect(result).toEqual({ saved: 0, total: 1 });
    });

    it("fromIndex in middle of array → saves delta, returns correct saved count", async () => {
      const credDir = join(TEST_DIR, "agent");
      await mkdir(credDir, { recursive: true });
      const ctxPath = join(TEST_DIR, "ctx.json");
      const msgs: Message[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
      ];
      await writeFile(ctxPath, JSON.stringify(msgs), "utf-8");

      const result = saveDelta("agent", TEST_DIR, ctxPath, 2);
      expect(result.saved).toBe(3);
      expect(result.total).toBe(5);
    });

    it("fromIndex === context.length - 1 → saves last single element", async () => {
      const credDir = join(TEST_DIR, "agent");
      await mkdir(credDir, { recursive: true });
      const ctxPath = join(TEST_DIR, "ctx.json");
      const msgs: Message[] = [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ];
      await writeFile(ctxPath, JSON.stringify(msgs), "utf-8");

      const result = saveDelta("agent", TEST_DIR, ctxPath, 1);
      expect(result.saved).toBe(1);
      expect(result.total).toBe(2);
    });

    it("verifies history file is written with correct JSONL delta", async () => {
      const credDir = join(TEST_DIR, "agent");
      await mkdir(credDir, { recursive: true });
      const ctxPath = join(TEST_DIR, "ctx.json");
      const msgs: Message[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
      ];
      await writeFile(ctxPath, JSON.stringify(msgs), "utf-8");

      saveDelta("agent", TEST_DIR, ctxPath, 0);

      const historyPath = join(TEST_DIR, "agent", "history");
      expect(existsSync(historyPath)).toBe(true);
      const raw = await readFile(historyPath, "utf-8");
      const parsed = JSON.parse(raw.trim());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
      expect(parsed[0].role).toBe("system");
      expect(parsed[1].role).toBe("user");
    });

    it("fromIndex === 0 → saves entire context array", async () => {
      const credDir = join(TEST_DIR, "agent");
      await mkdir(credDir, { recursive: true });
      const ctxPath = join(TEST_DIR, "ctx.json");
      const msgs: Message[] = [
        { role: "user", content: "hello" },
      ];
      await writeFile(ctxPath, JSON.stringify(msgs), "utf-8");

      const result = saveDelta("agent", TEST_DIR, ctxPath, 0);
      expect(result.saved).toBe(1);
      expect(result.total).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════
  //  appendToContext
  // ══════════════════════════════════════════════════════════

  describe("appendToContext", () => {
    it("plain string message → wraps as {role, content: message}", () => {
      const ctx: Message[] = [];
      const result = appendToContext(ctx, "user", "hello world");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ role: "user", content: "hello world" });
    });

    it("JSON string with .role field → uses parsed object directly", () => {
      const ctx: Message[] = [];
      const json = JSON.stringify({
        role: "tool",
        content: "result",
        tool_call_id: "c1",
      });
      const result = appendToContext(ctx, "ignore", json);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: "tool",
        content: "result",
        tool_call_id: "c1",
      });
    });

    it("JSON string without .role field → wraps as {role, content: message}", () => {
      const ctx: Message[] = [];
      const json = JSON.stringify({ foo: "bar" });
      const result = appendToContext(ctx, "assistant", json);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ role: "assistant", content: json });
    });

    it("malformed JSON string → wraps as {role, content: message}", () => {
      const ctx: Message[] = [];
      const result = appendToContext(ctx, "user", "not { valid json [[[");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ role: "user", content: "not { valid json [[[" });
    });

    it("returns new array, does not mutate input", () => {
      const ctx: Message[] = [{ role: "system", content: "sys" }];
      const result = appendToContext(ctx, "user", "hello");
      expect(ctx).toHaveLength(1);
      expect(result).toHaveLength(2);
      expect(result).not.toBe(ctx);
    });
  });

  // ══════════════════════════════════════════════════════════
  //  appendToolResult
  // ══════════════════════════════════════════════════════════

  describe("appendToolResult", () => {
    it("valid toolCallId and content → returns message with correct fields", () => {
      const ctx: Message[] = [];
      const result = appendToolResult(ctx, "tc_123", "command output");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: "tool",
        tool_call_id: "tc_123",
        content: "command output",
      });
    });

    it("empty content string → works fine", () => {
      const ctx: Message[] = [];
      const result = appendToolResult(ctx, "tc_empty", "");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: "tool",
        tool_call_id: "tc_empty",
        content: "",
      });
    });

    it("does not mutate input context array", () => {
      const ctx: Message[] = [
        { role: "user", content: "hi" },
      ];
      const result = appendToolResult(ctx, "tc", "out");
      expect(ctx).toHaveLength(1);
      expect(result).toHaveLength(2);
      expect(result).not.toBe(ctx);
    });
  });

  // ══════════════════════════════════════════════════════════
  //  finalizeContext
  // ══════════════════════════════════════════════════════════

  describe("finalizeContext", () => {
    it("no reasoningFile → reasoning_content is null in message", () => {
      const ctx: Message[] = [];
      const result = finalizeContext(ctx, "", "assistant reply");
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        role: "assistant",
        content: "assistant reply",
        reasoning_content: null,
      });
    });

    it("reasoning file exists with content → reads content, sets reasoning_content", async () => {
      const reasoningFile = join(TEST_DIR, "reasoning.txt");
      await writeFile(reasoningFile, "step-by-step reasoning", "utf-8");

      const ctx: Message[] = [];
      const result = finalizeContext(ctx, reasoningFile, "final answer");

      expect(result).toHaveLength(1);
      expect(result[0].reasoning_content).toBe("step-by-step reasoning");
      // File should be cleaned up by unlinkSync
      expect(existsSync(reasoningFile)).toBe(false);
    });

    it("reasoning file read fails (nonexistent file) → reasoning_content stays null", () => {
      const ctx: Message[] = [];
      const result = finalizeContext(
        ctx,
        join(TEST_DIR, "does-not-exist.txt"),
        "answer",
      );

      expect(result[0].reasoning_content).toBeNull();
    });

    it("toolCallsJson is undefined → no tool_calls in message", () => {
      const ctx: Message[] = [];
      const result = finalizeContext(ctx, "", "reply");
      expect(result[0].tool_calls).toBeUndefined();
    });

    it("toolCallsJson is valid JSON array → tool_calls set in message", () => {
      const ctx: Message[] = [];
      const calls = [
        {
          id: "call_1",
          function: { name: "run", arguments: '{"cmd":"ls"}' },
        },
      ];
      const result = finalizeContext(
        ctx,
        "",
        null,
        JSON.stringify(calls),
      );

      expect(result[0].tool_calls).toEqual(calls);
    });

    it("toolCallsJson is an empty array → no tool_calls in message", () => {
      const ctx: Message[] = [];
      const result = finalizeContext(ctx, "", "reply", "[]");
      expect(result[0].tool_calls).toBeUndefined();
    });

    it("toolCallsJson is malformed JSON → ignored, no tool_calls", () => {
      const ctx: Message[] = [];
      const result = finalizeContext(ctx, "", "reply", "not json {{{");
      expect(result[0].tool_calls).toBeUndefined();
    });

    it("returns new array with assistant message appended, original unchanged", () => {
      const ctx: Message[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
      ];
      const result = finalizeContext(ctx, "", "answer");
      expect(ctx).toHaveLength(2);
      expect(result).toHaveLength(3);
      expect(result).not.toBe(ctx);
    });

    it("null content → content is null in assistant message", () => {
      const ctx: Message[] = [];
      const result = finalizeContext(ctx, "", null!);
      expect(result[0].content).toBeNull();
    });

    it("toolCallsJson is valid JSON but not an array → no tool_calls", () => {
      const ctx: Message[] = [];
      const result = finalizeContext(
        ctx,
        "",
        "reply",
        '{"id":"x"}',
      );
      expect(result[0].tool_calls).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════
  //  buildContext  (exported)
  // ══════════════════════════════════════════════════════════

  describe("buildContext", () => {
    it("tags the initial user message with the credential node identifier", async () => {
      await createNode("root", "", "context", "root system content");
      await createNode("my-agent", "root", "context", "my agent user content");

      const messages = await buildContext("my-agent", TEST_DIR);

      const userMessages = messages.filter((m) => m.role === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0].content).toBe(
        "[node-my-agent]\nmy agent user content",
      );
    });

    it("tags empty credential content with Continue.", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("my-agent", "root", "context", "");

      const messages = await buildContext("my-agent", TEST_DIR);

      const userMessages = messages.filter((m) => m.role === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0].content).toBe("[node-my-agent]\nContinue.");
    });

    it("missing credential directory → returns user message with Continue.", async () => {
      const messages = await buildContext("nonexistent", TEST_DIR);

      expect(messages.filter((m) => m.role === "system")).toHaveLength(0);
      const userMsgs = messages.filter((m) => m.role === "user");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toBe("[node-nonexistent]\nContinue.");
    });

    it("history with valid content → history takes priority over credential content", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "credential content");
      await writeHistory("agent", [
        { role: "user", content: "from history" },
      ]);

      const messages = await buildContext("agent", TEST_DIR);

      // System messages from prefix chain are present
      expect(messages.filter((m) => m.role === "system").length).toBeGreaterThan(0);
      // History messages are present (not credential content)
      const userMsgs = messages.filter((m) => m.role === "user");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toBe("from history");
    });

    it("credential content file does not exist → user message uses 'Continue.'", async () => {
      await createNode("root", "", "context", "root content");
      // Create credential dir without context file
      const credDir = join(TEST_DIR, "agent");
      await mkdir(credDir, { recursive: true });
      await writeFile(join(credDir, "parent"), "root", "utf-8");

      const messages = await buildContext("agent", TEST_DIR);

      const userMsgs = messages.filter((m) => m.role === "user");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toBe("[node-agent]\nContinue.");
    });

    it("prefix chain returns multiple nodes → all added as system messages in parent→child order", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("mid", "root", "context", "middle content");
      await createNode("leaf", "mid", "context", "leaf content");

      const messages = await buildContext("leaf", TEST_DIR);

      const sysMsgs = messages.filter((m) => m.role === "system");
      expect(sysMsgs).toHaveLength(2); // root + mid (not leaf)
      expect(sysMsgs[0].content).toBe("[node-root]\nroot content");
      expect(sysMsgs[1].content).toBe("[node-mid]\nmiddle content");
    });

    it("dedup removes duplicates → only unique tool results in final context", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "cred content");
      await writeHistory("agent", [
        { role: "tool", content: "r1", tool_call_id: "dup" },
        { role: "tool", content: "r2", tool_call_id: "dup" },
        { role: "tool", content: "r3", tool_call_id: "unique" },
      ]);

      const messages = await buildContext("agent", TEST_DIR);
      const tools = messages.filter((m) => m.role === "tool");
      expect(tools).toHaveLength(2);
      expect(tools[0].content).toBe("r1");
      expect(tools[1].content).toBe("r3");
    });

    it("credential directory exists but has no parent chain (standalone root) → only credential user message + no system messages", async () => {
      await createNode("standalone", "", "context", "standalone content");

      const messages = await buildContext("standalone", TEST_DIR);

      // prefixChain finds no ancestors (parent is empty string → null)
      expect(messages.filter((m) => m.role === "system")).toHaveLength(0);
      const userMsgs = messages.filter((m) => m.role === "user");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toContain("standalone content");
    });

    it("plug-type ancestor nodes are NOT added as system messages (only context type)", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("plug-mid", "root", "plug", "plug content");
      await createNode("agent", "plug-mid", "context", "agent content");

      const messages = await buildContext("agent", TEST_DIR);

      const sysMsgs = messages.filter((m) => m.role === "system");
      // Only root should be included (it has context file)
      // plug-mid has plug file, so prefixChain("content" mode) skips it
      expect(sysMsgs).toHaveLength(1);
      expect(sysMsgs[0].content).toBe("[node-root]\nroot content");
    });

    it("injects recover into messages and history when last message is text-only assistant", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");
      await writeHistory("agent", [
        { role: "assistant", content: "Done! Task complete." },
      ]);

      const messages = await buildContext("agent", TEST_DIR);

      // Recover should be the last message in the API context
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.role).toBe("system");
      expect(lastMsg.content).toContain("<recover>");
      expect(lastMsg.content).toContain("violated the protocol");

      // Recover should also be written to history
      const histContent = readFileSync(join(TEST_DIR, "agent", "history"), "utf-8");
      expect(histContent).toContain("<recover>");
    });

    it("does not inject recover when last message has tool_calls", async () => {
      await createNode("root", "", "context", "root content");
      await createNode("agent", "root", "context", "agent content");
      await writeHistory("agent", [
        { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "shell", arguments: '{"cmd":"ls"}' } }] },
      ]);

      const messages = await buildContext("agent", TEST_DIR);

      const allContent = messages.map((m) => m.content).join(" ");
      expect(allContent).not.toContain("<recover>");
    });
  });
});
