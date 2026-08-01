import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const NODES_DIR = "nodes";

/**
 * Reads the content of a file, returning empty string if file doesn't exist or is empty.
 */
function readNodeFile(nodeDir: string, filename: string): string {
  try {
    const content = readFileSync(join(nodeDir, filename), "utf-8");
    return content.trimEnd();
  } catch {
    return "";
  }
}

/**
 * Reads the parent ID of a node.
 */
function readParent(nodeDir: string): string | null {
  const parent = readNodeFile(nodeDir, "parent");
  return parent || null;
}

type OutputMode = "content" | "paths";

interface PrefixNode {
  id: string;
  content: string;
  type: string;
}

/**
 * Traverses the parent chain from the credential node up to root.
 *
 * - For "content" mode: collects ancestor nodes that have a `context` file.
 * - For "paths" mode: collects the credential node (if it has a `plug` file)
 *   and ancestor nodes that have a `plug` file.
 * - Uses visited set to detect and break cycles
 * - Returns nodes in parent→child order (root first, credential last)
 *
 * @param nodesPath - Path to nodes directory
 * @param credential - The credential node ID (starting point)
 * @param mode - Output mode: "content" returns context content lines, "paths" returns plug paths
 * @returns Array of {id, content, type} in parent→child order
 */
export function prefixChain(
  nodesPath: string,
  credential: string,
  mode: OutputMode = "content"
): PrefixNode[] {
  const credDir = join(nodesPath, credential);

  // Check if credential node exists
  if (!existsSync(credDir)) {
    return [];
  }

  const visited = new Set<string>();
  visited.add(credential); // prevent cycles that point back to credential
  const nodes: PrefixNode[] = [];

  // In plug mode, include the credential node itself if it has a plug file
  if (mode === "paths") {
    const plugFile = join(credDir, "plug");
    if (existsSync(plugFile)) {
      const content = readNodeFile(credDir, "plug");
      nodes.push({ id: credential, content, type: "plug" });
    }
  }

  // Traverse parent chain
  let currentParent = readParent(credDir);
  while (currentParent) {
    // Cycle detection
    if (visited.has(currentParent)) {
      throw new Error(`Cycle detected in node hierarchy at node: ${currentParent}`);
    }
    visited.add(currentParent);

    const nodeDir = join(nodesPath, currentParent);

    // Skip if node directory doesn't exist
    if (!existsSync(nodeDir)) {
      break;
    }

    if (mode === "paths") {
      const plugFile = join(nodeDir, "plug");
      if (existsSync(plugFile)) {
        const content = readNodeFile(nodeDir, "plug");
        nodes.push({ id: currentParent, content, type: "plug" });
      }
    } else {
      const contextFile = join(nodeDir, "context");
      if (existsSync(contextFile)) {
        const content = readNodeFile(nodeDir, "context");
        nodes.push({ id: currentParent, content, type: "context" });
      }
    }

    // Move to parent
    currentParent = readParent(nodeDir);
  }

  // Reverse to get parent→child order (root first)
  nodes.reverse();

  return nodes;
}

/**
 * Formats the prefix chain result for stdout output.
 * Output format: id\tcontent (tab-separated, one per line)
 *
 * @param nodes - The prefix chain nodes in parent→child order
 * @returns Array of formatted lines
 */
export function formatChainOutput(nodes: PrefixNode[]): string[] {
  return nodes.map((node) => `${node.id}\t${node.content}`);
}

/**
 * Formats the prefix chain result as file paths for plug mode.
 * Output format: nodes/<id>/plug (one per line)
 *
 * @param nodesPath - Path to nodes directory
 * @param nodes - The prefix chain nodes
 * @returns Array of file paths
 */
export function formatChainPaths(nodesPath: string, nodes: PrefixNode[]): string[] {
  return nodes.map((node) => join(nodesPath, node.id, "plug"));
}
