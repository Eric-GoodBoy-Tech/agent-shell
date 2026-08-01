import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { resetEnv, setTestEnv } from "./setup.ts";

// Reconstruct DEFAULTS from source (avoid importing non-exported const)
// Source values from src/config.ts lines 3-12:
const DEFAULTS = {
  AGENT_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode",
  AGENT_MODEL: "qwen-max",
  AGENT_EXEC_DELAY: 2,
  AGENT_OUTPUT_MAX_LENGTH: 10000,
  AGENT_DEBUG: false,
  AGENT_EXEC_TIMEOUT: 0,
  AGENT_REASONING_EFFORT: "high",
  AGENT_API_TTFT_TIMEOUT: 120,
};

describe("loadConfig", () => {
  beforeEach(() => {
    resetEnv();
    // Strip all AGENT_* vars so user's local .env does not leak in
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_")) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    resetEnv();
    // Strip again so restored originals don't pollute the next describe
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_")) {
        delete process.env[key];
      }
    }
  });
  // ── Error cases ──────────────────────────────────────────────

  it("throws when AGENT_API_KEY is not set", () => {
    expect(() => loadConfig()).toThrow("AGENT_API_KEY is required");
  });

  it("throws when AGENT_API_KEY is empty string", () => {
    setTestEnv({ AGENT_API_KEY: "" });
    expect(() => loadConfig()).toThrow("AGENT_API_KEY is required");
  });

  it('throws when AGENT_API_KEY is whitespace only ("   ")', () => {
    setTestEnv({ AGENT_API_KEY: "   " });
    expect(() => loadConfig()).toThrow("AGENT_API_KEY is required");
  });

  // ── Happy path: valid key returns all defaults ────────────────

  it("returns DEFAULTS for all optional fields when only API key is set", () => {
    setTestEnv({ AGENT_API_KEY: "test-key" });
    const config = loadConfig();

    expect(config.AGENT_API_KEY).toBe("test-key");
    expect(config.AGENT_BASE_URL).toBe(DEFAULTS.AGENT_BASE_URL);
    expect(config.AGENT_MODEL).toBe(DEFAULTS.AGENT_MODEL);
    expect(config.AGENT_EXEC_DELAY).toBe(DEFAULTS.AGENT_EXEC_DELAY);
    expect(config.AGENT_OUTPUT_MAX_LENGTH).toBe(DEFAULTS.AGENT_OUTPUT_MAX_LENGTH);
    expect(config.AGENT_DEBUG).toBe(DEFAULTS.AGENT_DEBUG);
    expect(config.AGENT_EXEC_TIMEOUT).toBe(DEFAULTS.AGENT_EXEC_TIMEOUT);
    expect(config.AGENT_REASONING_EFFORT).toBe(DEFAULTS.AGENT_REASONING_EFFORT);
    expect(config.AGENT_API_TTFT_TIMEOUT).toBe(DEFAULTS.AGENT_API_TTFT_TIMEOUT);
  });

  // ── Custom string fields ──────────────────────────────────────

  it("reflects custom AGENT_BASE_URL", () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_BASE_URL: "https://custom.api/v1" });
    expect(loadConfig().AGENT_BASE_URL).toBe("https://custom.api/v1");
  });

  it("reflects custom AGENT_MODEL", () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_MODEL: "gpt-4" });
    expect(loadConfig().AGENT_MODEL).toBe("gpt-4");
  });

  it("reflects custom AGENT_REASONING_EFFORT", () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_REASONING_EFFORT: "max" });
    expect(loadConfig().AGENT_REASONING_EFFORT).toBe("max");
  });

  // ── Integer fields ────────────────────────────────────────────

  it('parses AGENT_EXEC_DELAY="5" as integer 5', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_EXEC_DELAY: "5" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(5);
  });

  it('parses AGENT_API_TTFT_TIMEOUT="60" as integer 60', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_API_TTFT_TIMEOUT: "60" });
    expect(loadConfig().AGENT_API_TTFT_TIMEOUT).toBe(60);
  });

  it("parses AGENT_OUTPUT_MAX_LENGTH from env", () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_OUTPUT_MAX_LENGTH: "500" });
    expect(loadConfig().AGENT_OUTPUT_MAX_LENGTH).toBe(500);
  });

  it("parses AGENT_EXEC_TIMEOUT from env", () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_EXEC_TIMEOUT: "30" });
    expect(loadConfig().AGENT_EXEC_TIMEOUT).toBe(30);
  });

  // ── Boolean fields ────────────────────────────────────────────

  it('parses AGENT_DEBUG="true" as true', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_DEBUG: "true" });
    expect(loadConfig().AGENT_DEBUG).toBe(true);
  });

  it('parses AGENT_DEBUG="1" as true', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_DEBUG: "1" });
    expect(loadConfig().AGENT_DEBUG).toBe(true);
  });

  it('parses AGENT_DEBUG="false" as false', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_DEBUG: "false" });
    expect(loadConfig().AGENT_DEBUG).toBe(false);
  });
});

// ── parseEnvBool (private; exercised via loadConfig + AGENT_DEBUG) ──

describe("parseEnvBool (via AGENT_DEBUG)", () => {
  beforeEach(() => {
    resetEnv();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_")) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    resetEnv();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_")) {
        delete process.env[key];
      }
    }
  });
  it('returns true for "true"', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_DEBUG: "true" });
    expect(loadConfig().AGENT_DEBUG).toBe(true);
  });

  it('returns true for "1"', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_DEBUG: "1" });
    expect(loadConfig().AGENT_DEBUG).toBe(true);
  });

  it('returns false for "TRUE" (case-sensitive matching)', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_DEBUG: "TRUE" });
    expect(loadConfig().AGENT_DEBUG).toBe(false);
  });

  it('returns false for "0"', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_DEBUG: "0" });
    expect(loadConfig().AGENT_DEBUG).toBe(false);
  });

  it('returns false for "false"', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_DEBUG: "false" });
    expect(loadConfig().AGENT_DEBUG).toBe(false);
  });

  it("returns defaultValue when env var is empty string", () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_DEBUG: "" });
    expect(loadConfig().AGENT_DEBUG).toBe(DEFAULTS.AGENT_DEBUG);
  });

  it("returns defaultValue when env var is not set", () => {
    setTestEnv({ AGENT_API_KEY: "key" });
    // AGENT_DEBUG is not in env — falls back to default
    expect(loadConfig().AGENT_DEBUG).toBe(DEFAULTS.AGENT_DEBUG);
  });

  it('returns false for "yes" (not a recognized truthy value)', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_DEBUG: "yes" });
    expect(loadConfig().AGENT_DEBUG).toBe(false);
  });
});

// ── parseEnvInt (private; exercised via loadConfig + AGENT_EXEC_DELAY) ──

describe("parseEnvInt (via AGENT_EXEC_DELAY)", () => {
  beforeEach(() => {
    resetEnv();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_")) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    resetEnv();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_")) {
        delete process.env[key];
      }
    }
  });
  it('returns 42 for "42"', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_EXEC_DELAY: "42" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(42);
  });

  it('returns -1 for "-1"', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_EXEC_DELAY: "-1" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(-1);
  });

  it('returns 0 for "0"', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_EXEC_DELAY: "0" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(0);
  });

  it('returns 3 for "3.14" (parseInt drops decimal)', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_EXEC_DELAY: "3.14" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(3);
  });

  it("returns defaultValue when env var is empty string", () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_EXEC_DELAY: "" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(DEFAULTS.AGENT_EXEC_DELAY);
  });

  it("returns defaultValue when env var is not set", () => {
    setTestEnv({ AGENT_API_KEY: "key" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(DEFAULTS.AGENT_EXEC_DELAY);
  });

  it('returns defaultValue for non-numeric string "abc" (NaN → default)', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_EXEC_DELAY: "abc" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(DEFAULTS.AGENT_EXEC_DELAY);
  });

  it('returns 5 for "  5  " (parseInt trims whitespace)', () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_EXEC_DELAY: "  5  " });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(5);
  });
});
