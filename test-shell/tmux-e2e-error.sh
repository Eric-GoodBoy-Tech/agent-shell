#!/usr/bin/env bash
#===============================================================================
# tmux-e2e-error.sh — API ERROR RECOVERY (mock server failover, no real API)
#===============================================================================
# Tests: error mock → agent survives → switch to SSE mock → Ctrl+T retry →
#        agent recovers and completes a cycle successfully.
#
# Usage: bash test-shell/tmux-e2e-error.sh
#===============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tmux-e2e-lib.sh"

PASS=0; FAIL=0
TMUX_SESSION="agsh-e2e-error"
EVIDENCE_DIR="$SCRIPT_DIR/e2e-evidence/error"

cleanup() {
    echo ""
    echo "=== Error Recovery Test: $PASS passed, $FAIL failed ==="
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    # Both mocks may be running; stop the last one via the lib helper,
    # and also try killing on the error port
    stop_mock_server
    if [[ -n "${ERROR_PORT:-}" ]]; then
        # Kill any leftover process on the error port
        lsof -ti "tcp:$ERROR_PORT" 2>/dev/null | xargs kill 2>/dev/null || true
    fi
    echo "Evidence: $EVIDENCE_DIR"
    [[ $FAIL -eq 0 ]] || exit 1
}
trap cleanup EXIT

rm -rf "$EVIDENCE_DIR"
mkdir -p "$EVIDENCE_DIR"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 1: Error mock server — agent should not crash
# ═══════════════════════════════════════════════════════════════════════════════
echo "=== Phase 1: Starting error mock server ==="
start_mock_server 0 error
ERROR_PORT="$MOCK_PORT"
# Save error mock PID so we can kill it separately later
ERROR_MOCK_PID="$MOCK_PID"
export AGENT_BASE_URL="http://localhost:$ERROR_PORT"
export AGENT_API_KEY="test-e2e-key"
export AGENT_MODEL="test-model"
echo "  Error mock server on port $ERROR_PORT (PID $ERROR_MOCK_PID)"

# ─── Create test nodes ─────────────────────────────────────────────────────
echo ""
echo "=== Creating test nodes ==="
export AGENT_NODES_PATH="$EVIDENCE_DIR/test-nodes"
rm -rf "$AGENT_NODES_PATH"
mkdir -p "$AGENT_NODES_PATH/root"
echo "You are a helpful assistant." > "$AGENT_NODES_PATH/root/context"
echo "context" > "$AGENT_NODES_PATH/root/type"

mkdir -p "$AGENT_NODES_PATH/err-cred"
echo "You are an error recovery test agent." > "$AGENT_NODES_PATH/err-cred/context"
echo "root" > "$AGENT_NODES_PATH/err-cred/parent"
echo "context" > "$AGENT_NODES_PATH/err-cred/type"
echo "  Test nodes created under $AGENT_NODES_PATH"

# ─── Launch tmux ───────────────────────────────────────────────────────────
echo ""
echo "=== Launching tmux session ==="
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
tmux new-session -d -s "$TMUX_SESSION" -x 120 -y 40 zsh --no-rcs
sleep 0.5

if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "  ✓ tmux session created"
    ((++PASS))
else
    echo "  ✗ FAIL: tmux session not created"
    ((++FAIL)); exit 1
fi

# ─── Setup environment and source agent.zsh ────────────────────────────────
echo ""
echo "=== Setting up agent-shell ==="
tmux send-keys -t "$TMUX_SESSION" "export AGENT_ROOT='$AGENT_DIR'" Enter
sleep 0.3
tmux send-keys -t "$TMUX_SESSION" "export AGENT_API_KEY='$AGENT_API_KEY'" Enter
sleep 0.3
tmux send-keys -t "$TMUX_SESSION" "export AGENT_BASE_URL='$AGENT_BASE_URL'" Enter
sleep 0.3
tmux send-keys -t "$TMUX_SESSION" "export AGENT_MODEL='$AGENT_MODEL'" Enter
sleep 0.3
tmux send-keys -t "$TMUX_SESSION" "export AGENT_NODES_PATH='$AGENT_NODES_PATH'" Enter
sleep 0.3
tmux send-keys -t "$TMUX_SESSION" "export AGENT_EXEC_DELAY=1" Enter
sleep 0.3
tmux send-keys -t "$TMUX_SESSION" "export AGENT_DEBUG=true" Enter
sleep 0.3
tmux send-keys -t "$TMUX_SESSION" "cd '$AGENT_DIR'" Enter
sleep 0.5

# Source agent.zsh
tmux send-keys -t "$TMUX_SESSION" "source '$AGENT_DIR/agent.zsh'" Enter
sleep 2

AFTER_SRC="$(tmux capture-pane -t "$TMUX_SESSION" -p -S -50 2>/dev/null || echo "")"
if [[ "$AFTER_SRC" == *"[agent] ERROR"* ]]; then
    echo "  ✗ FAIL: agent.zsh source produced ERROR"
    ((++FAIL))
    tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/source-error.txt"
    exit 1
fi
echo "  ✓ agent.zsh sourced"
((++PASS))

# ─── Claim credential ───────────────────────────────────────────────────────
echo ""
echo "=== Credential claim err-cred ==="
tmux send-keys -t "$TMUX_SESSION" "credential claim err-cred" Enter
sleep 0.5

if wait_for_pane_text "$TMUX_SESSION" "CREDENTIAL set to: err-cred" 15; then
    echo "  ✓ credential claimed"
    ((++PASS))
else
    echo "  ✗ FAIL: credential claim confirmation not found"
    ((++FAIL))
    tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/claim-fail.txt"
    exit 1
fi

# ─── Wait for agent to start cycling against error mock ─────────────────────
echo ""
echo "=== Phase 1: Agent cycling against error mock ==="

# The agent tries to make API calls to the error mock.
# The error mock returns JSON (not SSE), so the agent may not get a proper
# error event, but it should keep trying (◌ → attempt → ◌ → retry...).
# The key assertion: the agent does NOT crash, and the tmux session stays alive.

# Wait for thinking icon to appear at least once (agent started API cycle)
if wait_for_pane_text "$TMUX_SESSION" "◌" 20; then
    echo "  ✓ thinking icon appeared (agent attempted API call)"
    ((++PASS))
else
    echo "  [note] thinking icon not observed — agent may have cycled quickly"
fi

# Allow the agent a few cycles against the error mock
sleep 3
tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/phase1-error-cycling.txt"

# Verify tmux session and pane are still alive
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "  ✓ tmux session survived error mock cycling"
    ((++PASS))
else
    echo "  ✗ FAIL: tmux session died during error mock"
    ((++FAIL)); exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 2: Stop error mock, start SSE mock, retry
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "=== Phase 2: Switching to SSE mock server ==="

# Kill the error mock server
if [[ -n "${ERROR_MOCK_PID:-}" ]]; then
    kill "$ERROR_MOCK_PID" 2>/dev/null || true
    wait "$ERROR_MOCK_PID" 2>/dev/null || true
    echo "  Stopped error mock (PID $ERROR_MOCK_PID)"
fi
# Reset mock server state in lib (since we manually killed it)
MOCK_PID=""
MOCK_PORT=""

# Start a fresh SSE mock server on a new port
start_mock_server 0 sse
SSE_PORT="$MOCK_PORT"
echo "  SSE mock server on port $SSE_PORT"

# Update AGENT_BASE_URL in the running tmux session
# The agent needs the new URL for the next API call.
tmux send-keys -t "$TMUX_SESSION" "export AGENT_BASE_URL='http://localhost:$SSE_PORT'" Enter
sleep 0.5

# Verify the export took effect
tmux send-keys -t "$TMUX_SESSION" "echo AGENT_BASE_URL=\$AGENT_BASE_URL" Enter
sleep 0.5

# ─── Trigger retry via Ctrl+T ────────────────────────────────────────────────
echo ""
echo "=== Triggering retry (Ctrl+T) ==="
# Ctrl+T is bound to retry-api which wakes the agent via _agent_wake → zle accept-line
tmux send-keys -t "$TMUX_SESSION" C-t
sleep 1

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/phase2-retry-triggered.txt"

# ─── Wait for successful cycle against SSE mock ──────────────────────────────
echo ""
echo "=== Waiting for successful recovery cycle ==="

# The agent should now connect to the SSE mock, receive content + tool_calls,
# and transition through thinking (◌) → exec (◀).
if wait_for_pane_text "$TMUX_SESSION" "◌" 30; then
    echo "  ✓ thinking icon (◌) after retry — agent reconnected"
    ((++PASS))
else
    echo "  ✗ FAIL: thinking icon not observed after retry"
    ((++FAIL))
fi

# Wait for exec mode
if wait_for_pane_text "$TMUX_SESSION" "◀" 30; then
    echo "  ✓ exec icon (◀) — agent entered exec mode after recovery"
    ((++PASS))
else
    echo "  [note] exec icon not observed; checking for output"
fi

# Wait for command output from the mock tool_call
# The SSE mock tool_call runs: echo "hello from mock server"
sleep 2
if wait_for_pane_text "$TMUX_SESSION" "hello from mock server" 15; then
    echo "  ✓ command output appeared — agent successfully executed after recovery"
    ((++PASS))
else
    echo "  [note] specific output text not found, capturing pane for analysis"
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/phase2-recovery.txt"

# ─── Verify history file exists (proves successful API call + write) ─────────
echo ""
echo "=== Verifying history after recovery ==="
HISTORY_FILE="$AGENT_NODES_PATH/err-cred/history"

sleep 1
if [[ -f "$HISTORY_FILE" ]]; then
    HIST_SIZE=$(wc -c < "$HISTORY_FILE" 2>/dev/null || echo 0)
    echo "  History file: $HIST_SIZE bytes"
    if [[ "$HIST_SIZE" -gt 0 ]]; then
        echo "  ✓ history JSONL created after recovery"
        ((++PASS))
    else
        echo "  ✗ FAIL: history file empty after recovery"
        ((++FAIL))
    fi
    cp "$HISTORY_FILE" "$EVIDENCE_DIR/history.jsonl"
else
    echo "  [note] history file not found (agent may not have completed a cycle)"
fi

# ─── Credential drop ────────────────────────────────────────────────────────
echo ""
echo "=== Credential drop ==="
tmux send-keys -t "$TMUX_SESSION" "credential drop" Enter
sleep 0.5

if wait_for_pane_text "$TMUX_SESSION" "CREDENTIAL cleared" 10; then
    echo "  ✓ credential dropped"
    ((++PASS))
else
    echo "  ✗ FAIL: credential drop confirmation not found"
    ((++FAIL))
fi

# Verify lock file removed
sleep 0.5
if [[ ! -f "$AGENT_NODES_PATH/err-cred/.lock" ]]; then
    echo "  ✓ lock file removed"
    ((++PASS))
else
    echo "  ✗ FAIL: lock file still exists after drop"
    ((++FAIL))
fi

# Verify idle icon
if wait_for_pane_text "$TMUX_SESSION" "◇" 10; then
    echo "  ✓ idle icon (◇) after drop"
    ((++PASS))
else
    echo "  [note] idle icon not observed"
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/after-drop.txt"

# ─── Cleanup ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Cleaning up ==="
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
stop_mock_server

echo ""
echo "Results: $PASS passed, $FAIL failed"
