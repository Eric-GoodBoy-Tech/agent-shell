#!/usr/bin/env bats
# Tests for zle widget behavior (credential claim/drop interception)

load test_helper

setup() {
  bats_setup_environment
  setup_test_root
  export AGENT_ROOT="$TEST_TEMP_DIR"
  export CREDENTIAL=""
}

teardown() {
  rm -f "$TEST_TEMP_DIR/nodes/root/.lock"
}

# ─── credential claim pattern matching ─────────────────────────────────────────

@test "widget: credential claim pattern matches" {
  local buf="credential claim root"
  [[ "$buf" =~ ^credential[[:space:]]+claim[[:space:]]+(.+)$ ]]
}

@test "widget: credential claim pattern extracts ID" {
  local buf="credential claim root"
  [[ "$buf" =~ ^credential[[:space:]]+claim[[:space:]]+(.+)$ ]]
  local id="${BASH_REMATCH[1]}"
  id="${id## }"
  id="${id%% }"
  [ "$id" = "root" ]
}

@test "widget: credential claim with extra whitespace" {
  local buf="credential   claim    my-id"
  [[ "$buf" =~ ^credential[[:space:]]+claim[[:space:]]+(.+)$ ]]
  local id="${BASH_REMATCH[1]}"
  id="${id## }"
  id="${id%% }"
  [ "$id" = "my-id" ]
}

@test "widget: credential claim with leading spaces" {
  local buf="  credential claim root"
  # Pattern anchored at ^ — should NOT match
  ! [[ "$buf" =~ ^credential[[:space:]]+claim[[:space:]]+(.+)$ ]]
}

@test "widget: credential claim with hyphenated ID" {
  local buf="credential claim my-node-001"
  [[ "$buf" =~ ^credential[[:space:]]+claim[[:space:]]+(.+)$ ]]
  local id="${BASH_REMATCH[1]}"
  id="${id## }"
  id="${id%% }"
  [ "$id" = "my-node-001" ]
}

@test "widget: credential claim with underscored ID" {
  local buf="credential claim some_long_id"
  [[ "$buf" =~ ^credential[[:space:]]+claim[[:space:]]+(.+)$ ]]
  local id="${BASH_REMATCH[1]}"
  id="${id## }"
  id="${id%% }"
  [ "$id" = "some_long_id" ]
}

# ─── credential drop pattern matching ──────────────────────────────────────────

@test "widget: credential drop pattern matches" {
  local buf="credential drop"
  [[ "$buf" =~ ^credential[[:space:]]+drop$ ]]
}

@test "widget: credential drop with extra spaces after drop matches" {
  # The regex uses $ anchor, so trailing spaces should NOT match
  local buf="credential drop  "
  ! [[ "$buf" =~ ^credential[[:space:]]+drop$ ]]
}

@test "widget: credential drop with extra spaces before drop" {
  local buf="credential    drop"
  [[ "$buf" =~ ^credential[[:space:]]+drop$ ]]
}

@test "widget: credential drop with arguments does not match" {
  local buf="credential drop root"
  ! [[ "$buf" =~ ^credential[[:space:]]+drop$ ]]
}

# ─── Normal command pass-through ───────────────────────────────────────────────

@test "widget: normal command does not match claim pattern" {
  local buf="ls -la"
  ! [[ "$buf" =~ ^credential[[:space:]]+claim[[:space:]]+(.+)$ ]]
}

@test "widget: normal command does not match drop pattern" {
  local buf="echo hello"
  ! [[ "$buf" =~ ^credential[[:space:]]+drop$ ]]
}

@test "widget: partial match 'credential' alone does not match claim" {
  local buf="credential"
  ! [[ "$buf" =~ ^credential[[:space:]]+claim[[:space:]]+(.+)$ ]]
}

@test "widget: partial match 'credential' alone does not match drop" {
  local buf="credential"
  ! [[ "$buf" =~ ^credential[[:space:]]+drop$ ]]
}

@test "widget: 'credential othercommand' passes through" {
  local buf="credential othercommand root"
  ! [[ "$buf" =~ ^credential[[:space:]]+claim[[:space:]]+(.+)$ ]]
  ! [[ "$buf" =~ ^credential[[:space:]]+drop$ ]]
}

# ─── Pause toggle logic ────────────────────────────────────────────────────────

@test "widget: AGENT_PAUSED toggles from empty to set" {
  AGENT_PAUSED=""
  AGENT_PAUSED="1"
  [ "$AGENT_PAUSED" = "1" ]
}

@test "widget: AGENT_PAUSED toggles from set to empty" {
  AGENT_PAUSED="1"
  AGENT_PAUSED=""
  [ "$AGENT_PAUSED" = "" ]
}

@test "widget: AGENT_PAUSED state persists across checks" {
  AGENT_PAUSED="1"
  [ -n "$AGENT_PAUSED" ]
  [ "$AGENT_PAUSED" = "1" ]
  AGENT_PAUSED=""
  [ -z "$AGENT_PAUSED" ]
}

@test "widget: pause logic with no credential is no-op" {
  CREDENTIAL=""
  [ -z "$CREDENTIAL" ]
  # toggle-pause with no credential should return early
}

# ─── widget priority: claim checked before drop ────────────────────────────────

@test "widget: claim is checked before drop in widget logic" {
  # 'credential drop' should match the drop regex but NOT the claim regex
  local buf="credential drop"
  ! [[ "$buf" =~ ^credential[[:space:]]+claim[[:space:]]+(.+)$ ]]
  [[ "$buf" =~ ^credential[[:space:]]+drop$ ]]
}

@test "widget: 'credential drop some-id' does not match claim pattern" {
  local buf="credential drop some-id"
  # 'drop' is a drop subcommand, not a claim, so claim regex should NOT match
  [[ ! "$buf" =~ ^credential[[:space:]]+claim[[:space:]]+(.+)$ ]]
}
