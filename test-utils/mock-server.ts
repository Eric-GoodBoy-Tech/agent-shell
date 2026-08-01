/**
 * Shared mock OpenAI-compatible API server for agent-shell tests.
 *
 * Usage (import):
 *   import { startMockServer } from "./test-utils/mock-server.ts";
 *   const { server, baseURL, stop } = startMockServer({ responseType: "tool_calls" });
 *   // ... run test ...
 *   stop();
 *
 * Usage (standalone self-test):
 *   bun run test-utils/mock-server.ts --self-test
 */

export interface MockServerOptions {
  /** Port to listen on (default: 0 = auto-assign). */
  port?: number;
  /** Simulated latency in ms before each response (default: 0). */
  latency?: number;
  /** Response type (default: "tool_calls"). */
  responseType?: "tool_calls" | "text" | "multi" | "sse" | "error" | "dynamic";
  /** Number of SSE chunks in streaming mode (default: 5). */
  sseChunks?: number;
  /** ms delay between SSE chunks (default: 50). */
  sseDelay?: number;
  /** ms delay before first SSE byte — for TTFT timeout testing (default: 0). */
  ttftDelay?: number;
  /** HTTP status for error responses (default: 200). */
  httpStatus?: number;
  /** Error message for error responses (default: "Internal server error"). */
  errorMessage?: string;
}

export interface MockServerInstance {
  server: ReturnType<typeof Bun.serve>;
  baseURL: string;
  stop: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeDefaults(opts: MockServerOptions): Required<MockServerOptions> {
  return {
    port: opts.port ?? 0,
    latency: opts.latency ?? 0,
    responseType: opts.responseType ?? "tool_calls",
    sseChunks: opts.sseChunks ?? 5,
    sseDelay: opts.sseDelay ?? 50,
    ttftDelay: opts.ttftDelay ?? 0,
    httpStatus: opts.httpStatus ?? 200,
    errorMessage: opts.errorMessage ?? "Internal server error",
  };
}

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeUsage(total: number, completion: number, prompt: number = 100): object {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
}

function buildToolCallResponse(): object {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "I will execute the requested command.",
          tool_calls: [
            {
              id: "call_mock_001",
              type: "function",
              function: {
                name: "shell",
                arguments: JSON.stringify({ cmd: 'echo "hello from mock server"' }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: makeUsage(150, 50),
  };
}

function buildTextResponse(): object {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Here is a plain text response with no tool calls.",
        },
        finish_reason: "stop",
      },
    ],
    usage: makeUsage(120, 30),
  };
}

function buildMultiResponse(): object {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "I will run multiple commands in sequence.",
          tool_calls: [
            {
              id: "call_multi_001",
              type: "function",
              function: {
                name: "shell",
                arguments: JSON.stringify({ cmd: "echo first_command" }),
              },
            },
            {
              id: "call_multi_002",
              type: "function",
              function: {
                name: "shell",
                arguments: JSON.stringify({ cmd: "echo second_command" }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: makeUsage(200, 80),
  };
}

function buildDynamicToolCallResponse(): object {
  return {
    id: "chatcmpl-e2e-mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "e2e-test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "I will execute the requested command.",
          tool_calls: [
            {
              id: "call_e2e_mock_001",
              type: "function",
              function: {
                name: "shell",
                arguments: JSON.stringify({ cmd: 'echo "hello from agent shell e2e test"' }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function buildDynamicTextResponse(): object {
  return {
    id: "chatcmpl-e2e-mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "e2e-test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Here is a plain text response with no tool calls needed.",
        },
        finish_reason: "stop",
      },
    ],
  };
}

function buildDynamicMultiResponse(): object {
  return {
    id: "chatcmpl-e2e-mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "e2e-test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "I will run multiple commands in sequence.",
          tool_calls: [
            {
              id: "call_multi_001",
              type: "function",
              function: {
                name: "shell",
                arguments: JSON.stringify({ cmd: "echo first_command" }),
              },
            },
            {
              id: "call_multi_002",
              type: "function",
              function: {
                name: "shell",
                arguments: JSON.stringify({ cmd: "echo second_command" }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function buildErrorResponse(status: number, message: string): Response {
  return jsonResponse(
    {
      error: {
        message,
        type: "internal_error",
        code: "internal_error",
      },
    },
    status,
  );
}

function buildSSEChunk(
  content: string,
  finishReason: string | null,
  toolCalls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>,
  usageObj?: object,
): string {
  const chunk: Record<string, unknown> = {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "test-model",
    choices: [
      {
        index: 0,
        delta: {} as Record<string, unknown>,
        finish_reason: finishReason,
      },
    ],
  };

  const delta = (chunk.choices as Array<Record<string, unknown>>)[0].delta as Record<string, unknown>;
  if (content) {
    delta.content = content;
  }
  if (toolCalls) {
    delta.tool_calls = toolCalls;
  }
  if (usageObj) {
    chunk.usage = usageObj;
  }

  return `data: ${JSON.stringify(chunk)}`;
}

async function handleSSE(opts: Required<MockServerOptions>): Promise<Response> {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      // TTFT delay before first byte
      if (opts.ttftDelay > 0) {
        await sleep(opts.ttftDelay);
      }

      let accumulatedTokens = 0;

      // Send content chunks, with tool_calls sprinkled into some chunks
      for (let i = 0; i < opts.sseChunks; i++) {
        if (closed) return;
        const contentChunk = `chunk ${i + 1} `;
        accumulatedTokens += 5;

        let toolCalls: Array<{
          index: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }> | undefined;

        // Sprinkle tool calls into chunks 1 and 3 (0-indexed) to simulate multi-chunk delivery
        if (i === 1) {
          toolCalls = [
            {
              index: 0,
              id: "call_mock_001",
              function: {
                name: "shell",
                arguments: JSON.stringify({ cmd: "echo " }),
              },
            },
          ];
        } else if (i === 2) {
          toolCalls = [
            {
              index: 0,
              function: {
                arguments: JSON.stringify('"hello from mock server"'),
              },
            },
          ];
        }

        const isLast = i === opts.sseChunks - 1;
        const line = buildSSEChunk(
          contentChunk,
          isLast ? "stop" : null,
          toolCalls,
          isLast ? makeUsage(accumulatedTokens + 50, accumulatedTokens) : undefined,
        );

        controller.enqueue(encoder.encode(line + "\n"));

        if (!isLast && opts.sseDelay > 0) {
          await sleep(opts.sseDelay);
        }
      }

      // Final DONE marker
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function handleJSON(opts: Required<MockServerOptions>): Response {
  switch (opts.responseType) {
    case "tool_calls":
      return jsonResponse(buildToolCallResponse());
    case "text":
      return jsonResponse(buildTextResponse());
    case "multi":
      return jsonResponse(buildMultiResponse());
    case "error":
      return buildErrorResponse(opts.httpStatus, opts.errorMessage);
    default:
      return jsonResponse(buildToolCallResponse());
  }
}

async function handleDynamic(req: Request): Promise<Response> {
  let responseType: "tool_calls" | "text" | "multi" = "tool_calls";
  try {
    const body = await req.json();
    const userContent = (body.messages || [])
      .filter((m: { role: string; content: string }) => m.role === "user")
      .map((m: { role: string; content: string }) => m.content)
      .join(" ");
    if (userContent.includes("NO_TOOLS")) responseType = "text";
    else if (userContent.includes("MULTI_TOOLS")) responseType = "multi";
  } catch {
    // If body parsing fails, use default tool_calls response
  }

  switch (responseType) {
    case "text":
      return jsonResponse(buildDynamicTextResponse());
    case "multi":
      return jsonResponse(buildDynamicMultiResponse());
    default:
      return jsonResponse(buildDynamicToolCallResponse());
  }
}

function tryServe(port: number, fetch: (req: Request) => Response | Promise<Response>): ReturnType<typeof Bun.serve> {
  return Bun.serve({ port, fetch });
}

/**
 * Start a mock OpenAI-compatible API server.
 *
 * @param opts - Configuration options for the mock server
 * @returns An object with the server instance, base URL, and stop function
 */
export async function startMockServer(opts: MockServerOptions = {}): Promise<MockServerInstance> {
  const options = mergeDefaults(opts);

  let server: ReturnType<typeof Bun.serve>;
  let actualPort = options.port;

  // Port collision handling: retry up to 3 times with exponential backoff
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 100;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      server = tryServe(actualPort, async (req: Request) => {
        // Apply latency simulation
        if (options.latency > 0) {
          await sleep(options.latency);
        }

        if (options.responseType === "sse") {
          return handleSSE(options);
        }

        if (options.responseType === "dynamic") {
          return handleDynamic(req);
        }

        return handleJSON(options);
      });
      actualPort = server.port;
      break;
    } catch (err: unknown) {
      if (attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        // Busy-wait approximation: setTimeout is async, but we need sync retry in loop
        // Use a tight-ish approach: try the actualPort + 1 on next iteration
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, delay);
        await promise;
        actualPort = (actualPort || options.port) + 1;
      } else {
        throw err;
      }
    }
  }

  const serverRef = server!;

  return {
    server: serverRef,
    baseURL: `http://localhost:${serverRef.port}`,
    stop: () => {
      serverRef.stop(true);
    },
  };
}

// ─── Self-test mode ───────────────────────────────────────────────────────────

async function runSelfTest(): Promise<void> {
  let failed = 0;
  let passed = 0;

  async function testType(
    label: string,
    opts: MockServerOptions,
    validate: (res: Response, body: unknown) => boolean,
  ): Promise<void> {
    const { baseURL, stop } = await startMockServer(opts);
    try {
      const res = await fetch(`${baseURL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      let body: unknown;
      const contentType = res.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream")) {
        const text = await res.text();
        body = text; // pass raw text for SSE validation
      } else {
        body = await res.json();
      }

      if (validate(res, body)) {
        console.log(`PASS: ${label}`);
        passed++;
      } else {
        console.log(`FAIL: ${label} validation returned false`);
        failed++;
      }
    } catch (err) {
      console.log(`FAIL: ${label} ${err}`);
      failed++;
    } finally {
      stop();
    }
  }

  // 1. tool_calls
  await testType("tool_calls", { responseType: "tool_calls" }, (res, body) => {
    const data = body as Record<string, unknown>;
    if (res.status !== 200) return false;
    if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) return false;
    const choice = data.choices[0] as Record<string, unknown>;
    if (!choice.message) return false;
    const msg = choice.message as Record<string, unknown>;
    if (msg.role !== "assistant") return false;
    if (!msg.tool_calls || !Array.isArray(msg.tool_calls)) return false;
    const tcs = msg.tool_calls as Array<Record<string, unknown>>;
    if (tcs.length !== 1) return false;
    if (!data.usage) return false;
    return true;
  });

  // 2. text
  await testType("text", { responseType: "text" }, (res, body) => {
    const data = body as Record<string, unknown>;
    if (res.status !== 200) return false;
    if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) return false;
    const choice = data.choices[0] as Record<string, unknown>;
    if (!choice.message) return false;
    const msg = choice.message as Record<string, unknown>;
    if (msg.role !== "assistant") return false;
    if (typeof msg.content !== "string") return false;
    if (msg.tool_calls) return false; // should NOT have tool_calls
    if (choice.finish_reason !== "stop") return false;
    if (!data.usage) return false;
    return true;
  });

  // 3. multi
  await testType("multi", { responseType: "multi" }, (res, body) => {
    const data = body as Record<string, unknown>;
    if (res.status !== 200) return false;
    if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) return false;
    const choice = data.choices[0] as Record<string, unknown>;
    if (!choice.message) return false;
    const msg = choice.message as Record<string, unknown>;
    if (!msg.tool_calls || !Array.isArray(msg.tool_calls)) return false;
    const tcs = msg.tool_calls as Array<Record<string, unknown>>;
    if (tcs.length !== 2) return false;
    if ((tcs[0] as Record<string, unknown>).id === (tcs[1] as Record<string, unknown>).id) return false;
    if (!data.usage) return false;
    return true;
  });

  // 4. error
  await testType("error", { responseType: "error", httpStatus: 500, errorMessage: "Test error" }, (res, body) => {
    if (res.status !== 500) return false;
    const data = body as Record<string, unknown>;
    if (!data.error) return false;
    const err = data.error as Record<string, unknown>;
    if (err.message !== "Test error") return false;
    return true;
  });

  // 5. sse
  await testType("sse", { responseType: "sse", sseChunks: 5, sseDelay: 10 }, (res, body) => {
    if (res.status !== 200) return false;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) return false;

    const text = body as string;
    const lines = text.trim().split("\n");

    // Should have data lines and end with [DONE]
    const dataLines = lines.filter((l) => l.startsWith("data: "));
    if (dataLines.length === 0) return false;

    const lastData = dataLines[dataLines.length - 1]!;
    if (!lastData.includes("[DONE]")) return false;

    // Check that we have content chunks + at least one with tool_calls
    let hasToolCalls = false;
    let hasUsage = false;
    for (const line of dataLines) {
      if (line.includes("[DONE]")) continue;
      try {
        const chunk = JSON.parse(line.slice(6));
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.tool_calls) hasToolCalls = true;
        if (chunk.usage) hasUsage = true;
      } catch {
        // skip unparseable
      }
    }
    if (!hasToolCalls) return false;
    if (!hasUsage) return false;

    return true;
  });

  // Report
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

// ─── CLI entry point (when run directly with bun) ────────────────────────────

if (import.meta.main) {
  const args = Bun.argv.slice(2);

  if (args.includes("--self-test")) {
    runSelfTest().catch((err) => {
      console.error("Self-test crashed:", err);
      process.exit(1);
    });
  } else {
    // Parse --port and --write-port
    const portIdx = args.indexOf("--port");
    const writePortIdx = args.indexOf("--write-port");
    const responseTypeIdx = args.indexOf("--response-type");

    const port = portIdx !== -1 ? parseInt(args[portIdx + 1]!, 10) : 0;
    const writePortPath = writePortIdx !== -1 ? args[writePortIdx + 1]! : null;
    const responseType = (responseTypeIdx !== -1 ? args[responseTypeIdx + 1] : "dynamic") as MockServerOptions["responseType"];

    const sseChunksIdx = args.indexOf("--sse-chunks");
    const sseChunks = sseChunksIdx !== -1 ? parseInt(args[sseChunksIdx + 1]!, 10) : 3;

    const instance = await startMockServer({ port, responseType, sseChunks });

    if (writePortPath) {
      await Bun.write(writePortPath, String(instance.server.port));
    }

    console.log(`MOCK_READY:${instance.server.port}`);

    // Keep running until killed
    await new Promise(() => {});
  }
}
