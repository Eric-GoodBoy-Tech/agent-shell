import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, chmod, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { initCommand } from "../src/init.ts";

// Use a temporary test directory to avoid polluting real nodes/
const TEST_DIR = "__tests__/tmp-test-nodes";

/**
 * Restore write permissions before removal — initCommand sets chmod 755/644
 * which prevents rm({ force: true }) from deleting.
 */
async function forceCleanup(dir: string): Promise<void> {
  if (!existsSync(dir)) return;

  const rootDir = join(dir, "root");
  if (existsSync(rootDir)) {
    // Restore dir permissions so it can be deleted
    await chmod(rootDir, 0o755);
    // Restore file permissions
    for (const file of ["context", "parent"]) {
      const fp = join(rootDir, file);
      if (existsSync(fp)) await chmod(fp, 0o644);
    }
  }
  await rm(dir, { recursive: true, force: true });
}

describe("initCommand", () => {
  beforeEach(async () => {
    await forceCleanup(TEST_DIR);
  });

  afterEach(async () => {
    await forceCleanup(TEST_DIR);
  });

  it("should create nodes/root with content, parent, and type files on first run", async () => {
    const result = await initCommand(TEST_DIR);

    expect(result.success).toBe(true);
    expect(result.message).toContain("Root node created");

    // Verify root directory exists
    const rootDir = join(TEST_DIR, "root");
    expect(existsSync(rootDir)).toBe(true);

    // Verify three files exist
    expect(existsSync(join(rootDir, "context"))).toBe(true);
    expect(existsSync(join(rootDir, "parent"))).toBe(true);
    expect(existsSync(join(rootDir, "context"))).toBe(true);

    // Verify type is "context"
    // type file removed
    

    // Verify parent is empty (root node)
    const parentFile = Bun.file(join(rootDir, "parent"));
    expect(await parentFile.text()).toBe("");

    // Verify content contains system instruction
    const contentFile = Bun.file(join(rootDir, "context"));
    const content = await contentFile.text();
    expect(content).toContain("state-passing chain");
    expect(content).toContain("shell");
  });

  it("should be idempotent — second run exits 0 without modifying", async () => {
    // First run
    const result1 = await initCommand(TEST_DIR);
    expect(result1.success).toBe(true);

    // Second run
    const result2 = await initCommand(TEST_DIR);
    expect(result2.success).toBe(true);
    expect(result2.message).toContain("already exists");
    expect(result2.message).toContain("Nothing to do");
  });

  it("should set chmod 755 (owner-writable) on nodes/root directory", async () => {
    await initCommand(TEST_DIR);

    const rootDir = join(TEST_DIR, "root");
    const stats = statSync(rootDir);

    // 0o755 = rwxr-xr-x (owner has write for .lock file creation)
    const mode = stats.mode & 0o777;
    expect(mode & 0o200).toBe(0o200); // Owner write bit set
  });

  it("should set chmod 644 (owner-writable) on content, parent, type files", async () => {
    await initCommand(TEST_DIR);

    const rootDir = join(TEST_DIR, "root");
    for (const file of ["context", "parent"]) {
      const stats = statSync(join(rootDir, file));
      const mode = stats.mode & 0o777;
      expect(mode & 0o200).toBe(0o200); // Owner write bit set
    }
  });

  it("should create nodes/ directory if it doesn't exist", async () => {
    // TEST_DIR should not exist at this point (cleaned in beforeEach)
    expect(existsSync(TEST_DIR)).toBe(false);

    await initCommand(TEST_DIR);

    expect(existsSync(TEST_DIR)).toBe(true);
  });

  // ── Partial corruption recovery ──

  it("should return 'already exists' when root dir exists but parent file is missing", async () => {
    // Simulate partial corruption: root dir with only context, no parent
    const rootDir = join(TEST_DIR, "root");
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, "context"), "partial content", "utf-8");

    const result = await initCommand(TEST_DIR);
    expect(result.success).toBe(true);
    expect(result.message).toContain("already exists");
    // Parent file should still be missing (current behavior)
    expect(existsSync(join(rootDir, "parent"))).toBe(false);
  });

  it("should return 'already exists' when root dir exists but context file is missing", async () => {
    const rootDir = join(TEST_DIR, "root");
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, "parent"), "", "utf-8");

    const result = await initCommand(TEST_DIR);
    expect(result.success).toBe(true);
    expect(result.message).toContain("already exists");
    expect(existsSync(join(rootDir, "context"))).toBe(false);
  });

  it("should return 'already exists' when root dir exists but both files are missing", async () => {
    const rootDir = join(TEST_DIR, "root");
    await mkdir(rootDir, { recursive: true });
    // Deliberately write neither context nor parent

    const result = await initCommand(TEST_DIR);
    expect(result.success).toBe(true);
    expect(result.message).toContain("already exists");
    expect(existsSync(join(rootDir, "context"))).toBe(false);
    expect(existsSync(join(rootDir, "parent"))).toBe(false);
  });

  // ── Extended permission verification ──

  it("should create context file with mode 0o644 on fresh init", async () => {
    await initCommand(TEST_DIR);

    const contextPath = join(TEST_DIR, "root", "context");
    const stats = statSync(contextPath);
    expect(stats.mode & 0o777).toBe(0o644);
  });

  it("should create parent file with mode 0o644 on fresh init", async () => {
    await initCommand(TEST_DIR);

    const parentPath = join(TEST_DIR, "root", "parent");
    const stats = statSync(parentPath);
    expect(stats.mode & 0o777).toBe(0o644);
  });

  it("should preserve correct permissions after re-init on an already-initialized nodesPath", async () => {
    // Fresh init
    await initCommand(TEST_DIR);

    const rootDir = join(TEST_DIR, "root");
    expect(statSync(rootDir).mode & 0o777).toBe(0o755);
    expect(statSync(join(rootDir, "context")).mode & 0o777).toBe(0o644);
    expect(statSync(join(rootDir, "parent")).mode & 0o777).toBe(0o644);

    // Re-init (should be idempotent — "already exists")
    const result = await initCommand(TEST_DIR);
    expect(result.success).toBe(true);
    expect(result.message).toContain("already exists");

    // Permissions should be unchanged after re-init
    expect(statSync(rootDir).mode & 0o777).toBe(0o755);
    expect(statSync(join(rootDir, "context")).mode & 0o777).toBe(0o644);
    expect(statSync(join(rootDir, "parent")).mode & 0o777).toBe(0o644);
  });

  // ── Idempotent re-init ──

  it("should be idempotent on third consecutive init — same 'already exists' behavior", async () => {
    await initCommand(TEST_DIR);

    const result2 = await initCommand(TEST_DIR);
    expect(result2.message).toContain("already exists");

    const result3 = await initCommand(TEST_DIR);
    expect(result3.success).toBe(true);
    expect(result3.message).toContain("already exists");
  });

  // ── Edge cases ──

  it("should handle nodesPath with trailing slash", async () => {
    const result = await initCommand(TEST_DIR + "/");

    expect(result.success).toBe(true);
    expect(result.message).toContain("Root node created");

    const rootDir = join(TEST_DIR, "root");
    expect(existsSync(rootDir)).toBe(true);
    expect(existsSync(join(rootDir, "context"))).toBe(true);
    expect(existsSync(join(rootDir, "parent"))).toBe(true);
  });

  it("should create nested intermediate directories implicitly (mkdir -p behavior)", async () => {
    const deepPath = join(TEST_DIR, "deep", "nested", "nodes");
    expect(existsSync(deepPath)).toBe(false);

    const result = await initCommand(deepPath);

    expect(result.success).toBe(true);
    expect(result.message).toContain("Root node created");

    const rootDir = join(deepPath, "root");
    expect(existsSync(rootDir)).toBe(true);
    expect(existsSync(join(rootDir, "context"))).toBe(true);
    expect(existsSync(join(rootDir, "parent"))).toBe(true);

    // Explicit cleanup for the deep sub-path (afterEach only cleans TEST_DIR/root)
    // The test dir permissions are standard (755) so rm recurses cleanly
    await rm(join(TEST_DIR, "deep"), { recursive: true, force: true });
  });
});
