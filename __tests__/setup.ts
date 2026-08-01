/**
 * Test setup file for bun test.
 * Provides common test utilities and mock helpers.
 */

import { afterEach, beforeEach, mock } from "bun:test";

/**
 * Save original environment to restore after tests.
 */
const originalEnv = { ...process.env };

/**
 * Reset environment variables to a clean state before each test.
 * Call this in beforeEach when testing config or env-dependent code.
 */
export function resetEnv(): void {
  // Restore to original state
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value !== undefined) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

/**
 * Set test environment variables.
 */
export function setTestEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Create a temporary directory for test filesystem operations.
 * Returns the path and a cleanup function.
 */
export function createTempDir(prefix = "agsh-test-"): string {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

/**
 * Clean up a temporary directory recursively.
 */
export function removeTempDir(dir: string): void {
  const fs = require("fs");
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
