import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, DEFAULTS } from "../src/config.ts";
import { resetEnv, setTestEnv } from "./setup.ts";

// The three vars with no default: which endpoint/model/key to use is the
// user's choice, so loadConfig() throws when they are unset.
const REQUIRED = {
  AGENT_API_KEY: "test-key",
  AGENT_BASE_URL: "https://example.invalid",
  AGENT_MODEL: "test-model",
};

function setRequired(extra: Record<string, string> = {}): void {
  setTestEnv({ ...REQUIRED, ...extra });
}

function stripAgentEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("AGENT_")) {
      delete process.env[key];
    }
  }
}

describe("loadConfig", () => {
  beforeEach(() => {
    resetEnv();
    // Strip all AGENT_* vars so user's local .env does not leak in
    stripAgentEnv();
  });

  afterEach(() => {
    resetEnv();
    // Strip again so restored originals don't pollute the next describe
    stripAgentEnv();
  });
  // ── Error cases ──────────────────────────────────────────────

  it("throws when AGENT_API_KEY is not set", () => {
    setTestEnv({ AGENT_BASE_URL: "https://x", AGENT_MODEL: "m" });
    expect(() => loadConfig()).toThrow("AGENT_API_KEY is required");
  });

  it("throws when AGENT_API_KEY is empty string", () => {
    setRequired({ AGENT_API_KEY: "" });
    expect(() => loadConfig()).toThrow("AGENT_API_KEY is required");
  });

  it('throws when AGENT_API_KEY is whitespace only ("   ")', () => {
    setRequired({ AGENT_API_KEY: "   " });
    expect(() => loadConfig()).toThrow("AGENT_API_KEY is required");
  });

  // ── Required endpoint/model: no vendor default ────────────────

  it("throws when AGENT_BASE_URL is not set (no built-in provider default)", () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_MODEL: "m" });
    expect(() => loadConfig()).toThrow("AGENT_BASE_URL is required");
  });

  it("throws when AGENT_BASE_URL is empty string", () => {
    setRequired({ AGENT_BASE_URL: "" });
    expect(() => loadConfig()).toThrow("AGENT_BASE_URL is required");
  });

  it("throws when AGENT_MODEL is not set (no built-in model default)", () => {
    setTestEnv({ AGENT_API_KEY: "key", AGENT_BASE_URL: "https://x" });
    expect(() => loadConfig()).toThrow("AGENT_MODEL is required");
  });

  it("throws when AGENT_MODEL is empty string", () => {
    setRequired({ AGENT_MODEL: "" });
    expect(() => loadConfig()).toThrow("AGENT_MODEL is required");
  });

  it("error messages point at .env / environment", () => {
    setTestEnv({});
    expect(() => loadConfig()).toThrow(
      "AGENT_API_KEY is required. Set it in .env file or as an environment variable."
    );
  });

  // ── Happy path: only the two TS-owned defaults exist ──────────

  it("returns DEFAULTS for the TS-owned fields when only the required vars are set", () => {
    setRequired();
    const config = loadConfig();

    expect(config.AGENT_API_KEY).toBe("test-key");
    expect(config.AGENT_BASE_URL).toBe("https://example.invalid");
    expect(config.AGENT_MODEL).toBe("test-model");
    expect(config.AGENT_REASONING_EFFORT).toBe(DEFAULTS.AGENT_REASONING_EFFORT);
    expect(config.AGENT_API_TTFT_TIMEOUT).toBe(DEFAULTS.AGENT_API_TTFT_TIMEOUT);
  });

  it("leaves shell-owned knobs undefined when the environment does not carry them", () => {
    setRequired();
    const config = loadConfig();

    // agent.zsh Layer 2 owns these defaults (and exports them); TS carries none.
    expect(config.AGENT_EXEC_DELAY).toBeUndefined();
    expect(config.AGENT_OUTPUT_MAX_LENGTH).toBeUndefined();
    expect(config.AGENT_DEBUG).toBeUndefined();
    expect(config.AGENT_EXEC_TIMEOUT).toBeUndefined();
  });

  it("passes shell-exported knobs through unchanged", () => {
    setRequired({
      AGENT_EXEC_DELAY: "7",
      AGENT_OUTPUT_MAX_LENGTH: "123",
      AGENT_DEBUG: "true",
      AGENT_EXEC_TIMEOUT: "45",
    });
    const config = loadConfig();

    expect(config.AGENT_EXEC_DELAY).toBe(7);
    expect(config.AGENT_OUTPUT_MAX_LENGTH).toBe(123);
    expect(config.AGENT_DEBUG).toBe(true);
    expect(config.AGENT_EXEC_TIMEOUT).toBe(45);
  });

  // ── Custom string fields ──────────────────────────────────────

  it("reflects custom AGENT_BASE_URL", () => {
    setRequired({ AGENT_BASE_URL: "https://custom.api/v1" });
    expect(loadConfig().AGENT_BASE_URL).toBe("https://custom.api/v1");
  });

  it("reflects custom AGENT_MODEL", () => {
    setRequired({ AGENT_MODEL: "gpt-4" });
    expect(loadConfig().AGENT_MODEL).toBe("gpt-4");
  });

  it("reflects custom AGENT_REASONING_EFFORT", () => {
    setRequired({ AGENT_REASONING_EFFORT: "max" });
    expect(loadConfig().AGENT_REASONING_EFFORT).toBe("max");
  });

  // ── Integer fields ────────────────────────────────────────────

  it('parses AGENT_EXEC_DELAY="5" as integer 5', () => {
    setRequired({ AGENT_EXEC_DELAY: "5" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(5);
  });

  it('parses AGENT_API_TTFT_TIMEOUT="60" as integer 60', () => {
    setRequired({ AGENT_API_TTFT_TIMEOUT: "60" });
    expect(loadConfig().AGENT_API_TTFT_TIMEOUT).toBe(60);
  });

  it("parses AGENT_OUTPUT_MAX_LENGTH from env", () => {
    setRequired({ AGENT_OUTPUT_MAX_LENGTH: "500" });
    expect(loadConfig().AGENT_OUTPUT_MAX_LENGTH).toBe(500);
  });

  it("parses AGENT_EXEC_TIMEOUT from env", () => {
    setRequired({ AGENT_EXEC_TIMEOUT: "30" });
    expect(loadConfig().AGENT_EXEC_TIMEOUT).toBe(30);
  });

  // ── Boolean fields ────────────────────────────────────────────

  it('parses AGENT_DEBUG="true" as true', () => {
    setRequired({ AGENT_DEBUG: "true" });
    expect(loadConfig().AGENT_DEBUG).toBe(true);
  });

  it('parses AGENT_DEBUG="1" as true', () => {
    setRequired({ AGENT_DEBUG: "1" });
    expect(loadConfig().AGENT_DEBUG).toBe(true);
  });

  it('parses AGENT_DEBUG="false" as false', () => {
    setRequired({ AGENT_DEBUG: "false" });
    expect(loadConfig().AGENT_DEBUG).toBe(false);
  });
});

// ── parseEnvBool (private; exercised via loadConfig + AGENT_DEBUG) ──

describe("parseEnvBool (via AGENT_DEBUG)", () => {
  beforeEach(() => {
    resetEnv();
    stripAgentEnv();
  });

  afterEach(() => {
    resetEnv();
    stripAgentEnv();
  });
  it('returns true for "true"', () => {
    setRequired({ AGENT_DEBUG: "true" });
    expect(loadConfig().AGENT_DEBUG).toBe(true);
  });

  it('returns true for "1"', () => {
    setRequired({ AGENT_DEBUG: "1" });
    expect(loadConfig().AGENT_DEBUG).toBe(true);
  });

  it('returns false for "TRUE" (case-sensitive matching)', () => {
    setRequired({ AGENT_DEBUG: "TRUE" });
    expect(loadConfig().AGENT_DEBUG).toBe(false);
  });

  it('returns false for "0"', () => {
    setRequired({ AGENT_DEBUG: "0" });
    expect(loadConfig().AGENT_DEBUG).toBe(false);
  });

  it('returns false for "false"', () => {
    setRequired({ AGENT_DEBUG: "false" });
    expect(loadConfig().AGENT_DEBUG).toBe(false);
  });

  it("returns undefined when env var is empty string (no TS default)", () => {
    setRequired({ AGENT_DEBUG: "" });
    expect(loadConfig().AGENT_DEBUG).toBeUndefined();
  });

  it("returns undefined when env var is not set (no TS default)", () => {
    setRequired();
    expect(loadConfig().AGENT_DEBUG).toBeUndefined();
  });

  it('returns false for "yes" (not a recognized truthy value)', () => {
    setRequired({ AGENT_DEBUG: "yes" });
    expect(loadConfig().AGENT_DEBUG).toBe(false);
  });
});

// ── parseEnvInt (private; exercised via loadConfig + AGENT_EXEC_DELAY) ──

describe("parseEnvInt (via AGENT_EXEC_DELAY)", () => {
  beforeEach(() => {
    resetEnv();
    stripAgentEnv();
  });

  afterEach(() => {
    resetEnv();
    stripAgentEnv();
  });
  it('returns 42 for "42"', () => {
    setRequired({ AGENT_EXEC_DELAY: "42" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(42);
  });

  it('returns -1 for "-1"', () => {
    setRequired({ AGENT_EXEC_DELAY: "-1" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(-1);
  });

  it('returns 0 for "0"', () => {
    setRequired({ AGENT_EXEC_DELAY: "0" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(0);
  });

  it('returns 3 for "3.14" (parseInt drops decimal)', () => {
    setRequired({ AGENT_EXEC_DELAY: "3.14" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(3);
  });

  it("returns undefined when env var is empty string (no TS default)", () => {
    setRequired({ AGENT_EXEC_DELAY: "" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBeUndefined();
  });

  it("returns undefined when env var is not set (no TS default)", () => {
    setRequired();
    expect(loadConfig().AGENT_EXEC_DELAY).toBeUndefined();
  });

  it('returns undefined for non-numeric string "abc" (NaN → undefined)', () => {
    setRequired({ AGENT_EXEC_DELAY: "abc" });
    expect(loadConfig().AGENT_EXEC_DELAY).toBeUndefined();
  });

  it('returns 5 for "  5  " (parseInt trims whitespace)', () => {
    setRequired({ AGENT_EXEC_DELAY: "  5  " });
    expect(loadConfig().AGENT_EXEC_DELAY).toBe(5);
  });
});
