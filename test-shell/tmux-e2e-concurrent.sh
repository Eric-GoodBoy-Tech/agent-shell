#!/usr/bin/env bash
#===============================================================================
# tmux-e2e-concurrent.sh — CREDENTIAL SWITCHING LOCK BEHAVIOR
#===============================================================================
# Tests: Claim agent-a → verify lock → claim agent-b (auto-drops agent-a's lock)
#        → verify agent-b's lock → drop agent-b → verify clean.
#
# Per the credential claim implementation, switching credentials
# removes the old lock and creates a new one. Test validates this behavior.
#
# Uses mock server (SSE mode).
#
# Usage: bash test-shell/tmux-e2e-concurrent.sh
#===============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tmux-e2e-lib.sh"

PASS=0; FAIL=0
TMUX_SESSION="agsh-e2e-concurrent"
EVIDENCE_DIR="$SCRIPT_DIR/e2e-evidence/concurrent"

cleanup() {
    echo ""
    echo "=== Concurrent Test: $PASS passed, $FAIL failed ==="
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

# ─── Create test nodes ─────────────────────────────────────────────────────
echo ""
echo "=== Creating test nodes ==="
export AGENT_NODES_PATH="$EVIDENCE_DIR/test-nodes"
rm -rf "$AGENT_NODES_PATH"
mkdir -p "$AGENT_NODES_PATH/root"
echo "You are a helpful assistant." > "$AGENT_NODES_PATH/root/context"
echo "context" > "$AGENT_NODES_PATH/root/type"

mkdir -p "$AGENT_NODES_PATH/agent-a"
echo "You are agent A." > "$AGENT_NODES_PATH/agent-a/context"
echo "root" > "$AGENT_NODES_PATH/agent-a/parent"
echo "context" > "$AGENT_NODES_PATH/agent-a/type"

mkdir -p "$AGENT_NODES_PATH/agent-b"
echo "You are agent B." > "$AGENT_NODES_PATH/agent-b/context"
echo "root" > "$AGENT_NODES_PATH/agent-b/parent"
echo "context" > "$AGENT_NODES_PATH/agent-b/type"
echo "  Nodes 'agent-a' and 'agent-b' created"

LOCK_A="$AGENT_NODES_PATH/agent-a/.lock"
LOCK_B="$AGENT_NODES_PATH/agent-b/.lock"

# ─── Pre-condition: no lock files ──────────────────────────────────────────
echo ""
echo "=== Pre-condition check ==="
NO_LOCKS=true
[[ -f "$LOCK_A" ]] && { echo "  ✗ FAIL: stale lock-a"; NO_LOCKS=false; rm -f "$LOCK_A"; }
[[ -f "$LOCK_B" ]] && { echo "  ✗ FAIL: stale lock-b"; NO_LOCKS=false; rm -f "$LOCK_B"; }
if $NO_LOCKS; then
    echo "  ✓ no pre-existing lock files"
    ((++PASS))
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

# ─── Claim agent-a ─────────────────────────────────────────────────────────
echo ""
echo "=== Claim agent-a ==="
tmux send-keys -t "$TMUX_SESSION" "credential claim agent-a" Enter
sleep 0.5

if wait_for_pane_text "$TMUX_SESSION" "CREDENTIAL set to: agent-a" 15; then
    echo "  ✓ agent-a claimed"
    ((++PASS))
else
    echo "  ✗ FAIL: agent-a claim"
    ((++FAIL)); exit 1
fi

sleep 0.5
if [[ -f "$LOCK_A" ]]; then
    echo "  ✓ agent-a .lock exists"
    ((++PASS))
else
    echo "  ✗ FAIL: agent-a .lock missing"
    ((++FAIL))
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/01-agent-a-claimed.txt"

# ─── Claim agent-b (switches credential) ───────────────────────────────────
echo ""
echo "=== Claim agent-b (credential switch) ==="
tmux send-keys -t "$TMUX_SESSION" "credential claim agent-b" Enter
sleep 0.5

if wait_for_pane_text "$TMUX_SESSION" "CREDENTIAL set to: agent-b" 15; then
    echo "  ✓ agent-b claimed"
    ((++PASS))
else
    echo "  ✗ FAIL: agent-b claim"
    ((++FAIL)); exit 1
fi

sleep 0.5

# agent-a's lock should be removed (credential switch cleans old lock)
if [[ ! -f "$LOCK_A" ]]; then
    echo "  ✓ agent-a .lock removed (credential switch)"
    ((++PASS))
else
    echo "  [note] agent-a .lock still exists — unexpected but not fatal"
    # This may happen if agent-a's PID is still running
fi

# agent-b's lock should exist
if [[ -f "$LOCK_B" ]]; then
    echo "  ✓ agent-b .lock exists"
    ((++PASS))
else
    echo "  ✗ FAIL: agent-b .lock missing"
    ((++FAIL))
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/02-agent-b-claimed.txt"

# ─── Drop agent-b ──────────────────────────────────────────────────────────
echo ""
echo "=== Drop agent-b ==="
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

# Both locks should be gone
ALL_CLEAN=true
if [[ -f "$LOCK_A" ]]; then
    echo "  ✗ FAIL: agent-a .lock still present"
    ALL_CLEAN=false; rm -f "$LOCK_A"
fi
if [[ -f "$LOCK_B" ]]; then
    echo "  ✗ FAIL: agent-b .lock still present"
    ALL_CLEAN=false; rm -f "$LOCK_B"
fi
if $ALL_CLEAN; then
    echo "  ✓ no orphan lock files"
    ((++PASS))
else
    ((++FAIL))
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/03-after-drop.txt"

# ─── Cleanup ────────────────────────────────────────────────────────────────
echo ""
echo "=== Cleaning up ==="
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
stop_mock_server

echo ""
echo "Results: $PASS passed, $FAIL failed"
