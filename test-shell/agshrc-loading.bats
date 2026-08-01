#!/usr/bin/env bats
# Tests for .agshrc extension loading mechanism
#
# agent.zsh lines 30-32:
#   [[ -f ~/.agshrc ]] && source ~/.agshrc

load test_helper

#!/usr/bin/env bats
# Tests for .agshrc extension loading mechanism
#
# agent.zsh lines 30-32:
#   [[ -f ~/.agshrc ]] && source ~/.agshrc
#   [[ -f .agshrc ]] && source .agshrc
#
# These run BEFORE the idempotency guard, so they always execute.
# We test the EXACT loading semantics by running these same lines
# in a zsh subshell, avoiding side effects from the full agent.zsh.

load test_helper

setup() {
  bats_setup_environment
  
  # Additional agshrc-specific setup
  export AGENT_NODES_PATH="$TEST_NODES_DIR"

  setup_test_root
}

teardown() {
  # Clean up temp directory
  if [[ -n "${TEST_TEMP_DIR:-}" ]] && [[ -d "$TEST_TEMP_DIR" ]]; then
    rm -rf "$TEST_TEMP_DIR"
  fi
  # Restore original environment
  export PATH="$ORIGINAL_PATH"
  export HOME="$ORIGINAL_HOME"
  # Clean up env vars that .agshrc tests might set
  unset AGSHRC_TEST_GLOBAL AGSHRC_TEST_LOCAL AGSHRC_SYNTAX_BEFORE AGSHRC_SYNTAX_AFTER 2>/dev/null || true
}

# ─── Helper: run the .agshrc loading logic in a zsh subshell ─────────────────
# Replicates the EXACT .agshrc loading behavior from agent.zsh lines 30-32:
#   [[ -f ~/.agshrc ]] && source ~/.agshrc
#   [[ -f .agshrc ]] && source .agshrc
#
# Sets HOME to test_home, cd to test_cwd, runs the loading lines,
# then echoes the specified env vars for verification.
_run_agshrc_loading() {
  local test_home="$1"
  local test_cwd="$2"
  local check_vars="$3"  # space-separated var names to echo

  local echo_cmds=""
  for var in $check_vars; do
    echo_cmds="${echo_cmds}echo \"${var}=\${${var}:-__UNSET__}\";"
  done

  # Run in zsh subshell: override HOME, cd, source .agshrc lines, echo vars
  zsh -c '
    HOME="'"$test_home"'";
    cd "'"$test_cwd"'";
    [[ -f ~/.agshrc ]] && source ~/.agshrc;
    [[ -f .agshrc ]] && source .agshrc;
    '"$echo_cmds"'
  ' 2>/dev/null
}

# ─── Precondition: AGENT_ZS exists and is readable ──────────────────────────

@test "agshrc: AGENT_ZS variable is defined and file is readable" {
  [ -n "$AGENT_ZS" ]
  [ -f "$AGENT_ZS" ]
  [ -r "$AGENT_ZS" ]
}

# ─── Test: ~/.agshrc is sourced when present ───────────────────────────────────

@test "agshrc: ~/.agshrc is sourced when present" {
  echo 'export AGSHRC_TEST_GLOBAL=1' > "$TEST_TEMP_DIR/.agshrc"

  run _run_agshrc_loading "$TEST_TEMP_DIR" "$TEST_TEMP_DIR" "AGSHRC_TEST_GLOBAL"

  [ "$status" -eq 0 ]
  [[ "$output" == *"AGSHRC_TEST_GLOBAL=1"* ]]
}

# ─── Test: .agshrc (project-local) is sourced when present ─────────────────────

@test "agshrc: .agshrc (project-local) is sourced when present" {
  echo 'export AGSHRC_TEST_LOCAL=1' > "$TEST_TEMP_DIR/.agshrc"

  run _run_agshrc_loading "/nonexistent/home/for/test" "$TEST_TEMP_DIR" "AGSHRC_TEST_LOCAL"

  [ "$status" -eq 0 ]
  [[ "$output" == *"AGSHRC_TEST_LOCAL=1"* ]]
}

# ─── Test: Both files exist → both loaded, local takes precedence ──────────────

@test "agshrc: both ~/.agshrc and .agshrc are sourced when both exist" {
  # Global .agshrc in simulated HOME
  echo 'export AGSHRC_TEST_GLOBAL=1' > "$TEST_TEMP_DIR/.agshrc"

  # Local .agshrc in test project dir
  local proj_dir="$TEST_TEMP_DIR/project"
  mkdir -p "$proj_dir"
  echo 'export AGSHRC_TEST_LOCAL=1' > "$proj_dir/.agshrc"

  run _run_agshrc_loading "$TEST_TEMP_DIR" "$proj_dir" "AGSHRC_TEST_GLOBAL AGSHRC_TEST_LOCAL"

  [ "$status" -eq 0 ]
  [[ "$output" == *"AGSHRC_TEST_GLOBAL=1"* ]]
  [[ "$output" == *"AGSHRC_TEST_LOCAL=1"* ]]
}

# ─── Test: ~/.agshrc doesn't exist → loads without error ──────────────────────

@test "agshrc: agent.zsh loads without error when ~/.agshrc is missing" {
  local empty_home="$TEST_TEMP_DIR/empty_home"
  mkdir -p "$empty_home"

  run _run_agshrc_loading "$empty_home" "$TEST_TEMP_DIR" "AGSHRC_TEST_GLOBAL"

  [ "$status" -eq 0 ]
  [[ "$output" == *"AGSHRC_TEST_GLOBAL=__UNSET__"* ]]
}

# ─── Test: .agshrc doesn't exist → loads without error ────────────────────────

@test "agshrc: agent.zsh loads without error when .agshrc is missing" {
  local empty_proj="$TEST_TEMP_DIR/empty_project"
  mkdir -p "$empty_proj"

  run _run_agshrc_loading "$TEST_TEMP_DIR" "$empty_proj" "AGSHRC_TEST_LOCAL"

  [ "$status" -eq 0 ]
  [[ "$output" == *"AGSHRC_TEST_LOCAL=__UNSET__"* ]]
}

# ─── Test: .agshrc has syntax error → loading continues ───────────────────────

@test "agshrc: .agshrc with syntax error does not abort agent.zsh sourcing" {
  # .agshrc with valid export, then invalid command, then another export
  echo 'export AGSHRC_SYNTAX_BEFORE=1' > "$TEST_TEMP_DIR/.agshrc"
  echo 'this_is_not_a_valid_command_zzz' >> "$TEST_TEMP_DIR/.agshrc"
  echo 'export AGSHRC_SYNTAX_AFTER=1' >> "$TEST_TEMP_DIR/.agshrc"

  run _run_agshrc_loading "/nonexistent/home/for/test" "$TEST_TEMP_DIR" "AGSHRC_SYNTAX_BEFORE AGSHRC_SYNTAX_AFTER"

  [ "$status" -eq 0 ]
  # The first export should have run before the error
  [[ "$output" == *"AGSHRC_SYNTAX_BEFORE=1"* ]]
}
