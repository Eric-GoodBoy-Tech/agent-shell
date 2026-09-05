import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Thrown when a cycle is detected in the parent chain during traversal. */
export class CycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CycleError";
  }
}

/**
 * Returns "" if the file is missing or unreadable; otherwise content with
 * trailing whitespace trimmed.
 */
function readNodeFile(nodeDir: string, filename: string): string {
  try {
    const content = readFileSync(join(nodeDir, filename), "utf-8");
    return content.trimEnd();
  } catch {
    return "";
  }
}

/** Read the parent id from a node directory; null when the parent file is missing or empty. */

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
 * - "content" mode: collects ancestor nodes that have a `context` file.
 * - "paths" mode: collects the credential node (if it has a `plug` file)
 *   and ancestor nodes that have a `plug` file.
 * - Returns nodes in parent→child order (root first, credential last).
 * - Throws CycleError if a cycle is detected in the parent chain.
 */
export function prefixChain(
  nodesPath: string,
  credential: string,
  mode: OutputMode = "content"
): PrefixNode[] {
  const credDir = join(nodesPath, credential);

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

  let currentParent = readParent(credDir);
  while (currentParent) {
    if (visited.has(currentParent)) {
      throw new CycleError(`Cycle detected in node hierarchy at node: ${currentParent}`);
    }
    visited.add(currentParent);

    const nodeDir = join(nodesPath, currentParent);

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

    currentParent = readParent(nodeDir);
  }

  nodes.reverse();

  return nodes;
}

/**
 * Formats the prefix chain result for stdout output.
 * Output format: id\tcontent (tab-separated, one per line)
 */
export function formatChainOutput(nodes: PrefixNode[]): string[] {
  return nodes.map((node) => `${node.id}\t${node.content}`);
}

/**
 * Formats the prefix chain result as file paths for plug mode.
 * Output format: <nodesPath>/<id>/plug (one per line)
 */
export function formatChainPaths(nodesPath: string, nodes: PrefixNode[]): string[] {
  return nodes.map((node) => join(nodesPath, node.id, "plug"));
}
