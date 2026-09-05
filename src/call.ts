import { loadConfig } from "./config.ts";
import type { CallOptions, CallResult, StreamEvent, ToolCall, Message, Config } from "./types.ts";

/**
 * The ONLY tool the model can use.
 */
export const SHELL_TOOL = {
  type: "function" as const,
  function: {
    name: "shell",
    description:
      "A tool that runs a shell command in a persistent interactive zsh terminal, preserving the working directory, exported variables, and file writes across calls. Remember: state accumulates in the same terminal process across calls, so do not re-run cd or export already performed in an earlier call unless you intend to change them; the tool result carries the command's exit code with its output, and very long output may be truncated.",
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
 * On HTTP errors or API errors, returns non-zero exitCode (not thrown).
 */
export async function callApi(
  options: CallOptions,
  config: Config = loadConfig()
): Promise<CallResult> {
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
 * Reads the SSE response body line-by-line and yields typed StreamEvent objects;
 * failures are surfaced as error events. Tool call arguments are accumulated
 * across chunks since the API streams them in fragments (name first, then
 * arguments piece by piece).
 */
export async function* callApiStream(
  messages: Message[],
  apiKey: string,
  baseUrl: string,
  model: string,
  reasoningEffort: string,
  config: Config = loadConfig()
): AsyncGenerator<StreamEvent> {
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
  let lastUsage: { total_tokens: number; completion_tokens: number; reasoning_tokens?: number } | null = null;

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

        // Usage arrives at stream end (stream_options.include_usage); keep the raw chunk for the done event.
        if (usage?.total_tokens) {
          lastUsage = {
            total_tokens: usage.total_tokens,
            completion_tokens: usage.completion_tokens || 0,
            reasoning_tokens: usage.reasoning_tokens,
          };
        }

        if (delta?.content) {
          fullContent += delta.content;
          yield { type: "content", delta: delta.content, count: fullContent.length };
        }

        // Reasoning content streaming (DeepSeek thinking mode)
        if (delta?.reasoning_content) {
          fullReasoningContent += delta.reasoning_content;
          yield { type: "content", reasoningDelta: delta.reasoning_content, count: fullContent.length };
        }

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

        if (choice?.finish_reason) {
          const validCalls = toolCalls.filter((tc) => tc.id);
          // Emit tool_calls FIRST so worker can write to temp file
          // before content_done triggers FIFO read in handler. This
          // prevents a race where handler spin-loops on empty FIFO
          // reads while tool_calls file is not yet populated.
          if (validCalls.length > 0) {
            yield { type: "tool_calls", calls: validCalls };
          }
          if (fullContent || fullReasoningContent) {
            yield {
              type: "content_done",
              content: fullContent || undefined,
              reasoning_content: fullReasoningContent || null,
            };
          }
        }
      } catch {
        // Tolerate malformed data lines
      }
    }
  }

  yield {
    type: "done",
    usage: lastUsage ?? undefined,
  };
}
