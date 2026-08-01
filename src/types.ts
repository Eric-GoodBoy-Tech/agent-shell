/**
 * Type definitions for Agent Shell.
 *
 * Node model: a node is a directory under nodes/<id>/
 * with `context` (system prompt) and/or `plug` (shell script) files,
 * plus a `parent` link. At least one of context or plug must exist.

/**
 * Represents an OpenAI-compatible function tool call.
 */
export interface ToolCall {
  /** Unique identifier for this tool call */
  id: string;
  /** Function invocation details */
  function: {
    /** Name of the function to call */
    name: string;
    /** JSON-encoded arguments string */
    arguments: string;
  };
}

/**
 * Represents a chat message in the OpenAI-compatible format.
 * Unified type used across API calls, context building, and history storage.
 */
export interface Message {
  role: string;
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /**
   * DeepSeek thinking mode: reasoning chain content.
   * MUST be passed back to the API in all subsequent requests
   * when this message has tool_calls (API returns 400 otherwise).
   * Non-tool-call messages: reasoning_content is optional (API ignores it).
   */
  reasoning_content?: string | null;
}

/**
 * Options for the agsh call command.
 */
export interface CallOptions {
  /** Array of OpenAI-compatible message objects */
  messages: Message[];
  /** Whether to use streaming mode */
  stream?: boolean;
}

/**
 * Result of the agsh call command.
 */
export interface CallResult {
  /** The assistant message from the API response */
  message: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
    /** DeepSeek thinking mode: reasoning chain from the assistant */
    reasoning_content?: string | null;
  };
  /** Exit code (0 = success, non-zero = error) */
  exitCode: number;
  /** Diagnostic error message (populated on failure) */
  error?: string;
  /** Token usage from the API response (if available) */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    reasoning_tokens?: number;
    total_tokens: number;
  };
}

/**
 * Typed configuration interface for all environment variables.
 */
export interface Config {
  /** Required: API key for the LLM provider */
  AGENT_API_KEY: string;
  /** Base URL of the LLM API endpoint */
  AGENT_BASE_URL: string;
  /** Model name to use */
  AGENT_MODEL: string;
  /** Delay in seconds before auto-executing displayed commands */
  AGENT_EXEC_DELAY: number;
  /** Maximum length of command output before truncation */
  AGENT_OUTPUT_MAX_LENGTH: number;
  /** Enable debug logging */
  AGENT_DEBUG: boolean;
  /** DeepSeek reasoning effort: "high" or "max". Defaults to "high". */
  AGENT_REASONING_EFFORT: string;
  /** Timeout in seconds for cancelling captured command execution (0=disabled) */
  AGENT_EXEC_TIMEOUT: number;
  /** First-token timeout in seconds for streaming API calls (0=disabled) */
  AGENT_API_TTFT_TIMEOUT: number;
}

/**
 * SSE streaming event emitted by callApiStream().
 * Each event has a `type` discriminator and type-specific fields.
 */
export interface StreamEvent {
  /** Event type discriminator */
  type: "token" | "content" | "content_done" | "tool_calls" | "done" | "error" | "progress";
  /** Accumulated token count (present on most events) */
  count?: number;
  /** Completion/reasoning token count from usage */
  completionTokens?: number;
  /** Content delta chunk (content event) */
  delta?: string;
  /** DeepSeek reasoning delta chunk (streaming) */
  reasoningDelta?: string;
  /** Full accumulated content (content_done event) */
  content?: string;
  /** Full accumulated reasoning content (content_done / done event) */
  reasoning_content?: string | null;
  /** Accumulated tool calls (tool_calls event) */
  calls?: ToolCall[];
  /** Final usage stats (done event) */
  usage?: { total_tokens: number; completion_tokens: number; reasoning_tokens?: number };
  /** Error message (error event) */
  message?: string;
  /** Estimated token count (progress event) */
  estimatedTokens?: number;
  /** Elapsed milliseconds since first content/reasoning delta (progress event) */
  elapsedMs?: number;
  /** Reasoning token estimate (progress/token event) */
  reasoning?: number;
  /** Pre-calculated total tokens for progress/token events */
  tokens?: number;
  /** Pre-calculated tokens per second for progress/token events */
  speed?: number;
}
