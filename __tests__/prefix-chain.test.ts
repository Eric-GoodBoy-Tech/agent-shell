import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { prefixChain, formatChainOutput, formatChainPaths } from "../src/prefix-chain.ts";

const TEST_DIR = "__tests__/tmp-test-nodes-pc";

describe("prefixChain — context mode", () => {
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

  // Helper: create a test node
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

  it("should return empty for non-existing credential", async () => {
    const result = await prefixChain(TEST_DIR, "nonexistent");
    expect(result).toEqual([]);
  });

  it("should return empty when credential has no parent (root as credential)", async () => {
    await createNode("root", "", "context", "root content");
    
    // root has no parent, so prefix chain is empty
    const result = await prefixChain(TEST_DIR, "root");
    expect(result).toEqual([]);
  });

  it("should return single context node for credential with one context parent", async () => {
    await createNode("root", "", "context", "root content");
    await createNode("child", "root", "context", "child content");
    
    const result = await prefixChain(TEST_DIR, "child");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("root");
    expect(result[0].content).toBe("root content");
  });

  it("should skip plug nodes, only collect context nodes", async () => {
    await createNode("root", "", "context", "root content");
    await createNode("plug-a", "root", "plug", "echo plug");
    await createNode("ctx-a", "plug-a", "context", "ctx-a content");
    
    const result = await prefixChain(TEST_DIR, "ctx-a");
    
    // Should include root (context), but skip plug-a
    // Note: ctx-a is the credential itself — excluded per spec
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("root");
  });

  it("should return nodes in parent→child order (root first)", async () => {
    await createNode("root", "", "context", "root content");
    await createNode("a", "root", "context", "a content");
    await createNode("b", "a", "context", "b content");
    await createNode("c", "b", "context", "c content");
    
    // Credential is c, prefix chain is root, a, b
    const result = await prefixChain(TEST_DIR, "c");
    
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("root");
    expect(result[1].id).toBe("a");
    expect(result[2].id).toBe("b");
  });

  it("should NOT include the credential node itself", async () => {
    await createNode("root", "", "context", "root content");
    await createNode("cred", "root", "context", "credential content");
    
    const result = await prefixChain(TEST_DIR, "cred");
    
    // Should only have root, not cred
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("root");
  });

  it("should throw when a cycle is detected", async () => {
    // Create a cycle: a -> b -> a
    await createNode("a", "b", "context", "a content");
    await createNode("b", "a", "context", "b content");

    // credential is a — parent is b, b's parent is a (already visited)
    expect(() => prefixChain(TEST_DIR, "a")).toThrow("Cycle detected in node hierarchy at node: a");
  });

  it("should handle empty content files", async () => {
    await createNode("root", "", "context", "");
    await createNode("child", "root", "context", "child content");
    
    const result = await prefixChain(TEST_DIR, "child");
    
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("root");
    expect(result[0].content).toBe("");
  });
  it("should not crash when readNodeFile throws on unreadable file", async () => {
    await createNode("root-unread", "", "context", "root content");
    await createNode("child-unread", "root-unread", "context", "child content");

    // Make root's context file unreadable to trigger readFileSync EACCES in catch
    const rootContext = join(TEST_DIR, "root-unread", "context");
    chmodSync(rootContext, 0o000);

    // Should not crash — catch returns ""
    const result = prefixChain(TEST_DIR, "child-unread");

    // Unreadable node included but with empty content from catch
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("root-unread");
    expect(result[0].content).toBe("");

    // Restore permissions so afterEach cleanup can remove the file
    chmodSync(rootContext, 0o644);
  });

});

describe("formatChainOutput", () => {
  it("should format nodes as id\\tcontent lines", () => {
    const nodes = [
      { id: "root", content: "root content", type: "context" },
      { id: "a", content: "a content", type: "context" },
    ];
    
    const lines = formatChainOutput(nodes);
    
    expect(lines).toEqual([
      "root\troot content",
      "a\ta content",
    ]);
  });

  it("should handle empty content (id\\t with nothing after tab)", () => {
    const nodes = [
      { id: "root", content: "", type: "context" },
    ];
    
    const lines = formatChainOutput(nodes);
    
    expect(lines).toEqual(["root\t"]);
  });

  it("should handle empty nodes array", () => {
    const lines = formatChainOutput([]);
    expect(lines).toEqual([]);
  });
});

describe("prefixChain — plug mode (--type plug --paths)", () => {
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

  it("should collect plug nodes in paths mode via prefixChain traversal", async () => {
    await createNode("root", "", "context", "root content");
    await createNode("plug-a", "root", "plug", "echo plug a");
    await createNode("plug-b", "plug-a", "plug", "echo plug b");
    await createNode("ctx-after", "plug-b", "context", "ctx content");

    const result = await prefixChain(TEST_DIR, "ctx-after", "paths");

    // In paths mode, should collect only plug nodes (plug-a, plug-b)
    const ids = result.map(n => n.id);
    expect(ids).toEqual(["plug-a", "plug-b"]);

    // Should NOT include context nodes
    expect(ids).not.toContain("root");

    // Verify contents
    expect(result[0].content).toBe("echo plug a");
    expect(result[1].content).toBe("echo plug b");

    // Verify formatChainPaths works with the result
    const paths = formatChainPaths("nodes", result);
    expect(paths).toEqual([
      "nodes/plug-a/plug",
      "nodes/plug-b/plug",
    ]);
  });

  it("should return empty paths when no plug nodes", async () => {
    const paths = formatChainPaths("nodes", []);
    expect(paths).toEqual([]);
  });

  it("should output file paths in parent→child order via real traversal", async () => {
    await createNode("root", "", "plug", "root plug");
    await createNode("child1", "root", "plug", "child1 plug");
    await createNode("child2", "child1", "plug", "child2 plug");
    await createNode("cred", "child2", "context", "cred content");

    const result = await prefixChain(TEST_DIR, "cred", "paths");

    // In paths mode, should collect all three plug nodes in parent→child order
    const ids = result.map(n => n.id);
    expect(ids).toEqual(["root", "child1", "child2"]);

    // Verify formatChainPaths works with the result
    const paths = formatChainPaths("nodes", result);
    expect(paths).toEqual([
      "nodes/root/plug",
      "nodes/child1/plug",
      "nodes/child2/plug",
    ]);
  });

  it("should work with custom nodesPath", async () => {
    const nodes = [
      { id: "custom-node", content: "test", type: "plug" },
    ];

    const paths = formatChainPaths("/custom/path", nodes);

    expect(paths).toEqual(["/custom/path/custom-node/plug"]);
  });

  it("should include credential node itself when it has a plug file in paths mode", async () => {
    // Credential node has a plug file — lines 65-71 should include it
    await createNode("root-base", "", "context", "root context");
    await createNode("cred-plug", "root-base", "plug", "cred plug content");

    const result = prefixChain(TEST_DIR, "cred-plug", "paths");

    // Credential's plug should be included (root-base has no plug, so only one)
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("cred-plug");
    expect(result[0].content).toBe("cred plug content");
    expect(result[0].type).toBe("plug");
  });

});

describe("prefixChain — mixed context + plug chain", () => {
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

  it("should filter properly: content mode returns context, paths mode returns plug", async () => {
    // Create a chain: root(context) -> plug-a(plug) -> ctx-b(context) -> plug-c(plug)
    await createNode("root", "", "context", "root content");
    await createNode("plug-a", "root", "plug", "echo a");
    await createNode("ctx-b", "plug-a", "context", "ctx b content");
    await createNode("plug-c", "ctx-b", "plug", "echo c");
    await createNode("cred", "plug-c", "context", "cred content");

    // Content mode: should return root and ctx-b (context nodes)
    const contextResult = await prefixChain(TEST_DIR, "cred", "content");
    const contextIds = contextResult.map(n => n.id);
    expect(contextIds).toContain("root");
    expect(contextIds).toContain("ctx-b");
    expect(contextIds).not.toContain("plug-a");
    expect(contextIds).not.toContain("plug-c");
    expect(contextResult).toHaveLength(2);

    // Paths mode: should return plug-a and plug-c (plug nodes)
    const plugResult = await prefixChain(TEST_DIR, "cred", "paths");
    const plugIds = plugResult.map(n => n.id);
    expect(plugIds).toContain("plug-a");
    expect(plugIds).toContain("plug-c");
    expect(plugIds).not.toContain("root");
    expect(plugIds).not.toContain("ctx-b");
    expect(plugResult).toHaveLength(2);
  });
});
