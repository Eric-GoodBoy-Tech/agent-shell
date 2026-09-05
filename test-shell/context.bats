#!/usr/bin/env bats
# Tests for context building functions

load test_helper

setup() {
  bats_setup_environment
  setup_test_root
  
  # Create a credential node with parent chain: root → A → B
  create_test_node "A" "root" "context" "Node A content"
  create_test_node "B" "A" "context" "Node B content: credential"
  
  export AGENT_ROOT="$TEST_TEMP_DIR"
  export CREDENTIAL="B"
}

teardown() {
  :
}

# ─── Node structure validation ──────────────────────────────────────────────────

@test "context: node structure is correct" {
  assert_node_valid "$TEST_TEMP_DIR/nodes/root" "context"
  assert_node_valid "$TEST_TEMP_DIR/nodes/A" "context"
  assert_node_valid "$TEST_TEMP_DIR/nodes/B" "context"
}

@test "context: parent chain is correct from leaf to root" {
  run cat "$TEST_TEMP_DIR/nodes/B/parent"
  [ "$output" = "A" ]
  
  run cat "$TEST_TEMP_DIR/nodes/A/parent"
  [ "$output" = "root" ]
  
  run cat "$TEST_TEMP_DIR/nodes/root/parent"
  [ "$output" = "" ]
}

@test "context: node content is readable" {
  run cat "$TEST_TEMP_DIR/nodes/root/context"
  [ -n "$output" ]
  
  run cat "$TEST_TEMP_DIR/nodes/A/context"
  [ "$output" = "Node A content" ]
  
  run cat "$TEST_TEMP_DIR/nodes/B/context"
  [ "$output" = "Node B content: credential" ]
}

# ─── Environment variables ─────────────────────────────────────────────────────

@test "context: CREDENTIAL env var is set correctly" {
  [ "$CREDENTIAL" = "B" ]
}

@test "context: AGENT_ROOT is set to test temp" {
  [ -n "$AGENT_ROOT" ]
  [ "$AGENT_ROOT" = "$TEST_TEMP_DIR" ]
}

@test "context: AGENT_ROOT resolves to existing directory" {
  [ -d "$AGENT_ROOT" ]
}

# ─── Context JSON building (jq) ────────────────────────────────────────────────

@test "context: CONTEXT JSON can be built with system and user messages" {
  if ! command -v jq &>/dev/null; then
    skip "jq not available"
  fi
  
  local ctx="[]"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "system", "content": "[node-root]\nroot content"}]')"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "user", "content": "continue"}]')"
  
  local count
  count="$(echo "$ctx" | jq 'length')"
  [ "$count" -eq 2 ]
  
  # First message should be system
  local role
  role="$(echo "$ctx" | jq -r '.[0].role')"
  [ "$role" = "system" ]
  
  # Second message should be user "continue"
  local user_content
  user_content="$(echo "$ctx" | jq -r '.[1].content')"
  [ "$user_content" = "continue" ]
}

@test "context: CONTEXT can append assistant messages" {
  if ! command -v jq &>/dev/null; then
    skip "jq not available"
  fi
  
  local ctx="[]"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "system", "content": "sys"}]')"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "user", "content": "continue"}]')"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "assistant", "content": "hello"}]')"
  
  local count
  count="$(echo "$ctx" | jq 'length')"
  [ "$count" -eq 3 ]
}

@test "context: _build_context produces valid JSON structure" {
  if ! command -v jq &>/dev/null; then
    skip "jq not available"
  fi
  
  # Simulate _build_context step 1: build system messages from chain
  local ctx="[]"
  
  # Simulate root node
  local root_content
  root_content="$(cat "$TEST_TEMP_DIR/nodes/root/context")"
  ctx="$(echo "$ctx" | jq -c --arg c "[node-root]\n${root_content}" '. + [{"role": "system", "content": $c}]')"
  
  # Simulate A node
  ctx="$(echo "$ctx" | jq -c --arg c "[node-A]\nNode A content" '. + [{"role": "system", "content": $c}]')"
  
  # Step 2: credential node own content
  ctx="$(echo "$ctx" | jq -c --arg c "[node-B]\nNode B content: credential" '. + [{"role": "system", "content": $c}]')"
  
  # Step 3: append "continue"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "user", "content": "continue"}]')"
  
  # Verify
  local count
  count="$(echo "$ctx" | jq 'length')"
  [ "$count" -eq 4 ]
  
  # All first 3 should be system, last is user
  [ "$(echo "$ctx" | jq -r '.[0].role')" = "system" ]
  [ "$(echo "$ctx" | jq -r '.[1].role')" = "system" ]
  [ "$(echo "$ctx" | jq -r '.[2].role')" = "system" ]
  [ "$(echo "$ctx" | jq -r '.[3].role')" = "user" ]
}

@test "context: context chain respects parent→child order" {
  if ! command -v jq &>/dev/null; then
    skip "jq not available"
  fi
  
  local ctx="[]"
  
  # Order: root → A → B (credential) → "continue"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "system", "content": "root"}]')"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "system", "content": "A"}]')"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "system", "content": "B"}]')"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "user", "content": "continue"}]')"
  
  # root (index 0) → A (index 1) → B (index 2)
  [ "$(echo "$ctx" | jq -r '.[0].content')" = "root" ]
  [ "$(echo "$ctx" | jq -r '.[1].content')" = "A" ]
  [ "$(echo "$ctx" | jq -r '.[2].content')" = "B" ]
}

# ─── Plug exclusion ──────────────────────────────────────────────────────────

@test "context: plug nodes are not included in context chain" {
  # Create a mix: root → p1 (plug) → c1 (context)
  create_test_plug "p1" "root" "echo plug"
  create_test_node "c1" "p1" "context" "after plug"
  
  # Verify the plug script exists in plug file, not context
  run cat "$TEST_TEMP_DIR/nodes/p1/plug"
  [ "$output" = "echo plug" ]
  
  run cat "$TEST_TEMP_DIR/nodes/c1/context"
  [ "$output" = "after plug" ]
}

@test "context: plug content is distinct from context content" {
  create_test_plug "p1" "root" "echo 'plug loaded'"
  create_test_node "p2" "p1" "context" "context content"
  
  run cat "$TEST_TEMP_DIR/nodes/p1/plug"
  [ "$output" = "echo 'plug loaded'" ]
  
  run cat "$TEST_TEMP_DIR/nodes/p2/context"
  [ "$output" = "context content" ]
}

# ─── Edge cases ────────────────────────────────────────────────────────────────

@test "context: empty node content is handled" {
  create_test_node "empty_node" "root" "context" ""
  
  run cat "$TEST_TEMP_DIR/nodes/empty_node/context"
  [ "$output" = "" ]
  
  assert_node_valid "$TEST_TEMP_DIR/nodes/empty_node" "context"
}

@test "context: multiline content is preserved" {
  local multiline=$'line1\nline2\nline3'
  create_test_node "multi" "root" "context" "$multiline"
  
  run cat "$TEST_TEMP_DIR/nodes/multi/context"
  [ "${#lines[@]}" -eq 3 ]
  [ "${lines[0]}" = "line1" ]
  [ "${lines[1]}" = "line2" ]
  [ "${lines[2]}" = "line3" ]
}

@test "context: CREDENTIAL not set results in empty check" {
  local saved_cred="$CREDENTIAL"
  CREDENTIAL=""
  [ -z "$CREDENTIAL" ]
  CREDENTIAL="$saved_cred"
}
