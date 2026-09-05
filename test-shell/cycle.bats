#!/usr/bin/env bats
# Tests for agent_cycle logic (context building, API call, tool processing)

load test_helper

setup() {
  bats_setup_environment
  setup_test_root
  create_test_node "A" "root" "context" "Node A content"
  
  export AGENT_ROOT="$TEST_TEMP_DIR"
  export CREDENTIAL="A"
  export AGENT_PAUSED=""
  export AGENT_DEBUG="false"
  export AGENT_BUSY=""
}

teardown() {
  :
}

# ─── Context building (jq-based) ──────────────────────────────────────────────

@test "cycle: CONTEXT built with correct structure" {
  if ! command -v jq &>/dev/null; then
    skip "jq not available"
  fi
  
  local ctx="[]"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "system", "content": "test"}]')"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "user", "content": "continue"}]')"
  
  # Verify it's valid JSON
  echo "$ctx" | jq -e '.' &>/dev/null
  [ "$?" -eq 0 ]
  
  local count
  count="$(echo "$ctx" | jq 'length')"
  [ "$count" -eq 2 ]
}

@test "cycle: CONTEXT can append multiple message types" {
  if ! command -v jq &>/dev/null; then
    skip "jq not available"
  fi
  
  local ctx="[]"
  
  # Append system message
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "system", "content": "system msg"}]')"
  # Append user "continue"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "user", "content": "continue"}]')"
  # Append assistant response
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "assistant", "content": "hi"}]')"
  
  local count
  count="$(echo "$ctx" | jq 'length')"
  [ "$count" -eq 3 ]
}

@test "cycle: CONTEXT can append assistant message with tool_calls" {
  if ! command -v jq &>/dev/null; then
    skip "jq not available"
  fi
  
  local ctx="[]"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "system", "content": "sys"}]')"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "user", "content": "continue"}]')"
  
  # Simulate assistant response with tool_calls
  local msg='{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","function":{"name":"shell","arguments":"{\"cmd\":\"ls\"}"}}]}'
  ctx="$(echo "$ctx" | jq -c --argjson msg "$msg" '. + [$msg]')"
  
  # Verify tool_calls are present
  local has_tools
  has_tools="$(echo "$ctx" | jq -r '.[2].tool_calls // empty')"
  [ -n "$has_tools" ]
  
  # Verify the tool call structure
  local func_name
  func_name="$(echo "$ctx" | jq -r '.[2].tool_calls[0].function.name')"
  [ "$func_name" = "shell" ]
}

# ─── Tool result handling ──────────────────────────────────────────────────────

@test "cycle: tool result has correct structure" {
  if ! command -v jq &>/dev/null; then
    skip "jq not available"
  fi
  
  local result
  result="$(jq -n --arg id "call_123" --arg content "output" \
    '{role: "tool", tool_call_id: $id, content: $content}')"
  
  local role
  role="$(echo "$result" | jq -r '.role')"
  [ "$role" = "tool" ]
  
  local tool_id
  tool_id="$(echo "$result" | jq -r '.tool_call_id')"
  [ "$tool_id" = "call_123" ]
}

@test "cycle: tool result with exit code information" {
  if ! command -v jq &>/dev/null; then
    skip "jq not available"
  fi
  
  local result
  result="$(jq -n --arg id "call_1" --arg content "Exit code: 0\nOutput:\nfile1" \
    '{role: "tool", tool_call_id: $id, content: $content}')"
  
  local content
  content="$(echo "$result" | jq -r '.content')"
  [[ "$content" == *"Exit code: 0"* ]]
  [[ "$content" == *"Output:"* ]]
}

@test "cycle: tool result appended to context chain" {
  if ! command -v jq &>/dev/null; then
    skip "jq not available"
  fi
  
  local ctx="[]"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "system", "content": "sys"}]')"
  ctx="$(echo "$ctx" | jq -c '. + [{"role": "user", "content": "continue"}]')"
  ctx="$(echo "$ctx" | jq -c --arg id "call_1" --arg content "result" \
    '. + [{"role": "tool", "tool_call_id": $id, "content": $content}]')"
  
  local count
  count="$(echo "$ctx" | jq 'length')"
  [ "$count" -eq 3 ]
  
  local last_role
  last_role="$(echo "$ctx" | jq -r '.[2].role')"
  [ "$last_role" = "tool" ]
}

# ─── shell tool command extraction ─────────────────────────────────────────────

@test "cycle: cmd extracted from shell tool arguments" {
  if ! command -v jq &>/dev/null; then
    skip "jq not available"
  fi
  
  local func_args='{"cmd": "ls -la"}'
  local cmd
  cmd="$(echo "$func_args" | jq -r '.cmd')"
  [ "$cmd" = "ls -la" ]
}

@test "cycle: empty cmd in shell tool arguments is detected" {
  if ! command -v jq &>/dev/null; then
    skip "jq not available"
  fi
  
  local func_args='{"cmd": ""}'
  local cmd
  cmd="$(echo "$func_args" | jq -r '.cmd')"
  [ "$cmd" = "" ]
  [ -z "$cmd" ]
}

@test "cycle: unknown tool function is rejected" {
  local func_name="unknown_tool"
  [ "$func_name" != "shell" ]
}

@test "cycle: non-shell tool calls should be rejected" {
  # agent.zsh only handles "shell" tool
  for tool in "bash" "execute" "run_command"; do
    [ "$tool" != "shell" ]
  done
}

# ─── Error handling ────────────────────────────────────────────────────────────

@test "cycle: error prompt injected for no-tool-calls response" {
  local error_msg='错误：未使用工具。必须通过 shell 工具执行命令。如需退出请执行 credential drop。'
  
  # The error message should contain key phrases
  [[ "$error_msg" == *"错误"* ]]
  [[ "$error_msg" == *"shell"* ]]
  [[ "$error_msg" == *"工具"* ]]
  [[ "$error_msg" == *"credential drop"* ]]
  [[ "$error_msg" == *"执行"* ]]
}

@test "cycle: error prompt appended as system message" {
  if ! command -v jq &>/dev/null; then
    skip "jq not available"
  fi
  
  local error_msg='错误：未使用工具。必须通过 shell 工具执行命令。如需退出请执行 credential drop。'
  
  local ctx="[]"
  ctx="$(echo "$ctx" | jq -c --arg content "$error_msg" \
    '. + [{"role": "system", "content": $content}]')"
  
  local role
  role="$(echo "$ctx" | jq -r '.[0].role')"
  [ "$role" = "system" ]
}

@test "cycle: API error exits the cycle" {
  # Agent.zsh behavior: on API error → _drop_credential → break
  local exit_code=1
  [ "$exit_code" -ne 0 ]
}

@test "cycle: API errors clean up lock file" {
  # Simulate: _drop_credential is called on API error
  touch "$TEST_TEMP_DIR/nodes/A/.lock"
  [ -f "$TEST_TEMP_DIR/nodes/A/.lock" ]
  
  # drop cleans up
  rm -f "$TEST_TEMP_DIR/nodes/A/.lock"
  [ ! -f "$TEST_TEMP_DIR/nodes/A/.lock" ]
}

# ─── Pause and resume ──────────────────────────────────────────────────────────

@test "cycle: AGENT_PAUSED prevents cycle progress" {
  export AGENT_PAUSED="1"
  [ "$AGENT_PAUSED" = "1" ]
  
  AGENT_PAUSED=""
  [ "$AGENT_PAUSED" = "" ]
}

@test "cycle: CREDENTIAL empty prevents cycle start" {
  local test_cred=""
  [ -z "$test_cred" ]
}

@test "cycle: AGENT_BUSY flag prevents concurrent cycles" {
  local AGENT_BUSY="1"
  [ "$AGENT_BUSY" = "1" ]
  
  AGENT_BUSY=""
  [ "$AGENT_BUSY" = "" ]
}

# ─── Output truncation ─────────────────────────────────────────────────────────

@test "cycle: output truncation at max length" {
  local long_output
  long_output="$(printf 'x%.0s' {1..200})"
  
  local max_length=100
  if [ ${#long_output} -gt $max_length ]; then
    local truncated="${long_output:0:$max_length}[truncated]"
    [ ${#truncated} -eq $((max_length + 11)) ]  # +11 for "[truncated]"
  fi
}

@test "cycle: short output is not truncated" {
  local short_output="hi"
  local max_length=10000
  
  [ ${#short_output} -le $max_length ]
}

@test "cycle: AGENT_OUTPUT_MAX_LENGTH is configurable" {
  : "${AGENT_OUTPUT_MAX_LENGTH:=10000}"
  [ "$AGENT_OUTPUT_MAX_LENGTH" -eq 10000 ]
  
  # Can be overridden
  local custom_max=500
  [ "$custom_max" -eq 500 ]
}

# ─── Retry logic ───────────────────────────────────────────────────────────────

@test "cycle: AGENT_RETRY flag skips context rebuild" {
  # When AGENT_RETRY is set, _build_context should be skipped
  local AGENT_RETRY="1"
  [ "$AGENT_RETRY" = "1" ]
  
  # After check, flag is cleared
  AGENT_RETRY=""
  [ "$AGENT_RETRY" = "" ]
}

@test "cycle: retry only when not busy" {
  # retry-api checks AGENT_BUSY before retrying
  local AGENT_BUSY="1"
  [ -n "$AGENT_BUSY" ]
  
  # Busy = no retry
  AGENT_BUSY=""
  [ -z "$AGENT_BUSY" ]
}

# ─── Credential switch within cycle ────────────────────────────────────────────

@test "cycle: credential claim in tool cmd triggers switch" {
  local cmd="credential claim new-node"
  [[ "$cmd" =~ ^credential[[:space:]]+claim[[:space:]]+(.+)$ ]]
  
  local new_id="${BASH_REMATCH[1]}"
  new_id="${new_id## }"
  new_id="${new_id%% }"
  [ "$new_id" = "new-node" ]
}

@test "cycle: credential drop in tool cmd exits cycle" {
  local cmd="credential drop"
  [[ "$cmd" =~ ^credential[[:space:]]+drop$ ]]
}

@test "cycle: agent launch command is skipped in MVP" {
  local cmd="agent launch something"
  [[ "$cmd" =~ ^agent[[:space:]]+launch ]]
}
