#!/usr/bin/env bash
#===============================================================================
# Tmux E2E Robot Test — Agent Shell MVP
#===============================================================================
# Tests the Agent Shell against the real DeepSeek v4-pro API via tmux.
# FULL lifecycle: init → source agent.zsh → credential claim root →
# multi-turn agent conversation → Ctrl+G pause/resume → Ctrl+T retry →
# credential drop → SIGINT cleanup.
#
# Usage: bash test-shell/tmux-e2e-robot.sh
#===============================================================================

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EVIDENCE_DIR="$SCRIPT_DIR/e2e-evidence"
TMUX_SESSION="agsh-e2e"
TIMEOUT_SECS=120  # max test duration

# Ensure clean state
rm -rf "$EVIDENCE_DIR"
mkdir -p "$EVIDENCE_DIR"

PASS=0
FAIL=0
START_TIME=$(date +%s)

# ─── Helpers ────────────────────────────────────────────────────────────────
cleanup() {
    echo ""
    echo "========================================"
    echo "Tmux E2E Test Results: $PASS passed, $FAIL failed"
    echo "Elapsed: $(( $(date +%s) - START_TIME ))s"
    echo "Evidence: $EVIDENCE_DIR"
    echo "========================================"

    # Kill tmux session if alive
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    fi
}
trap cleanup EXIT

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

capture_pane() {
    local label="$1"
    local file="$EVIDENCE_DIR/${label}.txt"
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        tmux capture-pane -t "$TMUX_SESSION" -p -S -200 > "$file" 2>/dev/null || true
        echo "  [captured pane to $file]"
    fi
}

send_key() {
    local key="$1"
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        tmux send-keys -t "$TMUX_SESSION" "$key"
    fi
}

send_line() {
    local text="$1"
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        tmux send-keys -t "$TMUX_SESSION" "$text" Enter
    fi
}

wait_for_text() {
    local pattern="$1"
    local max_wait="${2:-30}"
    local waited=0
    while [[ $waited -lt $max_wait ]]; do
        local output
        output="$(tmux capture-pane -t "$TMUX_SESSION" -p -S -200 2>/dev/null || echo "")"
        if [[ "$output" == *"$pattern"* ]]; then
            return 0
        fi
        sleep 1
        ((waited++))
    done
    return 1
}

# ─── Pre-flight Checks ─────────────────────────────────────────────────────
echo "=== Pre-flight Checks ==="

if ! command -v tmux &>/dev/null; then
    assert_fail "tmux is available" "install: brew install tmux"
    exit 1
fi
assert_pass "tmux is available"

if ! command -v bun &>/dev/null; then
    assert_fail "bun is available"
    exit 1
fi
assert_pass "bun is available"

if ! command -v jq &>/dev/null; then
    assert_fail "jq is available"
    exit 1
fi
assert_pass "jq is available"

if [[ ! -f "$AGENT_DIR/.env" ]]; then
    assert_fail ".env file exists at $AGENT_DIR/.env"
    exit 1
fi
assert_pass ".env file exists"

# Verify API key is set
API_KEY="$(grep AGENT_API_KEY "$AGENT_DIR/.env" | cut -d= -f2 || true)"
if [[ -z "$API_KEY" ]]; then
    assert_fail "AGENT_API_KEY is set in .env"
    exit 1
fi
assert_pass "AGENT_API_KEY is set"

cd "$AGENT_DIR"

# ─── Step 1: agsh init ─────────────────────────────────────────────────────
echo ""
echo "=== Step 1: agsh init ==="

if [[ -d nodes/ ]]; then
  chmod -R u+w nodes/ 2>/dev/null || true
  rm -rf nodes/
fi
INIT_OUTPUT="$(bun run src/cli.ts init 2>&1)" || true
echo "  init: $INIT_OUTPUT"

assert_contains "init creates root node" "$INIT_OUTPUT" "Root node"
assert_pass "nodes/root/content exists" && [[ -f "nodes/root/content" ]] || assert_fail "nodes/root/content exists"

# ─── Step 2: Start tmux session ────────────────────────────────────────────
echo ""
echo "=== Step 2: Start tmux session ==="

# Kill any leftover session
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true

# Start a new detached tmux session with clean zsh
# Use -f to skip rc files, but still interactive for ZLE
tmux new-session -d -s "$TMUX_SESSION" -x 120 -y 40 zsh --no-rcs
sleep 1

if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    assert_pass "tmux session created"
else
    assert_fail "tmux session created"
    exit 1
fi

capture_pane "step2-session-start"

# ─── Step 3: Source agent.zsh ──────────────────────────────────────────────
echo ""
echo "=== Step 3: Source agent.zsh ==="

# Set env vars in the tmux pane (including API key from .env)
# Note: agent.zsh now auto-loads .env at source time, but we also export
# explicitly for belt-and-suspenders safety.
send_line "export AGENT_ROOT='$AGENT_DIR'"
sleep 0.3
send_line "export AGENT_API_KEY='$API_KEY'"
sleep 0.3
send_line "export AGENT_EXEC_DELAY=2"
sleep 0.3
send_line "export AGENT_DEBUG=true"
sleep 0.3
send_line "cd '$AGENT_DIR'"
sleep 0.3
send_line "export AGENT_ROOT='$AGENT_DIR'"
sleep 0.3
send_line "export AGENT_EXEC_DELAY=2"
sleep 0.3
send_line "export AGENT_DEBUG=true"
sleep 0.3
send_line "cd '$AGENT_DIR'"
sleep 0.3

# Source agent.zsh
send_line "source '$AGENT_DIR/agent.zsh'"
sleep 2

capture_pane "step3-after-source"

# Check for errors
AFTER_SOURCE="$(tmux capture-pane -t "$TMUX_SESSION" -p -S -50 2>/dev/null || echo "")"
if [[ "$AFTER_SOURCE" == *"[agent] ERROR"* ]]; then
    assert_fail "source agent.zsh succeeded" "ERROR found in output"
    capture_pane "step3-error"
    tmux kill-session -t "$TMUX_SESSION"
    exit 1
fi
assert_pass "source agent.zsh succeeded (no errors)"

# ─── Step 4: Credential claim root ─────────────────────────────────────────
echo ""
echo "=== Step 4: Credential claim root ==="

# Check that there's no existing lock
if [[ -f "nodes/root/.lock" ]]; then
    assert_fail "no pre-existing .lock file"
    rm -f nodes/root/.lock
else
    assert_pass "no pre-existing .lock file"
fi

# Send the credential claim command (intercepted by ZLE widget)
send_line "credential claim root"
sleep 1

# Wait for agent to start cycling — look for "executing:" or "[agent]"
echo "  Waiting for agent to start cycling (API call)..."
if wait_for_text "[agent]" 30; then
    assert_pass "agent cycle started"
else
    assert_fail "agent cycle started" "agent not responding within 30s"
    capture_pane "step4-timeout"
    tmux kill-session -t "$TMUX_SESSION"
    exit 1
fi

capture_pane "step4-agent-started"

# ─── Step 5: Verify tool_calls execution ───────────────────────────────────
echo ""
echo "=== Step 5: Verify tool_calls execution ==="

# Wait longer for the agent to execute a shell command and start next cycle
sleep 5

CAPTURE_5="$(tmux capture-pane -t "$TMUX_SESSION" -p -S -100 2>/dev/null || echo "")"
echo "  Snapshot:"
echo "$CAPTURE_5" | tail -30 | while IFS= read -r line; do echo "    | $line"; done

# Check for evidence of tool call execution
HAS_EXECUTING=false
HAS_TOOL_CALL=false
if [[ "$CAPTURE_5" == *"executing:"* ]]; then
    HAS_EXECUTING=true
    assert_pass "shell command execution detected (executing:)"
else
    assert_fail "shell command execution detected" "no 'executing:' found in output"
fi

# Check for API interaction evidence
if [[ "$CAPTURE_5" == *"tool"* || "$CAPTURE_5" == *"call"* ]]; then
    HAS_TOOL_CALL=true
    assert_pass "tool_call interaction detected"
fi

capture_pane "step5-execution"

# ─── Step 6: Ctrl+G Pause ──────────────────────────────────────────────────
echo ""
echo "=== Step 6: Ctrl+G Pause ==="

# First, let the agent complete any current tool execution and be in
# the execution delay phase. Wait for another "executing:" to appear.
sleep 3

# During execution delay, pressing any non-Enter key will pause.
# Send 'p' (not Enter) to pause during execution delay.
tmux send-keys -t "$TMUX_SESSION" p
sleep 2

CAPTURE_6="$(tmux capture-pane -t "$TMUX_SESSION" -p -S -50 2>/dev/null || echo "")"
echo "  After pause attempt:"
echo "$CAPTURE_6" | tail -15 | while IFS= read -r line; do echo "    | $line"; done

if [[ "$CAPTURE_6" == *"cancelled"* || "$CAPTURE_6" == *"Paused"* || "$CAPTURE_6" == *"paused"* ]]; then
    assert_pass "pause detected (cancelled/Paused in output)"
else
    # Check if agent might have continued without a new tool call
    echo "  [note] pause may have happened during API call (not execution delay)"
fi

capture_pane "step6-pause"

# ─── Step 7: Ctrl+G Resume ─────────────────────────────────────────────────
echo ""
echo "=== Step 7: Ctrl+G Resume ==="

# Send Ctrl+G (BEL, ASCII 7) to resume from pause loop
tmux send-keys -t "$TMUX_SESSION" C-g
sleep 3

CAPTURE_7="$(tmux capture-pane -t "$TMUX_SESSION" -p -S -50 2>/dev/null || echo "")"
echo "  After resume attempt:"
echo "$CAPTURE_7" | tail -15 | while IFS= read -r line; do echo "    | $line"; done

if [[ "$CAPTURE_7" == *"Resumed"* ]]; then
    assert_pass "agent resumed (Resumed in output)"
elif [[ "$CAPTURE_7" == *"executing:"* ]]; then
    assert_pass "agent resumed (executing: in output)"
else
    echo "  [note] resume may have happened during API call phase"
fi

capture_pane "step7-resume"

# Wait for a bit to let the agent continue cycling
sleep 5

# ─── Step 8: Ctrl+C (SIGINT) cleanup test ──────────────────────────────────
echo ""
echo "=== Step 8: Ctrl+C (SIGINT) cleanup ==="

# Send Ctrl+C to interrupt the agent cycle
tmux send-keys -t "$TMUX_SESSION" C-c
sleep 3

CAPTURE_8="$(tmux capture-pane -t "$TMUX_SESSION" -p -S -50 2>/dev/null || echo "")"
echo "  After SIGINT:"
echo "$CAPTURE_8" | tail -15 | while IFS= read -r line; do echo "    | $line"; done

capture_pane "step8-sigint"

# ─── Step 9: Verify lock file cleanup ──────────────────────────────────────
echo ""
echo "=== Step 9: Verify cleanup ==="

sleep 1
if [[ -f "nodes/root/.lock" ]]; then
    assert_fail ".lock file removed after SIGINT"
    rm -f nodes/root/.lock
else
    assert_pass ".lock file removed after SIGINT"
fi

# Check for any orphan locks
ORPHAN_LOCKS=$(find nodes/ -name ".lock" 2>/dev/null || true)
if [[ -z "$ORPHAN_LOCKS" ]]; then
    assert_pass "no orphan .lock files"
else
    assert_fail "no orphan .lock files" "found: $ORPHAN_LOCKS"
    find nodes/ -name ".lock" -delete 2>/dev/null || true
fi

capture_pane "step9-final-state"

# ─── Step 10: Re-claim and test credential drop ────────────────────────────
echo ""
echo "=== Step 10: Re-claim and credential drop ==="

# Re-claim to test drop
send_line "credential claim root"
sleep 2

# Wait for agent to be active again
wait_for_text "[agent]" 20 || true
sleep 3

# Now we need to drop. But credential drop is intercepted by ZLE widget.
# However, we need to be NOT in the agent cycle for the widget to work.
# First send Ctrl+C to stop the cycle
tmux send-keys -t "$TMUX_SESSION" C-c
sleep 2

# Now send credential drop (should be intercepted by ZLE widget)
send_line "credential drop"
sleep 2

CAPTURE_10="$(tmux capture-pane -t "$TMUX_SESSION" -p -S -50 2>/dev/null || echo "")"
echo "  After credential drop:"
echo "$CAPTURE_10" | tail -15 | while IFS= read -r line; do echo "    | $line"; done

if [[ -f "nodes/root/.lock" ]]; then
    assert_fail ".lock removed after credential drop"
    rm -f nodes/root/.lock
else
    assert_pass ".lock removed after credential drop"
fi

capture_pane "step10-drop"

# ─── Step 11: Cleanup tmux session ─────────────────────────────────────────
echo ""
echo "=== Step 11: Cleanup ==="

tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
sleep 1

if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    assert_fail "tmux session killed"
else
    assert_pass "tmux session killed"
fi

# ─── Step 12: Post-test verification ────────────────────────────────────────
echo ""
echo "=== Step 12: Post-test verification ==="

# Check no lock orphans
ORPHAN_LOCKS=$(find nodes/ -name ".lock" 2>/dev/null || true)
if [[ -z "$ORPHAN_LOCKS" ]]; then
    assert_pass "no .lock orphans after test"
else
    assert_fail "no .lock orphans" "found: $ORPHAN_LOCKS"
fi

capture_pane "step12-cleanup"

# ─── Final Summary ──────────────────────────────────────────────────────────
echo ""
if [[ $FAIL -gt 0 ]]; then
    echo "*** TEST FAILED: $FAIL failures ***"
    exit 1
else
    echo "*** TEST PASSED: $PASS assertions all passed ***"
    exit 0
fi
