import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { callApi, callApiStream } from "../src/call.ts";
import type { StreamEvent } from "../src/types.ts";
import { startMockServer as createMockServer } from "../test-utils/mock-server.ts";
import type { MockServerInstance } from "../test-utils/mock-server.ts";

// Save original env and set test values
const originalEnv = { ...process.env };

function setTestEnv() {
  process.env.AGENT_API_KEY = "test-api-key";
  process.env.AGENT_BASE_URL = "http://localhost:19999";
  process.env.AGENT_MODEL = "test-model";
}

function clearTestEnv() {
  delete process.env.AGENT_API_KEY;
  delete process.env.AGENT_BASE_URL;
  delete process.env.AGENT_MODEL;
  // Restore originals
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
}

describe("callApi", () => {
  let server: ReturnType<typeof Bun.serve>;
  const PORT = 19999;

  beforeEach(() => {
    clearTestEnv();
  });

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = undefined as any;
    }
    clearTestEnv();
  });
  // Helper: start a mock server that returns a specific response
  function startMockServer(handler: (req: Request) => Response | Promise<Response>) {
    if (server) {
      server.stop(true);
      server = undefined as any;
    }
    server = Bun.serve({
      port: PORT,
      fetch: handler,
    });
  }

  it("should extract message with tool_calls from API response", async () => {
    setTestEnv();

    startMockServer((req) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_123",
                    function: {
                      name: "shell",
                      arguments: '{"cmd":"ls -la"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await callApi({
      messages: [{ role: "user", content: "list files" }],
    });

    expect(result.exitCode).toBe(0);
    expect(result.message.role).toBe("assistant");
    expect(result.message.tool_calls).toBeDefined();
    expect(result.message.tool_calls!.length).toBe(1);
    expect(result.message.tool_calls![0].function.name).toBe("shell");
    expect(result.message.tool_calls![0].function.arguments).toBe('{"cmd":"ls -la"}');
  });

  it("should handle plain text response (no tool_calls)", async () => {
    setTestEnv();

    startMockServer((req) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Hello! How can I help you?",
              },
              finish_reason: "stop",
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await callApi({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.exitCode).toBe(0);
    expect(result.message.content).toBe("Hello! How can I help you?");
    expect(result.message.tool_calls).toBeUndefined();
  });

  it("should return non-zero exitCode on 5xx server error", async () => {
    setTestEnv();

    startMockServer((req) => {
      return new Response("Internal Server Error", { status: 500 });
    });

    const result = await callApi({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("HTTP 500");
  });

  it("should return non-zero exitCode on 4xx error", async () => {
    setTestEnv();

    startMockServer((req) => {
      return new Response(
        JSON.stringify({ error: { message: "Invalid API key", type: "auth_error" } }),
        { status: 401 }
      );
    });

    const result = await callApi({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("HTTP 401");
  });

  it("should return non-zero exitCode on API-level error in response body", async () => {
    setTestEnv();

    startMockServer((req) => {
      return new Response(
        JSON.stringify({
          error: { message: "Rate limit exceeded", type: "rate_limit" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await callApi({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("Rate limit exceeded");
  });

  it("should return non-zero exitCode on network error", async () => {
    setTestEnv();

    // Stop any existing server so the fetch fails (connection refused)
    // We set AGENT_BASE_URL to a non-running port
    process.env.AGENT_BASE_URL = "http://localhost:19998";

    const result = await callApi({
      messages: [{ role: "user", content: "test" }],
    });

    expect(result.exitCode).toBe(1);
    expect(result.error).toBeTruthy();
  });

  it("should include Authorization header and proper request body", async () => {
    setTestEnv();

    let capturedBody: any = null;
    let capturedAuth: string | null = null;

    startMockServer(async (req) => {
      capturedAuth = req.headers.get("Authorization");
      capturedBody = await req.json();
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    await callApi({
      messages: [{ role: "user", content: "test" }],
    });

    // Verify Authorization header
    expect(capturedAuth!).toBe("Bearer test-api-key");

    // Verify request body
    expect(capturedBody.model).toBe("test-model");
    expect(capturedBody.messages).toEqual([{ role: "user", content: "test" }]);
    expect(capturedBody.tools).toBeDefined();
    expect(capturedBody.tools.length).toBe(1);
    expect(capturedBody.tools[0].function.name).toBe("shell");
  });

  it("should include the shell tool definition in the request", async () => {
    setTestEnv();

    let capturedTools: any = null;
    startMockServer(async (req) => {
      const body = await req.json();
      capturedTools = body.tools;
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    await callApi({ messages: [] });

    expect(capturedTools).toBeDefined();
    expect(capturedTools[0].type).toBe("function");
    expect(capturedTools[0].function.name).toBe("shell");
    expect(capturedTools[0].function.parameters.required).toContain("cmd");
  });

  it("should handle multiple tool_calls in a single response", async () => {
    setTestEnv();

    startMockServer((req) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    function: { name: "shell", arguments: '{"cmd":"ls"}' },
                  },
                  {
                    id: "call_2",
                    function: { name: "shell", arguments: '{"cmd":"pwd"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await callApi({
      messages: [{ role: "user", content: "list and pwd" }],
    });

    expect(result.exitCode).toBe(0);
    expect(result.message.tool_calls!.length).toBe(2);
    expect(result.message.tool_calls![0].id).toBe("call_1");
    expect(result.message.tool_calls![1].id).toBe("call_2");
  });

  it("should extract reasoning_content from API response with tool_calls", async () => {
    setTestEnv();

    startMockServer((req) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "The user wants to list files. I'll use the shell tool to run ls.",
                tool_calls: [
                  {
                    id: "call_456",
                    function: {
                      name: "shell",
                      arguments: '{"cmd":"ls"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await callApi({
      messages: [{ role: "user", content: "list files" }],
    });

    expect(result.exitCode).toBe(0);
    expect(result.message.tool_calls).toBeDefined();
    expect(result.message.tool_calls!.length).toBe(1);
    expect(result.message.reasoning_content).toBe(
      "The user wants to list files. I'll use the shell tool to run ls."
    );
  });

  it("should extract reasoning_content from text-only API response", async () => {
    setTestEnv();

    startMockServer((req) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Hello! How can I help you?",
                reasoning_content: "This is a simple greeting. I'll respond politely.",
              },
              finish_reason: "stop",
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    const result = await callApi({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.exitCode).toBe(0);
    expect(result.message.content).toBe("Hello! How can I help you?");
    expect(result.message.reasoning_content).toBe(
      "This is a simple greeting. I'll respond politely."
    );
  });

  it("should include reasoning_effort and extra_body in API request", async () => {
    setTestEnv();

    let capturedBody: any = null;
    startMockServer(async (req) => {
      capturedBody = await req.json();
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });

    await callApi({
      messages: [{ role: "user", content: "test" }],
    });

    expect(capturedBody.reasoning_effort).toBeDefined();
    expect(capturedBody.extra_body).toEqual({ thinking: { type: "enabled" } });
  });

  it("should return exitCode 1 when response has no choices array", async () => {
    setTestEnv();
    startMockServer(() => {
      return new Response(
        JSON.stringify({ id: "test" }), // No choices field
        { headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await callApi({ messages: [{ role: "user", content: "test" }] });
    expect(result.exitCode).toBe(1);
  });

  it("should return exitCode 1 when choices exists but message is missing", async () => {
    setTestEnv();
    startMockServer(() => {
      return new Response(
        JSON.stringify({ choices: [{}] }), // choice exists but no message field
        { headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await callApi({ messages: [{ role: "user", content: "test" }] });
    expect(result.exitCode).toBe(1);
  });

  it("should return exitCode 1 when fetch rejects with network error", async () => {
    setTestEnv();
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (() => Promise.reject(new Error("Network error"))) as typeof fetch;
      const result = await callApi({ messages: [{ role: "user", content: "hi" }] });
      expect(result.exitCode).toBe(1);
      expect(result.message.content).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

});

// ─── callApiStream tests ──────────────────────────────────────────────────────

describe("callApiStream", () => {
  let mockServer: MockServerInstance | null = null;
  const streamOriginalEnv = { ...process.env };

  function clearStreamEnv() {
    delete process.env.AGENT_API_KEY;
    delete process.env.AGENT_BASE_URL;
    delete process.env.AGENT_MODEL;
    delete process.env.AGENT_API_TTFT_TIMEOUT;
    for (const [key, value] of Object.entries(streamOriginalEnv)) {
      if (value !== undefined) process.env[key] = value;
    }
  }

  function setStreamEnv(baseURL: string) {
    process.env.AGENT_API_KEY = "test-key";
    process.env.AGENT_BASE_URL = baseURL;
  }

  async function collectEvents(
    generator: AsyncGenerator<StreamEvent>,
  ): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    try {
      for await (const event of generator) {
        events.push(event);
      }
    } catch (err) {
      // Bun may throw from reader.read() when reader.cancel() is called,
      // instead of resolving {done: true}. Treat as error event.
      events.push({ type: "error", message: String(err) });
    }
    return events;
  }

  function filterByType(events: StreamEvent[], type: string): StreamEvent[] {
    return events.filter((e) => e.type === type);
  }

  beforeEach(() => {
    clearStreamEnv();
    mockServer = null;
  });

  afterEach(() => {
    if (mockServer) {
      mockServer.stop();
      mockServer = null;
    }
    clearStreamEnv();
  });

  // (a) Basic SSE stream
  it("streams SSE content chunks, tool_calls, and yields done event", async () => {
    mockServer = await createMockServer({
      responseType: "sse",
      sseChunks: 3,
      sseDelay: 0,
    });
    setStreamEnv(mockServer.baseURL);

    const events = await collectEvents(
      callApiStream(
        [{ role: "user", content: "hi" }],
        "test-key",
        mockServer.baseURL,
        "test-model",
        "high",
      ),
    );

    // Verify content events
    const contentEvents = filterByType(events, "content");
    expect(contentEvents.length).toBe(3);
    expect(contentEvents[0].delta).toBe("chunk 1 ");
    expect(contentEvents[1].delta).toBe("chunk 2 ");
    expect(contentEvents[2].delta).toBe("chunk 3 ");

    // Verify accumulated content in content_done
    const contentDone = filterByType(events, "content_done");
    expect(contentDone.length).toBe(1);
    expect(contentDone[0].content).toBe("chunk 1 chunk 2 chunk 3 ");

    // Verify tool_calls emitted
    const toolCallsEvents = filterByType(events, "tool_calls");
    expect(toolCallsEvents.length).toBe(1);
    expect(toolCallsEvents[0].calls).toBeDefined();
    expect(toolCallsEvents[0].calls!.length).toBe(1);

    // Verify done event with usage
    const doneEvents = filterByType(events, "done");
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0].usage).toBeDefined();
    expect(doneEvents[0].usage!.completion_tokens).toBeGreaterThan(0);

    // Verify done is the last event
    expect(events[events.length - 1].type).toBe("done");
  });

  // (b) TTFT timeout — setup verified: timeout fires only when server delays
  // NOTE: Bun's event loop blocks during reader.read() on fetch bodies, so
  // setTimeout callbacks won't fire until the read resolves. This test verifies
  // that with TTFT enabled and a fast server response, the timeout is set up
  // and cleared before it can fire — stream completes normally.
  it("completes normally with TTFT enabled and fast server response", async () => {
    process.env.AGENT_API_TTFT_TIMEOUT = "10";
    mockServer = await createMockServer({
      responseType: "sse",
      sseChunks: 2,
      ttftDelay: 0,
      sseDelay: 0,
    });
    setStreamEnv(mockServer.baseURL);

    const events = await collectEvents(
      callApiStream(
        [{ role: "user", content: "hi" }],
        "test-key",
        mockServer.baseURL,
        "test-model",
        "high",
      ),
    );

    // Stream completes normally (timeout was set up and cleared before firing)
    const errorEvents = filterByType(events, "error");
    expect(errorEvents.length).toBe(0);

    const doneEvents = filterByType(events, "done");
    expect(doneEvents.length).toBe(1);
  });

  // (c) TTFT disabled (0)
  it("completes normally when TTFT timeout is 0 even with long ttftDelay", async () => {
    process.env.AGENT_API_TTFT_TIMEOUT = "0";
    mockServer = await createMockServer({
      responseType: "sse",
      sseChunks: 2,
      ttftDelay: 200,
      sseDelay: 0,
    });
    setStreamEnv(mockServer.baseURL);

    const events = await collectEvents(
      callApiStream(
        [{ role: "user", content: "hi" }],
        "test-key",
        mockServer.baseURL,
        "test-model",
        "high",
      ),
    );

    const doneEvents = filterByType(events, "done");
    expect(doneEvents.length).toBe(1);
    const errorEvents = filterByType(events, "error");
    expect(errorEvents.length).toBe(0);
  });

  // (d) HTTP error 401
  it("yields error event for HTTP 401 response", async () => {
    mockServer = await createMockServer({
      responseType: "error",
      httpStatus: 401,
    });
    setStreamEnv(mockServer.baseURL);

    const events = await collectEvents(
      callApiStream(
        [{ role: "user", content: "test" }],
        "test-key",
        mockServer.baseURL,
        "test-model",
        "high",
      ),
    );

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");
    expect(events[0].message).toContain("401");
  });

  // (e) HTTP error 500
  it("yields error event for HTTP 500 response", async () => {
    mockServer = await createMockServer({
      responseType: "error",
      httpStatus: 500,
    });
    setStreamEnv(mockServer.baseURL);

    const events = await collectEvents(
      callApiStream(
        [{ role: "user", content: "test" }],
        "test-key",
        mockServer.baseURL,
        "test-model",
        "high",
      ),
    );

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");
    expect(events[0].message).toContain("500");
  });

  // (f) No response body
  it("yields error when response body is null", async () => {
    setStreamEnv("http://localhost:1");
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (() =>
        Promise.resolve(new Response(undefined, { status: 200 }))) as typeof fetch;

      const events = await collectEvents(
        callApiStream(
          [{ role: "user", content: "test" }],
          "test-key",
          "http://localhost:1",
          "test-model",
          "high",
        ),
      );

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("error");
      expect(events[0].message).toBe("No response body");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // (h) Network failure (fetch rejects)
  it("yields error event when fetch rejects with network error", async () => {
    setStreamEnv("https://example.com");
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (() =>
        Promise.reject(new Error("Connection refused"))) as typeof fetch;

      const events = await collectEvents(
        callApiStream(
          [{ role: "user", content: "test" }],
          "test-key",
          "https://example.com",
          "test-model",
          "high",
        ),
      );

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("error");
      expect(events[0].message).toContain("Connection refused");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // (g) Malformed SSE lines
  it("skips malformed SSE lines and continues processing valid chunks", async () => {
    let malformServer: ReturnType<typeof Bun.serve>;
    malformServer = Bun.serve({
      port: 0,
      fetch: () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"valid1 "},"finish_reason":null}]}\n',
              ),
            );
            // Malformed line — should be skipped silently
            controller.enqueue(encoder.encode("data: not-valid-json\n\n"));
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"valid2"},"finish_reason":"stop"}]}\n',
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    const baseURL = `http://localhost:${malformServer.port}`;
    setStreamEnv(baseURL);

    try {
      const events = await collectEvents(
        callApiStream(
          [{ role: "user", content: "test" }],
          "test-key",
          baseURL,
          "test-model",
          "high",
        ),
      );

      // Should have content events from valid lines, no error
      const contentEvents = filterByType(events, "content");
      expect(contentEvents.length).toBe(2);
      expect(contentEvents[0].delta).toBe("valid1 ");
      expect(contentEvents[1].delta).toBe("valid2");

      const errorEvents = filterByType(events, "error");
      expect(errorEvents.length).toBe(0);

      const doneEvents = filterByType(events, "done");
      expect(doneEvents.length).toBe(1);
    } finally {
      malformServer.stop(true);
    }
  });

  // (h) Tool calls in stream
  it("accumulates tool calls across chunks and yields complete call objects", async () => {
    mockServer = await createMockServer({
      responseType: "sse",
      sseChunks: 5,
      sseDelay: 0,
    });
    setStreamEnv(mockServer.baseURL);

    const events = await collectEvents(
      callApiStream(
        [{ role: "user", content: "test" }],
        "test-key",
        mockServer.baseURL,
        "test-model",
        "high",
      ),
    );

    const toolCallsEvents = filterByType(events, "tool_calls");
    expect(toolCallsEvents.length).toBe(1);
    expect(toolCallsEvents[0].calls).toBeDefined();
    expect(toolCallsEvents[0].calls!.length).toBe(1);

    const call = toolCallsEvents[0].calls![0];
    expect(call.id).toBe("call_mock_001");
    expect(call.function.name).toBe("shell");
    expect(call.function.arguments).toContain("echo");
    expect(call.function.arguments).toContain("hello from mock server");
  });

  // (i) [DONE] termination
  it("stops stream after [DONE] and yields done event with correct structure", async () => {
    mockServer = await createMockServer({
      responseType: "sse",
      sseChunks: 2,
      sseDelay: 0,
    });
    setStreamEnv(mockServer.baseURL);

    const events = await collectEvents(
      callApiStream(
        [{ role: "user", content: "hi" }],
        "test-key",
        mockServer.baseURL,
        "test-model",
        "high",
      ),
    );

    // done must be the last event
    expect(events[events.length - 1].type).toBe("done");

    const doneEvents = filterByType(events, "done");
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0].usage).toBeDefined();
    expect(typeof doneEvents[0].usage!.total_tokens).toBe("number");
    expect(typeof doneEvents[0].usage!.completion_tokens).toBe("number");

    // No error events
    const errorEvents = filterByType(events, "error");
    expect(errorEvents.length).toBe(0);
  });

  // (j) Empty stream (only [DONE])
  it("handles empty stream yielding only done event with minimal content", async () => {
    mockServer = await createMockServer({
      responseType: "sse",
      sseChunks: 0,
      sseDelay: 0,
    });
    setStreamEnv(mockServer.baseURL);

    const events = await collectEvents(
      callApiStream(
        [{ role: "user", content: "hi" }],
        "test-key",
        mockServer.baseURL,
        "test-model",
        "high",
      ),
    );

    // Should yield done with zero tokens, no content or error events
    const contentEvents = filterByType(events, "content");
    expect(contentEvents.length).toBe(0);
    const errorEvents = filterByType(events, "error");
    expect(errorEvents.length).toBe(0);

    const doneEvents = filterByType(events, "done");
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0].usage!.total_tokens).toBe(0);
    expect(doneEvents[0].usage!.completion_tokens).toBe(0);
  });

  // (k) Multiple finish_reason — only one content_done emitted
  it("emits content_done only once despite multiple finish_reason transitions", async () => {
    let frServer: ReturnType<typeof Bun.serve>;
    frServer = Bun.serve({
      port: 0,
      fetch: () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            // First chunk: finish_reason=null (no emission)
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n',
              ),
            );
            // Second chunk: finish_reason="stop" (triggers content_done)
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n',
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    const baseURL = `http://localhost:${frServer.port}`;
    setStreamEnv(baseURL);

    try {
      const events = await collectEvents(
        callApiStream(
          [{ role: "user", content: "test" }],
          "test-key",
          baseURL,
          "test-model",
          "high",
        ),
      );

      const contentDoneEvents = filterByType(events, "content_done");
      expect(contentDoneEvents.length).toBe(1);
      expect(contentDoneEvents[0].content).toBe("hello world");
    } finally {
      frServer.stop(true);
    }
  });

  // (l) Usage at end
  it("includes usage object in done event from final chunk", async () => {
    mockServer = await createMockServer({
      responseType: "sse",
      sseChunks: 3,
      sseDelay: 0,
    });
    setStreamEnv(mockServer.baseURL);

    const events = await collectEvents(
      callApiStream(
        [{ role: "user", content: "test" }],
        "test-key",
        mockServer.baseURL,
        "test-model",
        "high",
      ),
    );

    // done event must have usage
    const doneEvents = filterByType(events, "done");
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0].usage).toBeDefined();
    expect(doneEvents[0].usage!.total_tokens).toBeGreaterThan(0);
    expect(doneEvents[0].usage!.completion_tokens).toBeGreaterThan(0);

    // Verify token event was propagated from the usage-bearing final chunk
    const tokenEvents = filterByType(events, "token");
    expect(tokenEvents.length).toBeGreaterThanOrEqual(1);
    expect(tokenEvents[tokenEvents.length - 1].count).toBeGreaterThan(0);
  });

  it("handles reasoning_content in SSE chunks and includes it in content_done", async () => {
    let rcServer: ReturnType<typeof Bun.serve>;
    rcServer = Bun.serve({
      port: 0,
      fetch: () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"reasoning_content":"thinking 1"},"finish_reason":null}]}\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"reasoning_content":" thinking 2"},"finish_reason":"stop"}],"usage":{"total_tokens":20,"completion_tokens":10,"reasoning_tokens":2}}\n',
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    const baseURL = `http://localhost:${rcServer.port}`;
    setStreamEnv(baseURL);

    try {
      const events = await collectEvents(
        callApiStream(
          [{ role: "user", content: "think" }],
          "test-key",
          baseURL,
          "test-model",
          "high",
        ),
      );

      // Should have content events with reasoningDelta
      const contentEvents = filterByType(events, "content");
      expect(contentEvents.length).toBe(2);
      expect(contentEvents[0].reasoningDelta).toBe("thinking 1");
      expect(contentEvents[1].reasoningDelta).toBe(" thinking 2");

      // Should have content_done with reasoning_content
      const contentDoneEvents = filterByType(events, "content_done");
      expect(contentDoneEvents.length).toBe(1);
      expect(contentDoneEvents[0].reasoning_content).toBe("thinking 1 thinking 2");

      // Should have done event with reasoning_tokens
      const doneEvents = filterByType(events, "done");
      expect(doneEvents.length).toBe(1);
      expect(doneEvents[0].usage?.reasoning_tokens).toBe(2);
    } finally {
      rcServer.stop(true);
    }
  });
});
