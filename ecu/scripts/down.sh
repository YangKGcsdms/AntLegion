#!/usr/bin/env bash
# Step 0 — bring the DCU stack down. Kills PID-file processes plus their
# children (tsx spawns a node child), leaves no orphans.
set -uo pipefail

ECU_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ECU_DIR/.run"

kill_tree() {
  local pid="$1" name="$2"
  # children first (tsx wrapper → node child)
  local children
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  for c in $children; do kill_tree "$c" "$name-child"; done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
    echo "$name stopped (pid $pid)"
  else
    echo "$name not running (stale pid $pid)"
  fi
}

for unit in ingestor bus; do
  pf="$RUN_DIR/$unit.pid"
  if [ -f "$pf" ]; then
    kill_tree "$(cat "$pf")" "$unit"
    rm -f "$pf"
  else
    echo "$unit no pid file"
  fi
done

# belt-and-suspenders: sweep anything that survived reparenting
pkill -f "antlegion-bus/dist/index.js" 2>/dev/null && echo "swept stray bus process" || true
pkill -f "src/main.ts ingestor" 2>/dev/null && echo "swept stray ingestor process" || true

echo "down."
