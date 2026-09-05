/**
 * Type definitions for Agent Shell.
 *
 * Node model: a node is a directory under .agsh/nodes/<id>/ (relocatable via $AGENT_NODES_PATH)
 * with `context` (system prompt) and/or `plug` (shell script) files,
 * plus a `parent` link. At least one of context or plug must exist.
 */

export interface ToolCall {
  id: string;
  function: {
    name: string;
    /** JSON-encoded arguments string */
    arguments: string;
  };
}

/**
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

export interface CallOptions {
  messages: Message[];
  stream?: boolean;
}

export interface CallResult {
  message: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
    reasoning_content?: string | null;
  };
  /** Bridges CLI process.exit semantics: 0 = success, non-zero = error */
  exitCode: number;
  error?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    reasoning_tokens?: number;
    total_tokens: number;
  };
}

/**
 * AGENT_* environment variables as typed config fields.
 */
export interface Config {
  /** Required — loadConfig() throws when unset */
  AGENT_API_KEY: string;
  /** Required — loadConfig() throws when unset (no default provider) */
  AGENT_BASE_URL: string;
  /** Required — loadConfig() throws when unset (no default model) */
  AGENT_MODEL: string;
  /**
   * Seconds agent.zsh waits before auto-executing displayed commands.
   * Owned by agent.zsh Layer 2 (exported to the CLI); undefined outside an
   * agent shell. The TS layer keeps no default for this knob.
   */
  AGENT_EXEC_DELAY?: number;
  /** Command output longer than this is truncated. Owned by agent.zsh Layer 2. */
  AGENT_OUTPUT_MAX_LENGTH?: number;
  /** Debug logging. Owned by agent.zsh Layer 2. */
  AGENT_DEBUG?: boolean;
  /** DeepSeek reasoning effort: "high" or "max". Defaults to "high". */
  AGENT_REASONING_EFFORT: string;
  /**
   * Timeout in seconds for cancelling captured command execution (0=disabled).
   * Owned by agent.zsh (Layer 2 / .env); undefined outside an agent shell.
   */
  AGENT_EXEC_TIMEOUT?: number;
  /** First-token timeout in seconds for streaming API calls (0=disabled) */
  AGENT_API_TTFT_TIMEOUT: number;
}

/**
 * SSE streaming event vocabulary.
 * Each event has a `type` discriminator and type-specific fields.
 */
export interface StreamEvent {
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

// ─────────────────────────────────────────────────────────────────────────────
// agsh capability domains — each is typed below; aggregation design: see the AgshApi JSDoc.
// ─────────────────────────────────────────────────────────────────────────────

/** api domain: one whole API request — the capability unit is the request layer; internal helpers are not exposed */
export interface ApiDomain {
  call(options: CallOptions): Promise<CallResult>;
  stream(
    messages: Message[],
    apiKey: string,
    baseUrl: string,
    model: string,
    reasoningEffort: string
  ): AsyncGenerator<StreamEvent>;
}

/** context domain: prefix-chain + history assembly and appends */
export interface ContextDomain {
  build(credential: string, nodesPath: string): Promise<Message[]>;
  detectPending(credential: string, nodesPath: string): ToolCall | null;
  saveDelta(
    credential: string,
    nodesPath: string,
    contextFilePath: string,
    fromIndex: number,
    dumpDir?: string
  ): { saved: number; total: number };
  appendContext(context: Message[], role: string, message: string): Message[];
  appendToolResult(context: Message[], toolCallId: string, content: string): Message[];
}

/** node domain: node-tree creation */
export interface NodeDomain {
  create(options: {
    nodesPath: string;
    parent: string;
    context?: string;
    plug?: string;
    id: string;
  }): Promise<{ success: boolean; id?: string; error?: string }>;
}

/** credential domain: 5-layer validation */
export interface CredentialDomain {
  validate(id: string, nodesPath: string): { valid: boolean; error?: string };
}

/** init domain: root-node initialization */
export interface InitDomain {
  /**
   * Root-node system protocol text (English-only, never localized).
   * Existing root/context files are creation-time snapshots and are never
   * rewritten by init.
   */
  protocol: string;
  init(nodesPath?: string): Promise<{ success: boolean; message: string }>;
}

/** prefix domain: chain traversal and formatting */
export interface PrefixDomain {
  chain(
    nodesPath: string,
    credential: string,
    mode?: "content" | "paths"
  ): Array<{ id: string; content: string; type: string }>;
  formatOutput(nodes: Array<{ id: string; content: string; type: string }>): string[];
  formatPaths(
    nodesPath: string,
    nodes: Array<{ id: string; content: string; type: string }>
  ): string[];
}

/** config domain: environment-config loading */
export interface ConfigDomain {
  load(): Config;
}

/**
 * agsh — the single object exposing the whole TS capability layer to plugins
 * and the CLI layer.
 *
 * The defaults are the core pure functions (call.ts / context.ts); external
 * dependencies (config loading, prefix-chain traversal) are passed in as
 * parameters. When a parameter is omitted the core function loads its own
 * default (config: Config = loadConfig(), chain = prefixChain), so calling
 * the core functions directly stays self-contained.
 *
 * The agsh.ts assembly wraps each entry point thinly: every call reads the
 * current property (e.g. agsh.config.load, agsh.prefix.chain) and injects the
 * result into the core function. The core never discovers plugins: agsh.ts
 * imports none.
 *
 * Calling convention: entry points must access properties on the object
 * (agsh.api.call(...)); destructuring (`const { call } = agsh.api`) pins the
 * current binding and would defeat late overrides.
 */
export interface AgshApi {
  api: ApiDomain;
  context: ContextDomain;
  node: NodeDomain;
  credential: CredentialDomain;
  init: InitDomain;
  prefix: PrefixDomain;
  config: ConfigDomain;
}
