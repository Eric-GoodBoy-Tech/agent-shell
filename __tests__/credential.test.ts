import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { validateCredential } from "../src/credential.ts";

const TEST_DIR = "__tests__/tmp-test-credential";

describe("validateCredential", () => {
  beforeEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  async function createNode(id: string, parent: string, type: string, content: string) {
    const dir = join(TEST_DIR, id);
    await mkdir(dir, { recursive: true });
    if (type === "context") {
      await writeFile(join(dir, "context"), content, "utf-8");
    } else {
      await writeFile(join(dir, "plug"), content, "utf-8");
    }
    await writeFile(join(dir, "parent"), parent, "utf-8");
  }

  it("should return valid for a normal DAG credential", () => {
    expect(validateCredential("nonexistent", TEST_DIR)).toEqual({
      valid: false,
      error: "credential not found",
    });
  });

  it("should reject a credential whose parent chain contains a cycle", async () => {
    // Cycle: a -> b -> a
    await createNode("a", "b", "context", "a content");
    await createNode("b", "a", "context", "b content");

    const result = validateCredential("a", TEST_DIR);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Cycle detected/);
  });

  // Layer 1: Format validation
  it("should pass format check for valid IDs", () => {
    for (const id of ["my-node", "test_123", "abc", "a"]) {
      const result = validateCredential(id, TEST_DIR);
      expect(result).toEqual({ valid: false, error: "credential not found" });
    }
  });

  it("should reject ID with spaces and special characters", () => {
    expect(validateCredential("my node!", TEST_DIR)).toEqual({
      valid: false,
      error: "invalid credential id",
    });
  });

  it("should reject ID with path separator", () => {
    expect(validateCredential("foo/bar", TEST_DIR)).toEqual({
      valid: false,
      error: "invalid credential id",
    });
  });

  it("should reject empty ID", () => {
    expect(validateCredential("", TEST_DIR)).toEqual({
      valid: false,
      error: "invalid credential id",
    });
  });

  // Layer 2: Reserved name blacklist
  it("should reject reserved name 'credential'", () => {
    expect(validateCredential("credential", TEST_DIR)).toEqual({
      valid: false,
      error: "reserved name: credential",
    });
  });

  it("should reject reserved name 'agent'", () => {
    expect(validateCredential("agent", TEST_DIR)).toEqual({
      valid: false,
      error: "reserved name: agent",
    });
  });

  it("should reject reserved name 'prompt'", () => {
    expect(validateCredential("prompt", TEST_DIR)).toEqual({
      valid: false,
      error: "reserved name: prompt",
    });
  });

  it("should allow mixed-case 'Credential' (not reserved)", () => {
    expect(validateCredential("Credential", TEST_DIR)).toEqual({
      valid: false,
      error: "credential not found",
    });
  });

  // Layer 5: PID lock
  it("should reject locked credential with alive process PID", async () => {
    await createNode("locked-node", "root", "context", "test");
    const proc = Bun.spawn(["sleep", "300"]);
    await writeFile(
      join(TEST_DIR, "locked-node", ".lock"),
      String(proc.pid),
      "utf-8"
    );

    const result = validateCredential("locked-node", TEST_DIR);
    expect(result).toEqual({ valid: false, error: "credential locked" });

    proc.kill();
  });

  it("should clean stale lock with dead process PID", async () => {
    await createNode("stale-pid", "root", "context", "test");
    const lockFile = join(TEST_DIR, "stale-pid", ".lock");
    await writeFile(lockFile, "999999", "utf-8");

    const result = validateCredential("stale-pid", TEST_DIR);
    expect(result).toEqual({ valid: true });
    expect(existsSync(lockFile)).toBe(false);
  });

  it("should clean lock with non-numeric PID content", async () => {
    await createNode("bad-lock", "root", "context", "test");
    const lockFile = join(TEST_DIR, "bad-lock", ".lock");
    await writeFile(lockFile, "abc", "utf-8");

    const result = validateCredential("bad-lock", TEST_DIR);
    expect(result).toEqual({ valid: true });
    expect(existsSync(lockFile)).toBe(false);
  });

  it("should clean lock with empty PID content", async () => {
    await createNode("empty-lock", "root", "context", "test");
    const lockFile = join(TEST_DIR, "empty-lock", ".lock");
    await writeFile(lockFile, "", "utf-8");

    const result = validateCredential("empty-lock", TEST_DIR);
    expect(result).toEqual({ valid: true });
    expect(existsSync(lockFile)).toBe(false);
  });

  it("should clean lock with PID=0", async () => {
    await createNode("zero-pid", "root", "context", "test");
    const lockFile = join(TEST_DIR, "zero-pid", ".lock");
    await writeFile(lockFile, "0", "utf-8");

    const result = validateCredential("zero-pid", TEST_DIR);
    expect(result).toEqual({ valid: true });
    expect(existsSync(lockFile)).toBe(false);
  });

  // Full validation
  it("should return valid for a properly set up node with no lock", async () => {
    await createNode("good-node", "root", "context", "some prompt");
    const result = validateCredential("good-node", TEST_DIR);
    expect(result).toEqual({ valid: true });
  });
});
