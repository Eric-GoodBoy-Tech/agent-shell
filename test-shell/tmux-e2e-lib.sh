#!/usr/bin/env bash
#===============================================================================
# Shared library for tmux e2e tests — mock server management & pane assertions.
#
# Source this file in your e2e test script:
#   source "$(dirname "${BASH_SOURCE[0]}")/tmux-e2e-lib.sh"
#===============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Mock server management ────────────────────────────────────────────────────
MOCK_PID=""
MOCK_PORT_FILE=""
MOCK_PORT=""

start_mock_server() {
    local port="${1:-0}"
    local response_type="${2:-dynamic}"

    MOCK_PORT_FILE="$(mktemp)"

    bun run "$AGENT_DIR/test-utils/mock-server.ts" \
        --port "$port" \
        --write-port "$MOCK_PORT_FILE" \
        --response-type "$response_type" &
    MOCK_PID=$!

    # Wait for port file to be written (server ready signal)
    local max_attempts=30
    local waited=0
    while [[ $waited -lt $max_attempts ]]; do
        if [[ -s "$MOCK_PORT_FILE" ]]; then
            MOCK_PORT=$(cat "$MOCK_PORT_FILE")
            return 0
        fi
        sleep 0.1
        ((waited++))
    done

    echo "ERROR: mock server failed to start after ${max_attempts} attempts" >&2
    return 1
}

stop_mock_server() {
    if [[ -n "${MOCK_PID:-}" ]]; then
        kill "$MOCK_PID" 2>/dev/null || true
        wait "$MOCK_PID" 2>/dev/null || true
    fi
    if [[ -n "${MOCK_PORT_FILE:-}" && -f "$MOCK_PORT_FILE" ]]; then
        rm -f "$MOCK_PORT_FILE"
    fi
}

# ─── Pane text polling ─────────────────────────────────────────────────────────
# Polls tmux capture-pane until the pattern appears or timeout expires.
# Uses 0.1s intervals — no sleep-based timing.
#
# Usage: wait_for_pane_text <session> <pattern> [max_wait_seconds]
wait_for_pane_text() {
    local session="$1"
    local pattern="$2"
    local max_wait="${3:-30}"
    local interval=0.1
    local max_attempts
    max_attempts=$(echo "$max_wait / $interval" | bc 2>/dev/null || echo $((max_wait * 10)))
    local waited=0

    while [[ $waited -lt $max_attempts ]]; do
        local output
        output="$(tmux capture-pane -t "$session" -p -S -500 2>/dev/null || echo "")"

        # Compound anchoring: substring match against full pane text
        if [[ "$output" == *"$pattern"* ]]; then
            return 0
        fi

        sleep "$interval"
        ((waited++))
    done

    echo "TIMEOUT: wait_for_pane_text '$pattern' after ${max_wait}s" >&2
    return 1
}

# ─── Pane assertion helpers ────────────────────────────────────────────────────
# These capture the current pane and assert a pattern is present/absent.

assert_pane_contains() {
    local session="$1"
    local desc="$2"
    local pattern="$3"

    local output
    output="$(tmux capture-pane -t "$session" -p -S -500 2>/dev/null || echo "")"

    if [[ "$output" == *"$pattern"* ]]; then
        echo "  ✓ $desc"
        return 0
    else
        echo "  ✗ FAIL: $desc — expected pane to contain '$pattern'" >&2
        return 1
    fi
}

assert_pane_not_contains() {
    local session="$1"
    local desc="$2"
    local pattern="$3"

    local output
    output="$(tmux capture-pane -t "$session" -p -S -500 2>/dev/null || echo "")"

    if [[ "$output" != *"$pattern"* ]]; then
        echo "  ✓ $desc"
        return 0
    else
        echo "  ✗ FAIL: $desc — pane should NOT contain '$pattern'" >&2
        return 1
    fi
}
