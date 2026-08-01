#!/usr/bin/env bash
set -euo pipefail
# Full coverage verification — manual trigger
cd "$(dirname "$0")/.."

# Run tests with coverage
bun test --coverage 2>&1 | tee /tmp/agsh-coverage.txt
EXIT_CODE=${PIPESTATUS[0]}

# Per-module line coverage thresholds
THRESHOLDS=(
  "src/config.ts:90"
  "src/init.ts:80"
  "src/node-create.ts:80"
  "src/context.ts:80"
  "src/credential.ts:80"
  "src/prefix-chain.ts:80"
  "src/call.ts:70"
  "src/cli-handlers.ts:60"
)

FAILED=0
for entry in "${THRESHOLDS[@]}"; do
  FILE="${entry%%:*}"
  MIN="${entry##*:}"
  LINE_PCT=$(grep "$FILE" /tmp/agsh-coverage.txt | awk '{print $5}' | tr -d '%' | head -1)
  if [[ -z "$LINE_PCT" ]]; then
    echo "WARN: $FILE not found in coverage output"
  elif (( $(echo "$LINE_PCT < $MIN" | bc -l 2>/dev/null || echo 0) )); then
    echo "FAIL: $FILE line coverage ${LINE_PCT}% < ${MIN}%"
    FAILED=1
  else
    echo "PASS: $FILE line coverage ${LINE_PCT}% >= ${MIN}%"
  fi
done

if [[ $EXIT_CODE -ne 0 ]]; then
  echo "FAIL: tests failed"
  exit 1
fi

exit $FAILED
