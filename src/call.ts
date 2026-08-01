import { loadConfig } from "./config.ts";
import type { CallOptions, CallResult, StreamEvent, ToolCall, Message } from "./types.ts";

const CHARS_PER_TOKEN = 3;
const MIN_PROGRESS_INTERVAL_MS = 100;

function computeSpeed(totalTokens: number, firstTokenTime: number | null): number {
  if (!firstTokenTime) return 0;
  const elapsedMs = Date.now() - firstTokenTime;
  if (elapsedMs <= 0) return 0;
  return Math.round((totalTokens / elapsedMs) * 1000);
}

/**
 * Shell tool definition sent with every API request.
 * This is the ONLY tool the model can use.
 */
export const SHELL_TOOL = {
  type: "function" as const,
  function: {
    name: "shell",
    description: "Execute a shell command",
    parameters: {
      type: "object",
      properties: {
        cmd: {
          type: "string",
          description: "The shell command to execute",
        },
      },
      required: ["cmd"],
    },
  },
};

/**
 * Makes a non-streaming chat completion API call.
 *
 * Sends messages + shell tool definition to the LLM API.
 * Extracts and returns the assistant message (role, content, tool_calls).
 * On HTTP errors or API errors, returns non-zero exitCode.
 *
 * @param options - Call options including messages array
 * @returns CallResult with the assistant message and exit code
 */
export async function callApi(options: CallOptions): Promise<CallResult> {
  const config = loadConfig();

  const url = `${config.AGENT_BASE_URL}/v1/chat/completions`;

  const body = {
    model: config.AGENT_MODEL,
    messages: options.messages,
    tools: [SHELL_TOOL],
    reasoning_effort: config.AGENT_REASONING_EFFORT,
    extra_body: { thinking: { type: "enabled" } },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.AGENT_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let errorDetail = `HTTP ${response.status}`;
      try {
        const errBody = await response.text();
        if (errBody) errorDetail += `: ${errBody.slice(0, 200)}`;
      } catch {
        /* ignore body read failure */
      }
      return {
        message: {
          role: "assistant",
          content: null,
        },
        exitCode: 1,
        error: errorDetail,
      };
    }

    const data = await response.json();
    const usage = data.usage;

    // Check for API-level error
    if (data.error) {
      return {
        message: {
          role: "assistant",
          content: null,
        },
        exitCode: 1,
        error: data.error.message || JSON.stringify(data.error),
      };
    }

    // Extract the first choice's message
    const choice = data.choices?.[0];
    if (!choice || !choice.message) {
      return {
        message: {
          role: "assistant",
          content: null,
        },
        exitCode: 1,
        error: "API response missing choices or message",
      };
    }

    const message = {
      role: choice.message.role || "assistant",
      content: choice.message.content ?? null,
      tool_calls: choice.message.tool_calls as ToolCall[] | undefined,
      reasoning_content: choice.message.reasoning_content ?? null,
    };

    return {
      message,
      exitCode: 0,
      usage,
    };
  } catch (err) {
    // Network or other fetch errors
    const msg = err instanceof Error ? err.message : String(err);
    return {
      message: {
        role: "assistant",
        content: null,
      },
      exitCode: 1,
      error: msg,
    };
  }
}

/**
 * Makes a streaming chat completion API call via SSE.
 *
 * Sends messages + shell tool definition to the LLM API with stream=true.
 * Reads the SSE response body line-by-line and yields typed StreamEvent objects.
 * Tool call arguments are accumulated across chunks since the API streams them
 * in fragments (name first, then arguments piece by piece).
 *
 * @param messages - Chat messages array
 * @param apiKey - API key for the LLM provider
 * @param baseUrl - Base URL of the LLM API endpoint
 * @param model - Model name to use
 * @returns AsyncGenerator yielding StreamEvent objects
 */
export async function* callApiStream(
  messages: Message[],
  apiKey: string,
  baseUrl: string,
  model: string,
  reasoningEffort: string
): AsyncGenerator<StreamEvent> {
  const config = loadConfig();
  const ttftTimeoutMs = (config.AGENT_API_TTFT_TIMEOUT || 0) * 1000;
  let firstTokenTimedOut = false;
  let isFirstRead = true;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        reasoning_effort: reasoningEffort,
        extra_body: { thinking: { type: "enabled" } },
        tools: [SHELL_TOOL],
      }),
    });
  } catch (err) {
    yield { type: "error", message: String(err) };
    return;
  }

  if (!response.ok) {
    yield { type: "error", message: `HTTP ${response.status}` };
    return;
  }

  if (!response.body) {
    yield { type: "error", message: "No response body" };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let fullReasoningContent = "";
  const toolCalls: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }> = [];
  let tokenCount = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let apiReasoningTokens: number | null = null;
  let firstTokenTime: number | null = null;
  let lastProgressTime: number | null = null;

  streamLoop: while (true) {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (isFirstRead && ttftTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        firstTokenTimedOut = true;
        reader.cancel("First token timeout").catch(() => {});
      }, ttftTimeoutMs);
    }
    const { done, value } = await reader.read();
    if (timeoutId) clearTimeout(timeoutId);
    isFirstRead = false;

    if (firstTokenTimedOut) {
      yield { type: "error", message: "First token timeout" };
      return;
    }
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") break streamLoop;

      try {
        const chunk = JSON.parse(data);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        const usage = chunk.usage;

        // Token count updates from usage (sent at end with stream_options.include_usage)
        if (usage?.total_tokens) {
          tokenCount = usage.total_tokens;
          completionTokens = usage.completion_tokens || 0;
          apiReasoningTokens = usage.reasoning_tokens || reasoningTokens;
          yield {
            type: "token",
            count: tokenCount,
            completionTokens,
            reasoning: apiReasoningTokens ?? undefined,
            tokens: tokenCount,
            speed: computeSpeed(tokenCount, firstTokenTime),
          };
        }

        // Content streaming — yield each delta
        if (delta?.content) {
          if (firstTokenTime === null) {
            firstTokenTime = Date.now();
          }
          fullContent += delta.content;
          yield { type: "content", delta: delta.content, count: fullContent.length };

          const estimatedContentTokens = Math.round(fullContent.length / CHARS_PER_TOKEN);
          const estimatedReasoningTokens = Math.round(fullReasoningContent.length / CHARS_PER_TOKEN);
          const totalEstimatedTokens = Math.max(1, estimatedContentTokens + estimatedReasoningTokens);
          const now = Date.now();
          if (lastProgressTime === null || now - lastProgressTime >= MIN_PROGRESS_INTERVAL_MS) {
            lastProgressTime = now;
            const elapsedMs = now - firstTokenTime;
            yield {
              type: "progress",
              tokens: totalEstimatedTokens,
              speed: computeSpeed(totalEstimatedTokens, firstTokenTime),
              elapsedMs,
              estimatedTokens: totalEstimatedTokens,
              reasoning: estimatedReasoningTokens,
            };
          }
        }

        // Reasoning content streaming (DeepSeek thinking mode)
        if (delta?.reasoning_content) {
          if (firstTokenTime === null) {
            firstTokenTime = Date.now();
          }
          fullReasoningContent += delta.reasoning_content;
          reasoningTokens++;
          yield { type: "content", reasoningDelta: delta.reasoning_content, count: fullContent.length };

          const estimatedContentTokens = Math.round(fullContent.length / CHARS_PER_TOKEN);
          const estimatedReasoningTokens = Math.round(fullReasoningContent.length / CHARS_PER_TOKEN);
          const totalEstimatedTokens = Math.max(1, estimatedContentTokens + estimatedReasoningTokens);
          const now = Date.now();
          if (lastProgressTime === null || now - lastProgressTime >= MIN_PROGRESS_INTERVAL_MS) {
            lastProgressTime = now;
            const elapsedMs = now - firstTokenTime;
            yield {
              type: "progress",
              tokens: totalEstimatedTokens,
              speed: computeSpeed(totalEstimatedTokens, firstTokenTime),
              elapsedMs,
              estimatedTokens: totalEstimatedTokens,
              reasoning: estimatedReasoningTokens,
            };
          }
        }

        // Tool calls — accumulate across chunks (API streams pieces)
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: "",
                type: "function",
                function: { name: "", arguments: "" },
              };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }

        // Finish reason — emit appropriate event
        if (choice?.finish_reason) {
          const validCalls = toolCalls.filter((tc) => tc.id);
          // Emit tool_calls FIRST so worker can write to temp file
          // before content_done triggers FIFO read in handler. This
          // prevents a race where handler spin-loops on empty FIFO
          // reads while tool_calls file is not yet populated.
          if (validCalls.length > 0) {
            yield { type: "tool_calls", calls: validCalls, count: tokenCount };
          }
          if (fullContent || fullReasoningContent) {
            yield {
              type: "content_done",
              content: fullContent || undefined,
              reasoning_content: fullReasoningContent || null,
              count: tokenCount,
            };
          }
        }
      } catch {
        // Skip parse errors on partial/incomplete chunks
      }
    }
  }

  yield {
    type: "done",
    usage: { total_tokens: tokenCount, completion_tokens: completionTokens, reasoning_tokens: apiReasoningTokens ?? reasoningTokens },
  };
}
