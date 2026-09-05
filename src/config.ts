import type { Config } from "./types.ts";

/**
 * Defaults for the two knobs the TS layer owns.
 *
 * Everything else is owned by the shell, not by TS:
 *   - AGENT_EXEC_DELAY / AGENT_OUTPUT_MAX_LENGTH / AGENT_DEBUG / AGENT_POLL_INTERVAL
 *     / AGENT_NODES_PATH are set (and exported) by agent.zsh Layer 2, so the CLI
 *     receives them from the environment — TS keeps no second copy of those
 *     defaults (single source of truth).
 *   - AGENT_BASE_URL / AGENT_MODEL have no default either: which provider and
 *     model to talk to is the user's choice. They are validated in loadConfig()
 *     (i.e. before any API call); non-API commands never call loadConfig().
 */
const DEFAULTS: Pick<Config, "AGENT_REASONING_EFFORT" | "AGENT_API_TTFT_TIMEOUT"> = {
  AGENT_REASONING_EFFORT: "high",
  AGENT_API_TTFT_TIMEOUT: 120,
};

/**
 * Loads configuration from environment variables and .env file.
 * Uses Bun's built-in .env loading (Bun automatically reads .env at startup).
 *
 * Priority: Shell environment variables override .env file values.
 * Defaults are applied for the two optional fields the TS layer owns; every
 * other field is passed through from the environment as-is (absent = undefined).
 */
export function loadConfig(): Config {
  return {
    AGENT_API_KEY: requireEnv("AGENT_API_KEY"),
    AGENT_BASE_URL: requireEnv("AGENT_BASE_URL"),
    AGENT_MODEL: requireEnv("AGENT_MODEL"),
    AGENT_EXEC_DELAY: parseEnvInt(process.env.AGENT_EXEC_DELAY),
    AGENT_OUTPUT_MAX_LENGTH: parseEnvInt(process.env.AGENT_OUTPUT_MAX_LENGTH),
    AGENT_DEBUG: parseEnvBool(process.env.AGENT_DEBUG),
    AGENT_EXEC_TIMEOUT: parseEnvInt(process.env.AGENT_EXEC_TIMEOUT),
    AGENT_REASONING_EFFORT:
      process.env.AGENT_REASONING_EFFORT || DEFAULTS.AGENT_REASONING_EFFORT!,
    AGENT_API_TTFT_TIMEOUT:
      parseEnvInt(process.env.AGENT_API_TTFT_TIMEOUT) ??
      DEFAULTS.AGENT_API_TTFT_TIMEOUT!,
  };
}

/** Read a required env var; unset/empty/whitespace-only yields an actionable error. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `${name} is required. Set it in .env file or as an environment variable.`
    );
  }
  return value;
}

/** Parse an env var as an integer; unset/empty/non-numeric → undefined (no default). */

function parseEnvInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? undefined : parsed;
}

/** Parse an env var as a boolean: only the exact strings "true"/"1" count as true, any other non-empty value is false; unset/empty → undefined. */

function parseEnvBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value === "true" || value === "1";
}

export { DEFAULTS };
