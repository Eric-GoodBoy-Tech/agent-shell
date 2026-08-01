import { mkdir, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

interface CreateNodeOptions {
  /** Path to the nodes directory */
  nodesPath: string;
  /** Parent node ID (must exist) */
  parent: string;
  /** Context content to write (optional but at least one of context/plug must be provided) */
  context?: string;
  /** Plug content to write (optional but at least one of context/plug must be provided) */
  plug?: string;
  /** Required semantic ID (must match [a-zA-Z0-9_-]+) */
  id: string;
}

interface CreateNodeResult {
  success: boolean;
  /** The new node ID on success */
  id?: string;
  /** Error message on failure */
  error?: string;
}

/**
 * Creates a new node in the filesystem node tree.
 *
 * Steps:
 * 1. Validate at least one of context or plug is provided
 * 2. Validate parent node exists
 * 3. Validate the provided ID
 * 4. Create nodes/<id>/ directory
 * 5. Write parent, context, and/or plug files
 * 6. chmod 755 the directory and 644 individual files
 * 7. Return the new node ID
 *
 * @param options - Node creation options
 * @returns Result with the new node ID or error
 */
export async function createNode(options: CreateNodeOptions): Promise<CreateNodeResult> {
  const { nodesPath, parent, context, plug, id } = options;

  // Validate at least one capability file is provided
  if (context === undefined && plug === undefined) {
    return {
      success: false,
      error: "Either --context or --plug must be provided",
    };
  }

  // Validate parent exists (unless parent is empty string, which means root-level)
  if (parent !== "") {
    const parentDir = join(nodesPath, parent);
    if (!existsSync(parentDir)) {
      return {
        success: false,
        error: `Parent node "${parent}" does not exist at ${parentDir}`,
      };
    }
  }

  // Validate id is provided
  if (!id) {
    return {
      success: false,
      error: "id is required",
    };
  }

  // Validate id format
  const idPattern = /^[a-zA-Z0-9_-]+$/;
  if (!idPattern.test(id)) {
    return {
      success: false,
      error: `Invalid id "${id}". Must match [a-zA-Z0-9_-]+.`,
    };
  }

  const nodeDir = join(nodesPath, id);

  // Create node directory
  await mkdir(nodeDir, { recursive: true });

  // Write parent file
  await writeFile(join(nodeDir, "parent"), parent, "utf-8");

  // Write context file if provided
  if (context !== undefined) {
    await writeFile(join(nodeDir, "context"), context, "utf-8");
  }

  // Write plug file if provided
  if (plug !== undefined) {
    await writeFile(join(nodeDir, "plug"), plug, "utf-8");
  }

  // Set directory permissions (755 — need write for .lock files)
  await chmod(nodeDir, 0o755);

  // Set individual files to readable, owner-writable (644)
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
