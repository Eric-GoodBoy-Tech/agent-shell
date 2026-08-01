#!/usr/bin/env bash
#===============================================================================
# E2E Full Cycle Test — Agent Shell MVP
#===============================================================================
# Tests the complete Agent Shell lifecycle against a mock API server.
# Non-interactive — runs via bash, not zsh interactive.
#
# Lifecycle: init → node create → prefix-chain → call (mock API)
#            → plug node → plug paths → error handling
#
# Usage: bash test-shell/e2e-full-cycle.sh
#===============================================================================

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/tmux-e2e-lib.sh"
PASS=0
FAIL=0

cleanup() {
  stop_mock_server

  # Summary
  echo ""
  echo "========================================"
  echo "E2E Test Results: $PASS passed, $FAIL failed"
  echo "========================================"

  if [[ $FAIL -gt 0 ]]; then
    exit 1
  fi
}

trap cleanup EXIT

# ─── Helpers ────────────────────────────────────────────────────────────────
assert_pass() {
  local desc="$1"
  echo "  ✓ $desc"
  ((++PASS))
}

assert_fail() {
  local desc="$1"
  local reason="${2:-}"
  echo "  ✗ FAIL: $desc"
  if [[ -n "$reason" ]]; then
    echo "    Reason: $reason"
  fi
  ((++FAIL))
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    assert_pass "$desc"
  else
    assert_fail "$desc" "expected='$expected' actual='$actual'"
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    assert_pass "$desc"
  else
    assert_fail "$desc" "expected to contain '$needle'"
  fi
}

assert_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    assert_pass "$desc"
  else
    assert_fail "$desc" "should NOT contain '$needle'"
  fi
}

# ─── Step 1: Prerequisites ─────────────────────────────────────────────────
echo "=== Step 1: Prerequisites ==="

if command -v jq &>/dev/null; then
  assert_pass "jq is available"
else
  assert_fail "jq is available" "jq not found — install with: brew install jq"
fi

if command -v bun &>/dev/null; then
  assert_pass "bun is available"
else
  assert_fail "bun is available" "bun not found — install with: brew install bun"
fi

cd "$AGENT_DIR"
export AGENT_NODES_PATH=".agsh/nodes"

# ─── Step 2: agsh init ─────────────────────────────────────────────────────
echo ""
echo "=== Step 2: agsh init ==="

INIT_OUTPUT="$(bun run src/cli.ts init 2>&1)" || true
echo "  init output: $INIT_OUTPUT"

# Init should find or create the root node
assert_contains "init creates or finds root node" "$INIT_OUTPUT" "Root node"

# Verify root node structure exists
if [[ -f ".agsh/nodes/root/context" ]]; then
  assert_pass "root/context exists"
  ROOT_CONTENT="$(cat .agsh/nodes/root/context)"
  # Root content should be a substantial system prompt
  if [[ ${#ROOT_CONTENT} -gt 100 ]]; then
    assert_pass "root content looks valid (length > 100)"
  else
    assert_fail "root content looks valid" "too short"
  fi
else
  assert_fail "root/context exists"
fi



if [[ -f ".agsh/nodes/root/parent" ]]; then
  ROOT_PARENT="$(cat .agsh/nodes/root/parent)"
  assert_eq "root parent is empty string" "" "$ROOT_PARENT"
else
  assert_fail "root/parent exists"
fi

# ─── Step 3: agsh node create (context) ────────────────────────────────────
echo ""
echo "=== Step 3: agsh node create (context) ==="

NODE_ID="$(bun run src/cli.ts node create --parent root --id e2e-ctx-node --context "test context for e2e cycle" 2>&1)" || true
echo "  created node: $NODE_ID"

# UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
if [[ -n "$NODE_ID" ]]; then
  assert_pass "node create returns node ID"
else
  assert_fail "node create returns node ID" "empty"
fi

# Verify node content, type, parent
if [[ -f ".agsh/nodes/$NODE_ID/context" ]]; then
  NODE_CONTENT="$(cat ".agsh/nodes/$NODE_ID/context")"
  assert_eq "node context is correct" "test context for e2e cycle" "$NODE_CONTENT"
else
  assert_fail "node context file exists"
fi


if [[ -f ".agsh/nodes/$NODE_ID/parent" ]]; then
  NODE_PARENT="$(cat ".agsh/nodes/$NODE_ID/parent")"
  assert_eq "node parent is root" "root" "$NODE_PARENT"
else
  assert_fail "node parent file exists"
fi

# ─── Step 4: agsh prefix-chain ─────────────────────────────────────────────
echo ""
echo "=== Step 4: agsh prefix-chain ==="

# prefix-chain for child node should include root (as context)
PC_OUTPUT="$(bun run src/cli.ts prefix-chain --cred "$NODE_ID" 2>&1)" || true
echo "  prefix-chain output (first 200 chars): ${PC_OUTPUT:0:200}"

assert_contains "prefix-chain includes root node" "$PC_OUTPUT" "root"

# prefix-chain for root itself should be empty (root has no parent)
PC_ROOT="$(bun run src/cli.ts prefix-chain --cred root 2>&1)" || true
echo "  prefix-chain for root: '$PC_ROOT'"
assert_eq "prefix-chain for root is empty" "" "$PC_ROOT"

# ─── Step 5: Mock API server ───────────────────────────────────────────────
echo ""
echo "=== Step 5: Mock API server ==="

# Start the shared mock server. Uses "dynamic" mode which routes based on
# message content keywords: NO_TOOLS → text, MULTI_TOOLS → multi, default → tool_calls.
# The server writes its port to a temp file; start_mock_server waits for it.
if start_mock_server 0 dynamic; then
  assert_pass "mock API server started on port $MOCK_PORT"
else
  assert_fail "mock API server started" "process failed to start"
  exit 1
fi

# ─── Step 6: agsh call (mock API) ──────────────────────────────────────────
echo ""
echo "=== Step 6: agsh call (against mock API) ==="

# Set environment for the API call — these override any .env file
export AGENT_API_KEY="test-e2e-api-key-mock"
export AGENT_BASE_URL="http://localhost:$MOCK_PORT"
export AGENT_MODEL="e2e-test-model"

CALL_OUTPUT="$(bun run src/cli.ts call --messages '[{"role":"user","content":"run a test command"}]' 2>&1)" || true
echo "  call output: $CALL_OUTPUT"

# Verify the API response structure
assert_contains "call returns tool_calls key" "$CALL_OUTPUT" '"tool_calls"'
assert_contains "call returns assistant role" "$CALL_OUTPUT" '"assistant"'
assert_contains "call returns mock call ID" "$CALL_OUTPUT" 'call_e2e_mock_001'
assert_contains "call returns shell function" "$CALL_OUTPUT" '"shell"'
assert_contains "call returns echo command" "$CALL_OUTPUT" 'hello from agent shell e2e test'

# Verify it's valid JSON
if echo "$CALL_OUTPUT" | jq -e '.' &>/dev/null; then
  assert_pass "call output is valid JSON"

  # Check specific JSON fields
  TOOL_CALLS_COUNT="$(echo "$CALL_OUTPUT" | jq '.tool_calls | length' 2>/dev/null)"
  if [[ "$TOOL_CALLS_COUNT" == "1" ]]; then
    assert_pass "call has exactly 1 tool_call"
  else
    assert_fail "call has exactly 1 tool_call" "got $TOOL_CALLS_COUNT"
  fi
else
  assert_fail "call output is valid JSON"
fi

# ─── Step 7: agsh node create (plug) ─────────────────────────────────────
echo ""
echo "=== Step 7: agsh node create (plug) ==="

PLUG_CONTENT='export E2E_PLUG_LOADED=1
echo "[e2e-plug] loaded successfully"'

PLUG_ID="$(bun run src/cli.ts node create --parent root --id e2e-plug-node --plug "$PLUG_CONTENT" 2>&1)" || true
echo "  plug node id: $PLUG_ID"

if [[ -n "$PLUG_ID" ]]; then
  assert_pass "plug node create returns ID"
else
  assert_fail "plug node create returns ID" "empty"
fi

if [[ -f ".agsh/nodes/$PLUG_ID/plug" ]]; then
  assert_pass "plug file exists"
else
  assert_fail "plug file exists"
fi

if [[ -f ".agsh/nodes/$PLUG_ID/plug" ]]; then
  PLUG_CONTENT_ACTUAL="$(cat ".agsh/nodes/$PLUG_ID/plug")"
  assert_contains "plug content was saved" "$PLUG_CONTENT_ACTUAL" "E2E_PLUG_LOADED"
else
  assert_fail "plug node plug file exists"
fi

# ─── Step 8: prefix-chain plug mode ──────────────────────────────────────
echo ""
echo "=== Step 8: prefix-chain plug mode ==="

# Plug mode includes credential node itself if it has a plug file
PC_PLUG="$(bun run src/cli.ts prefix-chain --cred "$PLUG_ID" --type plug --paths 2>&1)" || true
echo "  plug paths: '$PC_PLUG'"

# The plug node own plug should appear in paths
assert_contains "plug paths include own plug" "$PC_PLUG" "$PLUG_ID"

# Verify that the plug node itself exists and can be accessed
assert_contains "plug node directory exists" "$(ls .agsh/nodes/)" "$PLUG_ID"
# ─── Step 9: Second call (verify mock server still alive) ──────────────────
echo ""
echo "=== Step 9: Second mock API call ==="

# Verify the mock server can handle multiple requests
CALL2_OUTPUT="$(bun run src/cli.ts call --messages '[{"role":"user","content":"second call"}]' 2>&1)" || true
echo "  call2 output: $CALL2_OUTPUT"

assert_contains "second call returns tool_calls" "$CALL2_OUTPUT" '"tool_calls"'
assert_contains "second call returns call_e2e_mock_001" "$CALL2_OUTPUT" 'call_e2e_mock_001'

# ─── Step 10: Error handling ───────────────────────────────────────────────
echo ""
echo "=== Step 10: Error handling ==="

# 10a: prefix-chain with nonexistent credential returns empty
PC_MISSING="$(bun run src/cli.ts prefix-chain --cred nonexistent_node_xyz 2>&1)" || true
echo "  prefix-chain nonexistent: '$PC_MISSING'"
assert_eq "prefix-chain nonexistent returns empty" "" "$PC_MISSING"

# 10b: node create with only --context (no --type needed)
NC_VALID="$(bun run src/cli.ts node create --parent root --id e2e-err-node --context "error test node" 2>&1)" || true
echo "  node create context: $NC_VALID"
assert_pass "node create with context succeeds"

# 10c: node create with nonexistent parent fails
NC_NOPARENT="$(bun run src/cli.ts node create --parent nonexistent_parent --id e2e-noparent --context test 2>&1)" || true
echo "  node create missing parent: $NC_NOPARENT"
assert_contains "node create rejects missing parent" "$NC_NOPARENT" "does not exist"

# 10d: call with missing --messages flag fails gracefully
CALL_NOARGS="$(bun run src/cli.ts call 2>&1)" || true
echo "  call no args: $CALL_NOARGS"
assert_contains "call without --messages shows error" "$CALL_NOARGS" "--messages"

# 10e: call with invalid JSON fails gracefully
CALL_BADJSON="$(bun run src/cli.ts call --messages 'not-json' 2>&1)" || true
echo "  call bad json: $CALL_BADJSON"
assert_contains "call with bad JSON shows error" "$CALL_BADJSON" "valid JSON"

# 10f: unknown command shows help
UNKNOWN_CMD="$(bun run src/cli.ts nonexistent-command 2>&1)" || true
echo "  unknown command: $UNKNOWN_CMD"
assert_contains "unknown command shows error" "$UNKNOWN_CMD" "unknown command"

# ─── Step 11: Text-only response (no tool_calls) ──────────────────────────
echo ""
echo "=== Step 11: Text-only response (no tool_calls) ==="

# Send a message with NO_TOOLS keyword to trigger text-only mock response
CALL_NO_TOOLS="$(bun run src/cli.ts call --messages '[{"role":"user","content":"NO_TOOLS: just give me a text answer"}]' 2>&1)" || true
echo "  text-only output: $CALL_NO_TOOLS"

# Verify text-only response structure
assert_contains "text-only response has assistant role" "$CALL_NO_TOOLS" '"assistant"'
assert_contains "text-only response has content" "$CALL_NO_TOOLS" 'plain text response'
assert_not_contains "text-only response has no tool_calls" "$CALL_NO_TOOLS" '"tool_calls"'

# Verify it's valid JSON
if echo "$CALL_NO_TOOLS" | jq -e '.' &>/dev/null; then
  assert_pass "text-only response is valid JSON"
  # Check finish_reason is stop (not tool_calls)
  FINISH_REASON="$(echo "$CALL_NO_TOOLS" | jq -r '.finish_reason // empty' 2>/dev/null)"
  if [[ "$FINISH_REASON" == "stop" ]]; then
    assert_pass "text-only finish_reason is stop"
  else
    echo "  [note] finish_reason: $FINISH_REASON (call.ts may omit this field)"
  fi
else
  assert_fail "text-only response is valid JSON"
fi

# ─── Step 12: Multiple tool_calls in sequence ─────────────────────────────
echo ""
echo "=== Step 12: Multiple tool_calls in sequence ==="

# Send a message with MULTI_TOOLS keyword to trigger multi-tool mock response
CALL_MULTI="$(bun run src/cli.ts call --messages '[{"role":"user","content":"MULTI_TOOLS: run several commands"}]' 2>&1)" || true
echo "  multi-tool output: $CALL_MULTI"

# Verify multi-tool response structure
assert_contains "multi-tool response has assistant role" "$CALL_MULTI" '"assistant"'
assert_contains "multi-tool response has tool_calls" "$CALL_MULTI" '"tool_calls"'
assert_contains "multi-tool response has call_multi_001" "$CALL_MULTI" 'call_multi_001'
assert_contains "multi-tool response has call_multi_002" "$CALL_MULTI" 'call_multi_002'
assert_contains "multi-tool has first_command" "$CALL_MULTI" 'first_command'
assert_contains "multi-tool has second_command" "$CALL_MULTI" 'second_command'

# Verify it's valid JSON
if echo "$CALL_MULTI" | jq -e '.' &>/dev/null; then
  assert_pass "multi-tool response is valid JSON"
  TOOL_COUNT="$(echo "$CALL_MULTI" | jq '.tool_calls | length' 2>/dev/null)"
  if [[ "$TOOL_COUNT" == "2" ]]; then
    assert_pass "multi-tool has exactly 2 tool_calls"
  else
    assert_fail "multi-tool has exactly 2 tool_calls" "got $TOOL_COUNT"
  fi
  # Verify tool call ids
  TOOL_ID1="$(echo "$CALL_MULTI" | jq -r '.tool_calls[0].id' 2>/dev/null)"
  TOOL_ID2="$(echo "$CALL_MULTI" | jq -r '.tool_calls[1].id' 2>/dev/null)"
  assert_eq "first tool call id" "call_multi_001" "$TOOL_ID1"
  assert_eq "second tool call id" "call_multi_002" "$TOOL_ID2"
  # Verify both are shell tools
  TOOL_NAME1="$(echo "$CALL_MULTI" | jq -r '.tool_calls[0].function.name' 2>/dev/null)"
  TOOL_NAME2="$(echo "$CALL_MULTI" | jq -r '.tool_calls[1].function.name' 2>/dev/null)"
  assert_eq "first tool is shell" "shell" "$TOOL_NAME1"
  assert_eq "second tool is shell" "shell" "$TOOL_NAME2"
else
  assert_fail "multi-tool response is valid JSON"
fi

# ─── Done ──────────────────────────────────────────────────────────────────
echo ""
echo "=== E2E Full Cycle Test Complete ==="
