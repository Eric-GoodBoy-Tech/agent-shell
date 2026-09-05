import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { prefixChain, CycleError } from "./prefix-chain.ts";
export interface ValidateResult {
  valid: boolean;
  error?: string;
}

const RESERVED_NAMES = ["credential", "agent"];
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validates a credential ID against five layers of checks.
 * 1. ID format whitelist [a-zA-Z0-9_-]+
 * 2. Reserved name blacklist (credential, agent)
 * 3. Directory existence check .agsh/nodes/<id>
 * 4. Node hierarchy must be a DAG (no parent cycles)
 * 5. PID lock file check .agsh/nodes/<id>/.lock — stale locks auto-cleaned
 */
export function validateCredential(
  id: string,
  nodesPath: string
): ValidateResult {
  if (!ID_PATTERN.test(id)) {
    return { valid: false, error: "invalid credential id" };
  }
  if (RESERVED_NAMES.includes(id)) {
    return { valid: false, error: `reserved name: ${id}` };
  }
  const nodeDir = join(nodesPath, id);
  if (!existsSync(nodeDir)) {
    return { valid: false, error: "credential not found" };
  }
  try {
    prefixChain(nodesPath, id, "content");
  } catch (e) {
    if (e instanceof CycleError) {
      return { valid: false, error: e.message };
    }
    throw e;
  }

  const lockFile = join(nodeDir, ".lock");
  if (existsSync(lockFile)) {
    try {
      const raw = readFileSync(lockFile, "utf-8").trim();
      const pid = parseInt(raw, 10);
      if (!isNaN(pid) && pid > 0) {
        try {
          process.kill(pid, 0); // signal 0: check existence only
          return { valid: false, error: "credential locked" };
        } catch (e: any) {
          if (e.code === "ESRCH") {
            // Process dead — clean stale lock
            try { unlinkSync(lockFile); } catch { /* best effort */ }
          }
          // EPERM: process alive under another user → locked; other codes → stale lock
          if (e.code === "EPERM") {
            return { valid: false, error: "credential locked" };
          }
          try { unlinkSync(lockFile); } catch { /* best effort */ }
        }
      } else {
        // Invalid PID content — clean stale lock
        try { unlinkSync(lockFile); } catch { /* best effort */ }
      }
    } catch {
      // Can't read lock file — treat as locked (safe side)
      return { valid: false, error: "credential locked" };
    }
  }
  return { valid: true };
}
