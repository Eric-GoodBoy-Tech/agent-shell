#!/usr/bin/env bats
# AGENT_PRELOAD channel: how a plugin announces itself.
#
# The channel is ONE env string; _agent_bun_cli (agent.zsh) splits it word-wise
# and hands one --preload per entry to the CLI process. Because it is a single
# string, a plugin that writes a whole-value export wipes every other plugin's
# entry. The supported shape is the append form:
#
#   export AGENT_PRELOAD="${AGENT_PRELOAD:+$AGENT_PRELOAD }/abs/path/plugin.ts"
#
# These tests pin that shape (and the footgun beside it) so the docs cannot
# drift away from what the kernel actually does.

load test_helper

setup() {
  bats_setup_environment

  export AGENT_NODES_PATH="$TEST_NODES_DIR"
  mkdir -p "$TEST_TEMP_DIR/home" "$TEST_TEMP_DIR/cwd" "$TEST_TEMP_DIR/bin"

  # Fake bun: echo back the argv it was handed.
  cat > "$TEST_TEMP_DIR/bin/bun" <<'SH'
#!/usr/bin/env bash
for a in "$@"; do printf 'ARG[%s]\n' "$a"; done
SH
  chmod +x "$TEST_TEMP_DIR/bin/bun"
}

# Source agent.zsh in isolation with the given ~/.agshrc body, then ask
# _agent_bun_cli to show the argv it builds.
_run_preload_probe() {
  printf '%s\n' "$1" > "$TEST_TEMP_DIR/home/.agshrc"

  local probe="$TEST_TEMP_DIR/probe.zsh"
  cat > "$probe" <<SCRIPT
source "$AGENT_ZS" >/dev/null 2>&1
_agent_bun_cli probe
SCRIPT

  ( cd "$TEST_TEMP_DIR/cwd" &&
    PATH="$TEST_TEMP_DIR/bin:$PATH" HOME="$TEST_TEMP_DIR/home" TMPDIR="$TEST_TEMP_DIR" \
    AGENT_ROOT="${BATS_TEST_DIRNAME}/.." AGENT_HEADLESS=1 AGENT_API_KEY=dummy \
    AGENT_NODES_PATH="$AGENT_NODES_PATH" \
    zsh -f "$probe" 2>/dev/null )
}

@test "preload: append form carries every plugin that announced itself" {
  run _run_preload_probe '
export AGENT_PRELOAD="/abs/plugins/a.ts"
export AGENT_PRELOAD="${AGENT_PRELOAD:+$AGENT_PRELOAD }/abs/plugins/b.ts"'

  [ "$status" -eq 0 ]
  [[ "$output" == *"ARG[--preload=/abs/plugins/a.ts]"* ]]
  [[ "$output" == *"ARG[--preload=/abs/plugins/b.ts]"* ]]
}

@test "preload: whole-value export wipes the previous plugin (why append is required)" {
  run _run_preload_probe '
export AGENT_PRELOAD="/abs/plugins/a.ts"
export AGENT_PRELOAD="/abs/plugins/b.ts"'

  [ "$status" -eq 0 ]
  [[ "$output" == *"ARG[--preload=/abs/plugins/b.ts]"* ]]
  [[ "$output" != *"a.ts"* ]]
}

@test "preload: argv order follows announce order (later plugin wraps outer)" {
  run _run_preload_probe '
export AGENT_PRELOAD="/abs/plugins/a.ts"
export AGENT_PRELOAD="${AGENT_PRELOAD:+$AGENT_PRELOAD }/abs/plugins/b.ts"'

  [ "$status" -eq 0 ]
  local a b
  a=$(printf '%s\n' "$output" | grep -n 'a\.ts' | head -1 | cut -d: -f1)
  b=$(printf '%s\n' "$output" | grep -n 'b\.ts' | head -1 | cut -d: -f1)
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}
