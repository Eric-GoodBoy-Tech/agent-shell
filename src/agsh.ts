/**
 * agsh — the single interface object exposing the whole TS capability layer
 * to plugins and the CLI layer. Capability domain types live in types.ts;
 * the aggregation design is documented in the AgshApi JSDoc there.
 *
 * Calling convention: entry points must go through object-property access
 * (agsh.api.call(...)); destructuring (`const { call } = agsh.api`) pins the
 * current binding. See the AgshApi JSDoc for the rationale.
 */
import { callApi, callApiStream } from "./call.ts";
import {
  buildContext,
  detectPendingTool,
  saveDelta,
  appendToContext,
  appendToolResult,
} from "./context.ts";
import { loadConfig } from "./config.ts";
import { validateCredential } from "./credential.ts";
import { initCommand } from "./init.ts";
import { SYSTEM_INSTRUCTION } from "./protocol.ts";
import { createNode } from "./node-create.ts";
import {
  prefixChain,
  formatChainOutput,
  formatChainPaths,
} from "./prefix-chain.ts";
import type { AgshApi } from "./types.ts";

/**
 * The core interface object (mutable): the default implementations are
 * mounted here.
 */
export const agsh: AgshApi = {
  api: {
    // Wrapper: inject the current config on every call.
    call: (options) => callApi(options, agsh.config.load()),
    stream: (messages, apiKey, baseUrl, model, reasoningEffort) =>
      callApiStream(messages, apiKey, baseUrl, model, reasoningEffort, agsh.config.load()),
  },
  context: {
    // Wrapper: inject the prefix-chain implementation on every call.
    build: (credential, nodesPath) =>
      buildContext(credential, nodesPath, agsh.prefix.chain),
    detectPending: detectPendingTool,
    saveDelta,
    appendContext: appendToContext,
    appendToolResult,
  },
  node: {
    create: createNode,
  },
  credential: {
    validate: validateCredential,
  },
  init: {
    protocol: SYSTEM_INSTRUCTION,
    // Wrapper: inject the current protocol text on every call.
    init: (nodesPath) => initCommand(nodesPath, agsh.init.protocol),
  },
  prefix: {
    chain: prefixChain,
    formatOutput: formatChainOutput,
    formatPaths: formatChainPaths,
  },
  config: {
    load: loadConfig,
  },
};
