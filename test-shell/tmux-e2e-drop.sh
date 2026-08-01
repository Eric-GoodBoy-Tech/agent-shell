#!/usr/bin/env bash
#===============================================================================
# tmux-e2e-drop.sh — LOCK FILE LIFECYCLE (claim → drop → reclaim → drop)
#===============================================================================
# Tests: .lock file is created on claim, removed on drop,
#        and a new claim after drop succeeds (no stale lock error).
#
# Uses mock server (SSE mode) for the agent cycle; focus is on lock files.
#
# Usage: bash test-shell/tmux-e2e-drop.sh
#===============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tmux-e2e-lib.sh"

PASS=0; FAIL=0
TMUX_SESSION="agsh-e2e-drop"
EVIDENCE_DIR="$SCRIPT_DIR/e2e-evidence/drop"

cleanup() {
    echo ""
    echo "=== Drop Test: $PASS passed, $FAIL failed ==="
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    stop_mock_server
    echo "Evidence: $EVIDENCE_DIR"
    [[ $FAIL -eq 0 ]] || exit 1
}
trap cleanup EXIT

rm -rf "$EVIDENCE_DIR"
mkdir -p "$EVIDENCE_DIR"

# ─── Start mock server ──────────────────────────────────────────────────────
echo "=== Starting mock server (SSE mode) ==="
start_mock_server 0 sse
export AGENT_BASE_URL="http://localhost:$MOCK_PORT"
export AGENT_API_KEY="test-e2e-key"
export AGENT_MODEL="test-model"
echo "  Mock server on port $MOCK_PORT"

# ─── Create test node ──────────────────────────────────────────────────────
echo ""
echo "=== Creating test node ==="
export AGENT_NODES_PATH="$EVIDENCE_DIR/test-nodes"
rm -rf "$AGENT_NODES_PATH"
mkdir -p "$AGENT_NODES_PATH/root"
echo "You are a helpful assistant." > "$AGENT_NODES_PATH/root/context"
echo "context" > "$AGENT_NODES_PATH/root/type"

mkdir -p "$AGENT_NODES_PATH/drop-test"
echo "You are a lock lifecycle test agent." > "$AGENT_NODES_PATH/drop-test/context"
echo "root" > "$AGENT_NODES_PATH/drop-test/parent"
echo "context" > "$AGENT_NODES_PATH/drop-test/type"
echo "  Node 'drop-test' created"

LOCK_FILE="$AGENT_NODES_PATH/drop-test/.lock"

# ─── Pre-condition: no lock file ────────────────────────────────────────────
echo ""
echo "=== Pre-condition check ==="
if [[ ! -f "$LOCK_FILE" ]]; then
    echo "  ✓ no pre-existing .lock file"
    ((++PASS))
else
    echo "  ✗ FAIL: unexpected .lock file before test"
    ((++FAIL))
    rm -f "$LOCK_FILE"
fi

# ─── Launch tmux ────────────────────────────────────────────────────────────
echo ""
echo "=== Launching tmux ==="
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
tmux new-session -d -s "$TMUX_SESSION" -x 120 -y 40 zsh --no-rcs
sleep 0.5

if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "  ✗ FAIL: tmux session"
    ((++FAIL)); exit 1
fi
echo "  ✓ tmux session created"
((++PASS))

# ─── Setup and source agent.zsh ────────────────────────────────────────────
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
tmux send-keys -t "$TMUX_SESSION" "cd '$AGENT_DIR'" Enter
sleep 0.5

tmux send-keys -t "$TMUX_SESSION" "source '$AGENT_DIR/agent.zsh'" Enter
sleep 2

AFTER_SRC="$(tmux capture-pane -t "$TMUX_SESSION" -p -S -50 2>/dev/null || echo "")"
if [[ "$AFTER_SRC" == *"[agent] ERROR"* ]]; then
    echo "  ✗ FAIL: agent.zsh source error"
    ((++FAIL)); exit 1
fi
echo "  ✓ agent.zsh sourced"
((++PASS))

# ─── First claim: verify .lock created ─────────────────────────────────────
echo ""
echo "=== First claim ==="
tmux send-keys -t "$TMUX_SESSION" "credential claim drop-test" Enter
sleep 0.5

if wait_for_pane_text "$TMUX_SESSION" "CREDENTIAL set to: drop-test" 15; then
    echo "  ✓ first claim succeeded"
    ((++PASS))
else
    echo "  ✗ FAIL: first claim"
    ((++FAIL)); exit 1
fi

sleep 0.5
if [[ -f "$LOCK_FILE" ]]; then
    LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "empty")
    echo "  ✓ .lock file created (PID: $LOCK_PID)"
    ((++PASS))
else
    echo "  ✗ FAIL: .lock file not created after claim"
    ((++FAIL))
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/01-after-claim.txt"

# ─── Drop: verify .lock removed ────────────────────────────────────────────
echo ""
echo "=== First drop ==="
tmux send-keys -t "$TMUX_SESSION" "credential drop" Enter
sleep 0.5

if wait_for_pane_text "$TMUX_SESSION" "CREDENTIAL cleared" 10; then
    echo "  ✓ credential dropped"
    ((++PASS))
else
    echo "  ✗ FAIL: drop confirmation"
    ((++FAIL))
fi

sleep 0.5
if [[ ! -f "$LOCK_FILE" ]]; then
    echo "  ✓ .lock file removed after drop"
    ((++PASS))
else
    echo "  ✗ FAIL: .lock file still exists after drop"
    ((++FAIL))
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/02-after-drop.txt"

# ─── Reclaim: verify new .lock created ─────────────────────────────────────
echo ""
echo "=== Reclaim (second claim) ==="
tmux send-keys -t "$TMUX_SESSION" "credential claim drop-test" Enter
sleep 0.5

if wait_for_pane_text "$TMUX_SESSION" "CREDENTIAL set to: drop-test" 15; then
    echo "  ✓ second claim succeeded"
    ((++PASS))
else
    echo "  ✗ FAIL: second claim"
    ((++FAIL)); exit 1
fi

sleep 0.5
if [[ -f "$LOCK_FILE" ]]; then
    LOCK_PID2=$(cat "$LOCK_FILE" 2>/dev/null || echo "empty")
    echo "  ✓ .lock file re-created (PID: $LOCK_PID2)"
    ((++PASS))
else
    echo "  ✗ FAIL: .lock file not re-created"
    ((++FAIL))
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/03-after-reclaim.txt"

# ─── Second drop: verify .lock removed again ───────────────────────────────
echo ""
echo "=== Second drop ==="
tmux send-keys -t "$TMUX_SESSION" "credential drop" Enter
sleep 0.5

if wait_for_pane_text "$TMUX_SESSION" "CREDENTIAL cleared" 10; then
    echo "  ✓ second drop succeeded"
    ((++PASS))
else
    echo "  ✗ FAIL: second drop"
    ((++FAIL))
fi

sleep 0.5
if [[ ! -f "$LOCK_FILE" ]]; then
    echo "  ✓ .lock file removed after second drop"
    ((++PASS))
else
    echo "  ✗ FAIL: .lock file persists after second drop"
    ((++FAIL))
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/04-after-second-drop.txt"

# ─── Cleanup ────────────────────────────────────────────────────────────────
echo ""
echo "=== Cleaning up ==="
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
stop_mock_server

echo ""
echo "Results: $PASS passed, $FAIL failed"
