#!/usr/bin/env bash
set -euo pipefail
# Pre-commit: test staged changes across all layers
# Layer 1: bun test (unit + integration)
# Layer 2: bats (shell)
# Layer 3: e2e-full-cycle (mock API CLI e2e)

STAGED_TESTS=$(git diff --cached --name-only | grep '__tests__/.*\.test\.ts$' || true)
STAGED_SRC=$(git diff --cached --name-only | grep '^src/.*\.ts$' || true)
STAGED_SHELL=$(git diff --cached --name-only | grep -E '(agent\.zsh|test-shell/.*\.(bats|bash|sh))$' || true)

if [[ -z "$STAGED_TESTS" && -z "$STAGED_SRC" && -z "$STAGED_SHELL" ]]; then
  exit 0
fi

cd "$(git rev-parse --show-toplevel)/agent-shell"

# Layer 1: TypeScript tests
echo "[pre-commit] bun test..."
bun test --timeout 15000 2>&1 | tail -3

# Layer 2: Shell tests (bats)
if command -v bats &>/dev/null; then
  echo "[pre-commit] bats..."
  bats test-shell/ > /dev/null
fi

# Layer 3: Mock API e2e (fast, no tmux sessions)
echo "[pre-commit] e2e-full-cycle..."
bash test-shell/e2e-full-cycle.sh 2>&1 | tail -3

echo "[pre-commit] All checks passed"
 
