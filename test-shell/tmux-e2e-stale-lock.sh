#!/usr/bin/env bash
#===============================================================================
# tmux-e2e-stale-lock.sh — STALE LOCK CLEANUP TEST
#===============================================================================
# Tests: A .lock file with a dead PID (999999) is automatically replaced
#        when `credential claim` writes the current shell PID.
#
# The credential claim function uses `echo $$ > .lock` which overwrites
# any existing lock. This test verifies:
#   1. Stale lock with dead PID exists before claim
#   2. After claim, .lock contains the live shell PID
#   3. The claim succeeds without error
#
# Uses mock server (SSE mode).
#
# Usage: bash test-shell/tmux-e2e-stale-lock.sh
#===============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tmux-e2e-lib.sh"

PASS=0; FAIL=0
TMUX_SESSION="agsh-e2e-stale"
EVIDENCE_DIR="$SCRIPT_DIR/e2e-evidence/stale"

cleanup() {
    echo ""
    echo "=== Stale Lock Test: $PASS passed, $FAIL failed ==="
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

mkdir -p "$AGENT_NODES_PATH/stale-test"
echo "You are a stale lock test agent." > "$AGENT_NODES_PATH/stale-test/context"
echo "root" > "$AGENT_NODES_PATH/stale-test/parent"
echo "context" > "$AGENT_NODES_PATH/stale-test/type"
echo "  Node 'stale-test' created"

LOCK_FILE="$AGENT_NODES_PATH/stale-test/.lock"
DEAD_PID=999999

# ─── Pre-create stale lock with dead PID ────────────────────────────────────
echo ""
echo "=== Creating stale lock (dead PID: $DEAD_PID) ==="
echo "$DEAD_PID" > "$LOCK_FILE"

# Verify the dead PID was written
if [[ -f "$LOCK_FILE" ]]; then
    STALE_CONTENT=$(cat "$LOCK_FILE")
    if [[ "$STALE_CONTENT" == "$DEAD_PID" ]]; then
        echo "  ✓ stale .lock created with dead PID $DEAD_PID"
        ((++PASS))
    else
        echo "  ✗ FAIL: stale .lock content mismatch: '$STALE_CONTENT'"
        ((++FAIL))
    fi
else
    echo "  ✗ FAIL: could not create stale .lock"
    ((++FAIL)); exit 1
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

# ─── Claim credential (should overwrite stale lock) ────────────────────────
echo ""
echo "=== Claim credential (stale lock present) ==="
tmux send-keys -t "$TMUX_SESSION" "credential claim stale-test" Enter
sleep 0.5

if wait_for_pane_text "$TMUX_SESSION" "CREDENTIAL set to: stale-test" 15; then
    echo "  ✓ credential claimed despite stale lock"
    ((++PASS))
else
    echo "  ✗ FAIL: claim failed with stale lock present"
    ((++FAIL))
    tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/claim-fail.txt"
    exit 1
fi

# ─── Verify stale lock was replaced ────────────────────────────────────────
echo ""
echo "=== Verifying stale lock replaced ==="
sleep 0.5

if [[ -f "$LOCK_FILE" ]]; then
    CURRENT_CONTENT=$(cat "$LOCK_FILE" 2>/dev/null || echo "empty")
    echo "  .lock current content: $CURRENT_CONTENT"

    if [[ "$CURRENT_CONTENT" != "$DEAD_PID" ]]; then
        echo "  ✓ stale lock replaced (dead PID $DEAD_PID → $CURRENT_CONTENT)"
        ((++PASS))
    else
        echo "  ✗ FAIL: stale lock NOT replaced — still contains $DEAD_PID"
        ((++FAIL))
    fi

    # The current PID should be a reasonable process ID (> 1)
    if [[ "$CURRENT_CONTENT" =~ ^[0-9]+$ ]] && [[ "$CURRENT_CONTENT" -gt 1 ]]; then
        echo "  ✓ new lock PID is valid ($CURRENT_CONTENT)"
        ((++PASS))
    else
        echo "  ✗ FAIL: new lock PID is invalid ('$CURRENT_CONTENT')"
        ((++FAIL))
    fi
else
    echo "  ✗ FAIL: .lock file missing after claim"
    ((++FAIL))
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/after-claim.txt"

# ─── Drop and verify clean ─────────────────────────────────────────────────
echo ""
echo "=== Drop and verify clean ==="
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
    echo "  ✓ .lock cleaned after drop"
    ((++PASS))
else
    echo "  ✗ FAIL: .lock persists after drop"
    ((++FAIL))
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/after-drop.txt"

# ─── Cleanup ────────────────────────────────────────────────────────────────
echo ""
echo "=== Cleaning up ==="
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
stop_mock_server

echo ""
echo "Results: $PASS passed, $FAIL failed"
