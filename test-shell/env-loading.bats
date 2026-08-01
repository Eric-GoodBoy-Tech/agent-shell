#!/usr/bin/env bats
# Tests for .env loading with fill-gap semantics
#
# agent.zsh lines 25-33:
#   if [[ -f "$AGENT_ROOT/.env" ]]; then
#     while IFS='=' read -r key value; do
#       [[ -z "$key" || "$key" == \#* ]] && continue
#       key="${key%%[[:space:]]*}"
#       : ${(P)key:="$value"}
#       export "$key"
#     done < "$AGENT_ROOT/.env"
#   fi
#
# These tests run the EXACT same logic in a zsh subshell.

load test_helper

setup() {
  bats_setup_environment
  setup_test_root
}

teardown() {
  if [[ -n "${TEST_TEMP_DIR:-}" ]] && [[ -d "$TEST_TEMP_DIR" ]]; then
    rm -rf "$TEST_TEMP_DIR"
  fi
  export PATH="$ORIGINAL_PATH"
  export HOME="$ORIGINAL_HOME"
}

# ─── Helper: run the .env loading logic in zsh subshell ────────────────

_run_env_loading() {
  local env_file="$1"
  local pre_export="$2"   # optional: "KEY=val" to export before loading
  local check_vars="$3"   # space-separated var names to echo after loading

  local pre_cmd=""
  if [[ -n "$pre_export" ]]; then
    pre_cmd="export ${pre_export};"
  fi

  local echo_cmds=""
  for var in $check_vars; do
    echo_cmds="${echo_cmds}echo \"${var}=\${${var}:-__UNSET__}\";"
  done

  zsh -c '
    '"$pre_cmd"'
    if [[ -f "'"$env_file"'" ]]; then
      while IFS="=" read -r key value; do
        [[ -z "$key" || "$key" == \#* ]] && continue
        key="${key%%[[:space:]]*}"
        : ${(P)key:="$value"}
        export "$key"
      done < "'"$env_file"'"
    fi
    '"$echo_cmds"'
  ' 2>/dev/null
}

# ─── Test: values from .env are loaded when unset ──────────────────────

@test "env: loads values when variables are not already set" {
  local env_file="$TEST_TEMP_DIR/.env"
  echo 'ENV_TEST_FOO=hello' > "$env_file"
  echo 'ENV_TEST_BAR=world' >> "$env_file"

  run _run_env_loading "$env_file" "" "ENV_TEST_FOO ENV_TEST_BAR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"ENV_TEST_FOO=hello"* ]]
  [[ "$output" == *"ENV_TEST_BAR=world"* ]]
}

# ─── Test: existing env vars are NOT overwritten (fill-gap) ────────────

@test "env: does not overwrite already-set environment variables" {
  local env_file="$TEST_TEMP_DIR/.env"
  echo 'ENV_TEST_OVERRIDE=from_env' > "$env_file"

  run _run_env_loading "$env_file" "ENV_TEST_OVERRIDE=already_set" "ENV_TEST_OVERRIDE"

  [ "$status" -eq 0 ]
  [[ "$output" == *"ENV_TEST_OVERRIDE=already_set"* ]]
}

# ─── Test: comment lines are skipped ───────────────────────────────────

@test "env: skips comment lines" {
  local env_file="$TEST_TEMP_DIR/.env"
  echo '# this is a comment' > "$env_file"
  echo 'ENV_TEST_COMMENT_SKIP=loaded' >> "$env_file"

  run _run_env_loading "$env_file" "" "ENV_TEST_COMMENT_SKIP"

  [ "$status" -eq 0 ]
  [[ "$output" == *"ENV_TEST_COMMENT_SKIP=loaded"* ]]
  # The comment line should not produce any variable
  [[ "$output" != *"#"* ]]
}

# ─── Test: empty lines are skipped ─────────────────────────────────────

@test "env: skips empty lines" {
  local env_file="$TEST_TEMP_DIR/.env"
  echo '' > "$env_file"
  echo 'ENV_TEST_EMPTY_SKIP=loaded' >> "$env_file"

  run _run_env_loading "$env_file" "" "ENV_TEST_EMPTY_SKIP"

  [ "$status" -eq 0 ]
  [[ "$output" == *"ENV_TEST_EMPTY_SKIP=loaded"* ]]
}

# ─── Test: values containing = are handled correctly ───────────────────

@test "env: handles values containing equals signs" {
  local env_file="$TEST_TEMP_DIR/.env"
  echo 'ENV_TEST_EQ=foo=bar=baz' > "$env_file"

  run _run_env_loading "$env_file" "" "ENV_TEST_EQ"

  [ "$status" -eq 0 ]
  [[ "$output" == *"ENV_TEST_EQ=foo=bar=baz"* ]]
}

# ─── Test: .env file does not exist → no error ─────────────────────────

@test "env: missing .env file does not cause error" {
  local env_file="$TEST_TEMP_DIR/nonexistent/.env"

  run _run_env_loading "$env_file" "" "ENV_TEST_MISSING"

  [ "$status" -eq 0 ]
  [[ "$output" == *"ENV_TEST_MISSING=__UNSET__"* ]]
}

# ─── Test: priority: env var > .env (the core fix) ─────────────────────

@test "env: existing environment variable takes priority over .env" {
  local env_file="$TEST_TEMP_DIR/.env"
  echo 'AGENT_MODEL=from_env' > "$env_file"
  echo 'AGENT_DEBUG=true' >> "$env_file"

  run _run_env_loading "$env_file" "AGENT_MODEL=custom_model AGENT_DEBUG=false" "AGENT_MODEL AGENT_DEBUG"

  [ "$status" -eq 0 ]
  [[ "$output" == *"AGENT_MODEL=custom_model"* ]]
  [[ "$output" == *"AGENT_DEBUG=false"* ]]
}
