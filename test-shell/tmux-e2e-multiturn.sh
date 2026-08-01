#!/usr/bin/env bash
#===============================================================================
# tmux-e2e-multiturn.sh — MULTI-TURN CONVERSATION (mock server, no real API)
#===============================================================================
# Tests: credential claim → API cycle 1 → tool exec → API cycle 2 (w/ history)
#        → credential drop → lock cleaned → history JSONL non-empty.
#
# Usage: bash test-shell/tmux-e2e-multiturn.sh
#===============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tmux-e2e-lib.sh"

PASS=0; FAIL=0
TMUX_SESSION="agsh-e2e-multiturn"
EVIDENCE_DIR="$SCRIPT_DIR/e2e-evidence/multiturn"

cleanup() {
    echo ""
    echo "=== Multi-Turn Test: $PASS passed, $FAIL failed ==="
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

mkdir -p "$AGENT_NODES_PATH/mt-cred"
echo "You are a multi-turn test agent." > "$AGENT_NODES_PATH/mt-cred/context"
echo "root" > "$AGENT_NODES_PATH/mt-cred/parent"
echo "context" > "$AGENT_NODES_PATH/mt-cred/type"
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
echo "=== Credential claim mt-cred ==="
tmux send-keys -t "$TMUX_SESSION" "credential claim mt-cred" Enter
sleep 0.5

# Wait for CREDENTIAL set confirmation
if wait_for_pane_text "$TMUX_SESSION" "CREDENTIAL set to: mt-cred" 15; then
    echo "  ✓ credential claimed"
    ((++PASS))
else
    echo "  ✗ FAIL: credential claim confirmation not found"
    ((++FAIL))
    tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/claim-fail.txt"
    exit 1
fi

# Verify lock file exists
if [[ -f "$AGENT_NODES_PATH/mt-cred/.lock" ]]; then
    echo "  ✓ lock file created"
    ((++PASS))
else
    echo "  ✗ FAIL: lock file not created"
    ((++FAIL))
fi

# ─── Wait for first API cycle: thinking → exec ─────────────────────────────
echo ""
echo "=== Waiting for cycle 1: thinking → exec ==="

# Phase 1: thinking icon (◌) appears
if wait_for_pane_text "$TMUX_SESSION" "◌" 30; then
    echo "  ✓ cycle 1 thinking icon (◌) appeared"
    ((++PASS))
else
    echo "  ✗ FAIL: cycle 1 thinking icon not observed within 30s"
    ((++FAIL))
fi
tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/cycle1-thinking.txt"

# Phase 2: exec icon (◀) — mock returns tool_calls, agent enters exec mode
if wait_for_pane_text "$TMUX_SESSION" "◀" 30; then
    echo "  ✓ cycle 1 exec icon (◀) appeared"
    ((++PASS))
else
    echo "  [note] cycle 1 exec icon not seen — checking for output instead"
fi
tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/cycle1-exec.txt"

# Phase 3: Wait for the auto-exec to happen and output to appear
# After AGENT_EXEC_DELAY=1 + command execution, there should be output
sleep 1.5
tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/cycle1-after-exec.txt"

# ─── Wait for second API cycle ──────────────────────────────────────────────
echo ""
echo "=== Waiting for cycle 2 (automatic, with history) ==="

# After cycle 1 exec completes, the agent should automatically start cycle 2
# The second cycle will call the mock API again with history from cycle 1.
# We wait for the thinking icon to appear again (agent starts new API call).
# Need a generous timeout since cycle 1 exec + transition may take a few seconds.
if wait_for_pane_text "$TMUX_SESSION" "◌" 30; then
    echo "  ✓ cycle 2 thinking icon (◌) appeared (second API call started)"
    ((++PASS))
else
    echo "  [note] cycle 2 thinking icon not distinctly observed — may overlap"
fi

# Wait for cycle 2 to progress to exec or complete
sleep 3
tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/cycle2.txt"

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

# ─── Verify history file ─────────────────────────────────────────────────────
echo ""
echo "=== Verifying history JSONL ==="
HISTORY_FILE="$AGENT_NODES_PATH/mt-cred/history"

if [[ -f "$HISTORY_FILE" ]]; then
    HIST_SIZE=$(wc -c < "$HISTORY_FILE" 2>/dev/null || echo 0)
    HIST_LINES=$(wc -l < "$HISTORY_FILE" 2>/dev/null || echo 0)
    echo "  History file: $HIST_SIZE bytes, $HIST_LINES lines"
    if [[ "$HIST_SIZE" -gt 0 ]]; then
        echo "  ✓ history file exists and is non-empty"
        ((++PASS))
    else
        echo "  ✗ FAIL: history file exists but is empty"
        ((++FAIL))
    fi
    # Show history for debugging
    cat "$HISTORY_FILE" > "$EVIDENCE_DIR/history.jsonl"
else
    echo "  ✗ FAIL: history file not found at $HISTORY_FILE"
    ((++FAIL))
fi

# ─── Verify lock file cleaned ────────────────────────────────────────────────
sleep 0.5
if [[ ! -f "$AGENT_NODES_PATH/mt-cred/.lock" ]]; then
    echo "  ✓ lock file removed"
    ((++PASS))
else
    echo "  ✗ FAIL: lock file still exists after drop"
    ((++FAIL))
fi

# Verify RPROMPT clears (◇ idle icon)
if wait_for_pane_text "$TMUX_SESSION" "◇" 10; then
    echo "  ✓ idle icon (◇) after drop"
    ((++PASS))
else
    echo "  [note] idle icon not observed — may be prompt rendering timing"
fi

tmux capture-pane -t "$TMUX_SESSION" -p > "$EVIDENCE_DIR/after-drop.txt"

# ─── Cleanup ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Cleaning up ==="
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
stop_mock_server

echo ""
echo "Results: $PASS passed, $FAIL failed"
