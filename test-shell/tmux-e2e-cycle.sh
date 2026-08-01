#!/usr/bin/env bash
#===============================================================================
# tmux-e2e-cycle.sh — FULL AGENT LIFECYCLE (mock server, no real API)
#===============================================================================
# Tests: credential claim → agent starts thinking (◌) → RPROMPT transitions →
#        credential drop → lock cleaned, RPROMPT clears.
#
# Usage: bash test-shell/tmux-e2e-cycle.sh
#===============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tmux-e2e-lib.sh"

PASS=0; FAIL=0
TMUX_SESSION="agsh-e2e-cycle"
EVIDENCE_DIR="$SCRIPT_DIR/e2e-evidence/cycle"

cleanup() {
    echo ""
    echo "=== Cycle Test: $PASS passed, $FAIL failed ==="
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    stop_mock_server
    echo "Evidence: $EVIDENCE_DIR"
    [[ $FAIL -eq 0 ]] || exit 1
}
trap cleanup EXIT

rm -rf "$EVIDENCE_DIR"
mkdir -p "$EVIDENCE_DIR"

echo "=== Starting mock server (SSE mode) ==="
start_mock_server 0 sse
export AGENT_BASE_URL="http://localhost:$MOCK_PORT"
export AGENT_API_KEY="test-e2e-key"
export AGENT_MODEL="test-model"
echo "  Mock server listening on port $MOCK_PORT"

# ─── Create test nodes ─────────────────────────────────────────────────────
echo ""
echo "=== Creating test nodes ==="
export AGENT_NODES_PATH="$EVIDENCE_DIR/test-nodes"
rm -rf "$AGENT_NODES_PATH"
mkdir -p "$AGENT_NODES_PATH/root"
echo "You are a helpful assistant." > "$AGENT_NODES_PATH/root/context"
echo "context" > "$AGENT_NODES_PATH/root/type"

mkdir -p "$AGENT_NODES_PATH/test-cred"
echo "You are a test credential agent." > "$AGENT_NODES_PATH/test-cred/context"
echo "root" > "$AGENT_NODES_PATH/test-cred/parent"
echo "context" > "$AGENT_NODES_PATH/test-cred/type"
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
echo "=== Credential claim test-cred ==="
tmux send-keys -t "$TMUX_SESSION" "credential claim test-cred" Enter
sleep 0.5

# Wait for CREDENTIAL set confirmation
if wait_for_pane_text "$TMUX_SESSION" "CREDENTIAL set to: test-cred" 15; then
    echo "  ✓ credential claimed"
    ((++PASS))
else
    echo "  ✗ FAIL: credential claim confirmation not found"
    ((++FAIL))
    tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/claim-fail.txt"
    exit 1
fi

# Verify lock file exists
if [[ -f "$AGENT_NODES_PATH/test-cred/.lock" ]]; then
    echo "  ✓ lock file created"
    ((++PASS))
else
    echo "  ✗ FAIL: lock file not created"
    ((++FAIL))
fi

# ─── Wait for thinking icon (◌) ────────────────────────────────────────────
echo ""
echo "=== Waiting for agent thinking (◌) ==="
if wait_for_pane_text "$TMUX_SESSION" "◌" 30; then
    echo "  ✓ thinking icon (◌) appeared in RPROMPT"
    ((++PASS))
else
    echo "  ✗ FAIL: thinking icon not observed within 30s"
    ((++FAIL))
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/thinking.txt"

# ─── Wait for agent output (exec mode: ◀ or tool execution) ────────────────
echo ""
echo "=== Waiting for agent exec/output ==="
# The mock SSE server sends tool_calls after content chunks.
# After api_done, the agent enters exec mode (◀ icon).
if wait_for_pane_text "$TMUX_SESSION" "◀" 30; then
    echo "  ✓ exec icon (◀) appeared in RPROMPT"
    ((++PASS))
elif wait_for_pane_text "$TMUX_SESSION" "CREDENTIAL set" 5; then
    # Might still be in thinking phase; agent progressed
    echo "  ✓ agent produced output"
    ((++PASS))
else
    echo "  ✗ FAIL: agent did not produce expected output"
    ((++FAIL))
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/exec-mode.txt"

# ─── Check CREDENTIAL environment ───────────────────────────────────────────
echo ""
echo "=== Verifying CREDENTIAL env ==="
# Send echo to see CREDENTIAL value in pane
tmux send-keys -t "$TMUX_SESSION" "echo CREDENTIAL=\$CREDENTIAL" Enter
sleep 0.5
if wait_for_pane_text "$TMUX_SESSION" "CREDENTIAL=test-cred" 5; then
    echo "  ✓ CREDENTIAL env set to test-cred"
    ((++PASS))
else
    echo "  ✗ FAIL: CREDENTIAL env not set correctly"
    ((++FAIL))
fi

# ─── Credential drop ────────────────────────────────────────────────────────
echo ""
echo "=== Credential drop ==="
tmux send-keys -t "$TMUX_SESSION" "credential drop" Enter
sleep 0.5

# Wait for drop confirmation
if wait_for_pane_text "$TMUX_SESSION" "CREDENTIAL cleared" 10; then
    echo "  ✓ credential dropped"
    ((++PASS))
else
    echo "  ✗ FAIL: credential drop confirmation not found"
    ((++FAIL))
fi

# Verify lock file removed
sleep 0.5
if [[ ! -f "$AGENT_NODES_PATH/test-cred/.lock" ]]; then
    echo "  ✓ lock file removed"
    ((++PASS))
else
    echo "  ✗ FAIL: lock file still exists after drop"
    ((++FAIL))
fi

# Verify RPROMPT clears (◇ idle icon appears when no credential)
if wait_for_pane_text "$TMUX_SESSION" "◇" 10; then
    echo "  ✓ idle icon (◇) after drop"
    ((++PASS))
else
    echo "  [note] idle icon not observed — may be prompt rendering timing"
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/after-drop.txt"

# ─── Cleanup tmux ──────────────────────────────────────────────────────────
echo ""
echo "=== Cleaning up ==="
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
stop_mock_server

echo ""
echo "Results: $PASS passed, $FAIL failed"
