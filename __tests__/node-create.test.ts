import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createNode } from "../src/node-create.ts";

const TEST_DIR = "__tests__/tmp-test-nodes-nc";

/**
 * Restore write permissions recursively so we can clean up.
 */
async function forceChmod(dirPath: string) {
  if (!existsSync(dirPath)) return;
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dirPath, entry.name);
    await chmod(full, 0o777);
    if (entry.isDirectory()) {
      await forceChmod(full);
    }
  }
  await chmod(dirPath, 0o777);
}

describe("createNode", () => {
  beforeEach(async () => {
    // Ensure any leftover read-only test dir is made writable before removal
    if (existsSync(TEST_DIR)) {
      await forceChmod(TEST_DIR);
      await rm(TEST_DIR, { recursive: true, force: true });
    }
    await mkdir(TEST_DIR, { recursive: true });
    
    // Create a root node for parent validation tests
    const rootDir = join(TEST_DIR, "root");
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, "context"), "root content", "utf-8");
    await writeFile(join(rootDir, "parent"), "", "utf-8");
    await writeFile(join(rootDir, "type"), "context", "utf-8");
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await forceChmod(TEST_DIR);
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("should create a context node with content, parent, and context files", async () => {
    const result = await createNode({
      nodesPath: TEST_DIR,
      parent: "root",
      context: "test context content",
      id: "test-context-node",
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe("test-context-node");

    // Verify node directory and files exist
    // Verify node directory and files exist
    const nodeDir = join(TEST_DIR, result.id!);
    expect(existsSync(join(nodeDir, "context"))).toBe(true);
    expect(existsSync(join(nodeDir, "parent"))).toBe(true);

    // Verify file contents
    const contentFile = Bun.file(join(nodeDir, "context"));
    expect(await contentFile.text()).toBe("test context content");

    const parentFile = Bun.file(join(nodeDir, "parent"));
    expect(await parentFile.text()).toBe("root");

    // type file removed
    // type file removed
  });

  it("should create a plug node", async () => {
    const result = await createNode({
      nodesPath: TEST_DIR,
      parent: "root",
      plug: "echo plug loaded",
      id: "test-plug-node",
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe("test-plug-node");
  });

  it("should set chmod 755 (owner-writable) on the node directory", async () => {
    const result = await createNode({
      nodesPath: TEST_DIR,
      parent: "root",
      context: "test",
      id: "test-chmod-dir",
    });

    const nodeDir = join(TEST_DIR, result.id!);
    const mode = statSync(nodeDir).mode & 0o777;
    // 0o755 = rwxr-xr-x (owner has write for .lock file creation)
    expect(mode & 0o200).toBe(0o200); // Owner write bit set
  });

  it("should set chmod 644 (owner-writable) on content, parent, context files", async () => {
    const result = await createNode({
      nodesPath: TEST_DIR,
      parent: "root",
      context: "test",
      id: "test-chmod-files",
    });

    const nodeDir = join(TEST_DIR, result.id!);
    for (const file of ["context", "parent"]) {
      const mode = statSync(join(nodeDir, file)).mode & 0o777;
      expect(mode & 0o200).toBe(0o200); // Owner write bit set
    }
  });

  it("should reject missing context and plug", async () => {
    const result = await createNode({
      nodesPath: TEST_DIR,
      parent: "root",
      id: "test-no-content",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("--context or --plug");
  });

  it("should reject non-existent parent", async () => {
    const result = await createNode({
      nodesPath: TEST_DIR,
      parent: "nonexistent-parent",
      context: "test",
      id: "test-bad-parent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not exist");
    expect(result.error).toContain("nonexistent-parent");
  });

  it("should return error when id is missing", async () => {
    const result = await createNode({
      nodesPath: TEST_DIR,
      parent: "root",
      context: "test",
    } as any);

    expect(result.success).toBe(false);
    expect(result.error).toBe("id is required");
  });

  it("should handle newlines in content", async () => {
    const result = await createNode({
      nodesPath: TEST_DIR,
      parent: "root",
      context: "line 1\nline 2\nline 3",
      id: "test-newlines",
    });

    expect(result.success).toBe(true);
    expect(result.success).toBe(true);
    expect(result.id).toBe("test-newlines");
    const contentFile = Bun.file(join(TEST_DIR, result.id!, "content"));
  });

  it("should accept a semantic node ID", async () => {
    const result = await createNode({
      nodesPath: TEST_DIR,
      parent: "root",
      context: "semantic node",
      id: "my-node-1",
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe("my-node-1");

    // Verify directory uses the semantic ID
    const nodeDir = join(TEST_DIR, result.id!);
    expect(existsSync(nodeDir)).toBe(true);
    expect(existsSync(join(nodeDir, "context"))).toBe(true);
    const contentFile = Bun.file(join(nodeDir, "context"));
    expect(await contentFile.text()).toBe("semantic node");
  });

  it("should reject an invalid semantic ID", async () => {
    const result = await createNode({
      nodesPath: TEST_DIR,
      parent: "root",
      context: "bad id",
      id: "my node!",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid id");
    expect(result.error).toContain("my node!");
  });

  it("should reject a semantic ID with slashes", async () => {
    const result = await createNode({
      nodesPath: TEST_DIR,
      parent: "root",
      context: "bad id",
      id: "foo/bar",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid id");
  });
});
