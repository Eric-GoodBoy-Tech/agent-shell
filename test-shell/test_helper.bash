#!/usr/bin/env bash
# Test helper for bats-based Shell layer tests.
# Source in each .bats file: load "test_helper"

# Each .bats file MUST call bats_setup_environment in its setup() && setup_test_root
# before using create_test_node / assert_node_valid.

bats_setup_environment() {
  # Save original environment
  export ORIGINAL_PATH="$PATH"
  export ORIGINAL_HOME="${HOME:-}"
  
  # Create a temporary test directory
  TEST_TEMP_DIR="$(mktemp -d)"
  export TEST_TEMP_DIR
  
  # Set up test nodes directory
  TEST_NODES_DIR="$TEST_TEMP_DIR/nodes"
  mkdir -p "$TEST_NODES_DIR"
  
  # Path to agent.zsh (relative to test-shell/)
  AGENT_ZS="${BATS_TEST_DIRNAME}/../agent.zsh"
  
  # jq is mandatory for shell tests
  if ! command -v jq &>/dev/null; then
    echo "ERROR: jq is required for shell tests" >&2
    return 1
  fi
}

teardown() {
  # Clean up temp directory
  if [[ -n "${TEST_TEMP_DIR:-}" ]] && [[ -d "$TEST_TEMP_DIR" ]]; then
    rm -rf "$TEST_TEMP_DIR"
  fi
  
  # Restore original environment
  export PATH="$ORIGINAL_PATH"
  export HOME="$ORIGINAL_HOME"
}

# Mock: create a test node in the test nodes directory
create_test_node() {
  local id="$1"
  local parent="${2:-}"
  local type="${3:-context}"
  local content="${4-test content for $id}"
  
  local node_dir="$TEST_NODES_DIR/$id"
  mkdir -p "$node_dir"
  printf '%s' "$content" > "$node_dir/context"
  printf '%s' "$parent" > "$node_dir/parent"
  }

# Mock: create a plug node (shell script capability)
create_test_plug() {
  local id="$1"
  local parent="${2:-}"
  local script="${3-echo 'plug loaded'}"
  
  local node_dir="$TEST_NODES_DIR/$id"
  mkdir -p "$node_dir"
  printf '%s' "$script" > "$node_dir/plug"
  printf '%s' "$parent" > "$node_dir/parent"
}

# Assert: check that a file contains expected text
assert_file_contains() {
  local file="$1"
  local expected="$2"
  
  if ! grep -qF "$expected" "$file"; then
    echo "Expected file $file to contain: $expected"
    echo "Actual content:"
    cat "$file"
    return 1
  fi
}

# Assert: check that a node has correct structure
assert_node_valid() {
  local node_dir="$1"
  
  [[ -f "$node_dir/context" ]] || { echo "Missing context file"; return 1; }
  [[ -f "$node_dir/parent" ]] || { echo "Missing parent file"; return 1; }
}

# Create a minimal nodes/root for testing
setup_test_root() {
  create_test_node "root" "" "context" "You are Agent Shell. Use the shell tool to execute commands."
}
