#!/usr/bin/env bash
#===============================================================================
# verify-all.sh — Run all Agent Shell tests
#===============================================================================
# Runs: bun test (TypeScript) + bats test-shell/ (Shell) + e2e
# Usage: bash test-shell/verify-all.sh
#===============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
TOTAL=0

echo "=========================================="
echo "Agent Shell MVP — Full Verification Suite"
echo "=========================================="
echo ""

# ─── TypeScript Tests (bun test) ──────────────────────────────────────────
echo "─── TypeScript Unit Tests (bun test) ───"
cd "$AGENT_DIR"

if bun test 2>&1; then
  echo "  ✓ bun test passed"
  ((PASS++))
else
  echo "  ✗ bun test failed"
  ((FAIL++))
fi
((TOTAL++))
echo ""

# ─── Shell Tests (bats) ───────────────────────────────────────────────────
echo "─── Shell Tests (bats test-shell/) ───"

if command -v bats &>/dev/null; then
  if bats "$AGENT_DIR/test-shell/" 2>&1; then
    echo "  ✓ bats tests passed"
    ((PASS++))
  else
    echo "  ✗ bats tests failed"
    ((FAIL++))
  fi
else
  echo "  ⚠ bats not installed — skipping Shell tests"
  echo "    Install: brew install bats-assert"
  # Run syntax check instead
  echo "  Running bash syntax check on .bats files..."
  BATS_SYNTAX_OK=true
  for f in "$AGENT_DIR"/test-shell/*.bats; do
    if ! bash -n "$f" 2>/dev/null; then
      echo "    ✗ Syntax error in $f"
      BATS_SYNTAX_OK=false
    fi
  done
  if $BATS_SYNTAX_OK; then
    echo "  ✓ All .bats files pass syntax check"
    ((PASS++))
  else
    ((FAIL++))
  fi
fi
((TOTAL++))
echo ""

# ─── E2E Integration Test ─────────────────────────────────────────────────
echo "─── E2E Integration Test ───"

E2E_SCRIPT="$AGENT_DIR/test-shell/e2e-full-cycle.sh"
if [[ -f "$E2E_SCRIPT" ]]; then
  if bash "$E2E_SCRIPT" 2>&1; then
    echo "  ✓ E2E test passed"
    ((PASS++))
  else
    echo "  ✗ E2E test failed"
    ((FAIL++))
  fi
else
  echo "  ⚠ E2E test script not found"
  ((FAIL++))
fi
((TOTAL++))
echo ""

# ─── CLI Smoke Test ──────────────────────────────────────────────────────
echo "─── CLI Smoke Test ───"

CLI_OK=true

# Test --help
if bun run "$AGENT_DIR/src/cli.ts" --help &>/dev/null; then
  echo "  ✓ agsh --help works"
else
  echo "  ✗ agsh --help failed"
  CLI_OK=false
fi

# Test --version
VERSION_OUT="$(bun run "$AGENT_DIR/src/cli.ts" --version 2>&1)" || true
if [[ "$VERSION_OUT" == "0.1.0" ]]; then
  echo "  ✓ agsh --version returns 0.1.0"
else
  echo "  ✗ agsh --version failed: $VERSION_OUT"
  CLI_OK=false
fi

# Test unknown command
if ! bun run "$AGENT_DIR/src/cli.ts" nonexistent &>/dev/null; then
  echo "  ✓ agsh unknown command exits non-zero"
else
  echo "  ✗ agsh should exit non-zero on unknown command"
  CLI_OK=false
fi

if $CLI_OK; then
  ((PASS++))
else
  ((FAIL++))
fi
((TOTAL++))
echo ""

# ─── Coverage Check ───────────────────────────────────────────
if [[ "${1:-}" == "--full" ]]; then
  echo "─── Coverage Check ───"
  if bash "$AGENT_DIR/scripts/coverage-check.sh" 2>&1; then
    echo "  ✓ Coverage thresholds met"
    ((PASS++))
  else
    echo "  ✗ Coverage thresholds not met"
    ((FAIL++))
  fi
  ((TOTAL++))
  echo ""
fi

# ─── Summary ──────────────────────────────────────────────────────────────
echo "=========================================="
echo "Verification Complete: $PASS/$TOTAL passed"
echo "=========================================="

if [[ $FAIL -gt 0 ]]; then
  echo "FAILURES: $FAIL"
  exit 1
else
  echo "ALL CHECKS PASSED"
  exit 0
fi
