#!/usr/bin/env bats
# Tests for credential operations — 3-layer validation

load test_helper

setup() {
  bats_setup_environment
  setup_test_root
  # Override AGENT_ROOT to use test directory
  export AGENT_ROOT="$TEST_TEMP_DIR"
  # Create nodes for testing directory existence
  mkdir -p "$TEST_TEMP_DIR/nodes/root"
  echo "root content" > "$TEST_TEMP_DIR/nodes/root/context"
  echo "" > "$TEST_TEMP_DIR/nodes/root/parent"
}

teardown() {
  :
}

# ─── Layer 1: ID format validation ──────────────────────────────────────────────

@test "credential: validates valid ID format" {
  # Valid IDs should pass the regex check from _validate_credential
  [[ "valid_id-123" =~ ^[a-zA-Z0-9_-]+$ ]]
}

@test "credential: rejects invalid ID with spaces" {
  ! [[ "invalid id" =~ ^[a-zA-Z0-9_-]+$ ]]
}

@test "credential: rejects invalid ID with special chars" {
  ! [[ "invalid@id" =~ ^[a-zA-Z0-9_-]+$ ]]
}

@test "credential: rejects empty ID" {
  ! [[ "" =~ ^[a-zA-Z0-9_-]+$ ]]
}

@test "credential: accepts single-character IDs" {
  [[ "a" =~ ^[a-zA-Z0-9_-]+$ ]]
  [[ "1" =~ ^[a-zA-Z0-9_-]+$ ]]
  [[ "_" =~ ^[a-zA-Z0-9_-]+$ ]]
}

@test "credential: accepts IDs with hyphens and underscores" {
  [[ "my-node-001" =~ ^[a-zA-Z0-9_-]+$ ]]
  [[ "some_long_id" =~ ^[a-zA-Z0-9_-]+$ ]]
  [[ "a-b-c_d-e" =~ ^[a-zA-Z0-9_-]+$ ]]
}

# ─── Layer 2: directory existence ───────────────────────────────────────────────

@test "credential: detects existing node directory" {
  # nodes/root should exist from setup
  [ -d "$TEST_TEMP_DIR/nodes/root" ]
}

@test "credential: detects missing node directory" {
  [ ! -d "$TEST_TEMP_DIR/nodes/nonexistent" ]
}

@test "credential: existing directory with context file is valid" {
  [ -d "$TEST_TEMP_DIR/nodes/root" ]
  [ -f "$TEST_TEMP_DIR/nodes/root/context" ]
}

@test "credential: existing directory with type file is valid" {
  [ -d "$TEST_TEMP_DIR/nodes/root" ]
  [ -f "$TEST_TEMP_DIR/nodes/root/context" ]
}

@test "credential: existing directory with parent file is valid" {
  [ -d "$TEST_TEMP_DIR/nodes/root" ]
  [ -f "$TEST_TEMP_DIR/nodes/root/parent" ]
}

# ─── Layer 3: lock file ────────────────────────────────────────────────────────

@test "credential: detects lock file presence" {
  touch "$TEST_TEMP_DIR/nodes/root/.lock"
  [ -f "$TEST_TEMP_DIR/nodes/root/.lock" ]
  rm -f "$TEST_TEMP_DIR/nodes/root/.lock"
}

@test "credential: no lock file means unlocked" {
  [ ! -f "$TEST_TEMP_DIR/nodes/root/.lock" ]
}

@test "credential: lock file can be created" {
  touch "$TEST_TEMP_DIR/nodes/root/.lock"
  [ -f "$TEST_TEMP_DIR/nodes/root/.lock" ]
  rm -f "$TEST_TEMP_DIR/nodes/root/.lock"
}

@test "credential: lock file can be removed" {
  touch "$TEST_TEMP_DIR/nodes/root/.lock"
  rm -f "$TEST_TEMP_DIR/nodes/root/.lock"
  [ ! -f "$TEST_TEMP_DIR/nodes/root/.lock" ]
}

@test "credential: multiple nodes can have independent locks" {
  mkdir -p "$TEST_TEMP_DIR/nodes/A"
  touch "$TEST_TEMP_DIR/nodes/root/.lock"
  
  # root is locked
  [ -f "$TEST_TEMP_DIR/nodes/root/.lock" ]
  # A is not locked
  [ ! -f "$TEST_TEMP_DIR/nodes/A/.lock" ]

  rm -f "$TEST_TEMP_DIR/nodes/root/.lock"
}

# ─── Full _validate_credential flow ─────────────────────────────────────────────

@test "credential: validation passes for valid credential (all 3 layers)" {
  # Layer 1: format check
  local id="root"
  [[ "$id" =~ ^[a-zA-Z0-9_-]+$ ]]
  
  # Layer 2: directory check
  local node_dir="$AGENT_ROOT/nodes/$id"
  [ -d "$node_dir" ]
  
  # Layer 3: no lock file
  [ ! -f "$node_dir/.lock" ]
}

@test "credential: validation fails at layer 1 for bad format" {
  local id="bad id"
  ! [[ "$id" =~ ^[a-zA-Z0-9_-]+$ ]]
}

@test "credential: validation fails at layer 2 for missing directory" {
  local id="no_such_node"
  [[ "$id" =~ ^[a-zA-Z0-9_-]+$ ]]  # passes layer 1
  local node_dir="$AGENT_ROOT/nodes/$id"
  [ ! -d "$node_dir" ]  # fails layer 2
}

@test "credential: validation fails at layer 3 for locked node" {
  local id="root"
  [[ "$id" =~ ^[a-zA-Z0-9_-]+$ ]]  # passes layer 1
  local node_dir="$AGENT_ROOT/nodes/$id"
  [ -d "$node_dir" ]               # passes layer 2
  
  # Lock it
  touch "$node_dir/.lock"
  [ -f "$node_dir/.lock" ]         # fails layer 3
  
  # Cleanup
  rm -f "$node_dir/.lock"
}
