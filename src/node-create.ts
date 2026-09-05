import { mkdir, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

interface CreateNodeOptions {
  nodesPath: string;
  parent: string;
  context?: string;
  plug?: string;
  id: string;
}

interface CreateNodeResult {
  success: boolean;
  id?: string;
  error?: string;
}

/**
 * Create a node at <nodesPath>/<id>: validate that at least one of context/plug is given,
 * the parent node exists (unless parent is ""), and id matches [A-Za-z0-9_-]+;
 * then write the parent/context/plug files and set permissions (node dir 0755, files 0644).
 */

export async function createNode(options: CreateNodeOptions): Promise<CreateNodeResult> {
  const { nodesPath, parent, context, plug, id } = options;

  if (context === undefined && plug === undefined) {
    return {
      success: false,
      error: "Either --context or --plug must be provided",
    };
  }

  if (parent !== "") {
    const parentDir = join(nodesPath, parent);
    if (!existsSync(parentDir)) {
      return {
        success: false,
        error: `Parent node "${parent}" does not exist at ${parentDir}`,
      };
    }
  }

  if (!id) {
    return {
      success: false,
      error: "id is required",
    };
  }

  const idPattern = /^[a-zA-Z0-9_-]+$/;
  if (!idPattern.test(id)) {
    return {
      success: false,
      error: `Invalid id "${id}". Must match [a-zA-Z0-9_-]+.`,
    };
  }

  const nodeDir = join(nodesPath, id);

  await mkdir(nodeDir, { recursive: true });

  await writeFile(join(nodeDir, "parent"), parent, "utf-8");

  if (context !== undefined) {
    await writeFile(join(nodeDir, "context"), context, "utf-8");
  }

  if (plug !== undefined) {
    await writeFile(join(nodeDir, "plug"), plug, "utf-8");
  }

  // Set directory permissions (755 — need write for .lock files)
  await chmod(nodeDir, 0o755);

  await chmod(join(nodeDir, "parent"), 0o644);
  if (context !== undefined) {
    await chmod(join(nodeDir, "context"), 0o644);
  }
  if (plug !== undefined) {
    await chmod(join(nodeDir, "plug"), 0o644);
  }

  return {
    success: true,
    id,
  };
}
