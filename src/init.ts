import { mkdir, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_INSTRUCTION } from "./protocol.ts";

const NODES_DIR = "nodes";
const ROOT_ID = "root";

/**
 * Idempotent: if root already exists, returns success with "Nothing to do."
 */
export async function initCommand(
  nodesPath: string = NODES_DIR,
  protocolText: string = SYSTEM_INSTRUCTION,
): Promise<{ success: boolean; message: string }> {
  const rootDir = join(nodesPath, ROOT_ID);

  await mkdir(nodesPath, { recursive: true });

  if (existsSync(rootDir)) {
    return {
      success: true,
      message: `Root node already exists at ${rootDir}. Nothing to do.`,
    };
  }

  await mkdir(rootDir, { recursive: true });

  await writeFile(join(rootDir, "context"), protocolText, "utf-8");
  // Write parent file (empty for root)
  await writeFile(join(rootDir, "parent"), "", "utf-8");

  // Set directory permissions (755 — need write for .lock files)
  await chmod(rootDir, 0o755);

  // chmod the context file to 644 (readable, owner-writable)
  await chmod(join(rootDir, "context"), 0o644);

  return {
    success: true,
    message: `Root node created at ${rootDir}`,
  };
}
