import type { Config } from "./types.ts";

const DEFAULTS: Partial<Config> = {
  AGENT_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode",
  AGENT_MODEL: "qwen-max",
  AGENT_EXEC_DELAY: 2,
  AGENT_OUTPUT_MAX_LENGTH: 10000,
  AGENT_DEBUG: false,
  AGENT_EXEC_TIMEOUT: 0,
  AGENT_REASONING_EFFORT: "high",
  AGENT_API_TTFT_TIMEOUT: 120,
};

/**
 * Loads configuration from environment variables and .env file.
 * Uses Bun's built-in .env loading (Bun automatically reads .env at startup).
 *
 * Priority: Shell environment variables override .env file values.
 * Defaults are applied for any missing optional fields.
 *
 * @throws {Error} If AGENT_API_KEY is not set
 * @returns {Config} Typed configuration object
 */
export function loadConfig(): Config {
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "AGENT_API_KEY is required. Set it in .env file or as an environment variable."
    );
  }

  return {
    AGENT_API_KEY: apiKey,
    AGENT_BASE_URL: process.env.AGENT_BASE_URL || DEFAULTS.AGENT_BASE_URL!,
    AGENT_MODEL: process.env.AGENT_MODEL || DEFAULTS.AGENT_MODEL!,
    AGENT_EXEC_DELAY: parseEnvInt(
      process.env.AGENT_EXEC_DELAY,
      DEFAULTS.AGENT_EXEC_DELAY!
    ),
    AGENT_OUTPUT_MAX_LENGTH: parseEnvInt(
      process.env.AGENT_OUTPUT_MAX_LENGTH,
      DEFAULTS.AGENT_OUTPUT_MAX_LENGTH!
    ),
    AGENT_DEBUG: parseEnvBool(process.env.AGENT_DEBUG, DEFAULTS.AGENT_DEBUG!),
    AGENT_EXEC_TIMEOUT: parseEnvInt(
      process.env.AGENT_EXEC_TIMEOUT,
      DEFAULTS.AGENT_EXEC_TIMEOUT!
    ),
    AGENT_REASONING_EFFORT: process.env.AGENT_REASONING_EFFORT || DEFAULTS.AGENT_REASONING_EFFORT!,
    AGENT_API_TTFT_TIMEOUT: parseEnvInt(
      process.env.AGENT_API_TTFT_TIMEOUT,
      DEFAULTS.AGENT_API_TTFT_TIMEOUT!
    ),
  };
}

/**
 * Parses an environment variable as an integer, falling back to a default.
 */
function parseEnvInt(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === "") return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parses an environment variable as a boolean, falling back to a default.
 */
function parseEnvBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value === "true" || value === "1";
}

export { DEFAULTS };
