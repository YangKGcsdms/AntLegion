#!/usr/bin/env bash
# Step 0 — bring the DCU stack up: fact bus (stable secret + repo-local data
# dir) + ingestor-req. Idempotent: already-running pieces are left alone.
set -euo pipefail

ECU_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$ECU_DIR/.." && pwd)"
BUS_DIR="$REPO_DIR/antlegion-bus"
RUN_DIR="$ECU_DIR/.run"
DATA_DIR="$ECU_DIR/.data"
PORT="${PORT:-28090}"
SECRET="ecu-dev-stable"

mkdir -p "$RUN_DIR" "$DATA_DIR"

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# ── bus ──
if alive "$RUN_DIR/bus.pid"; then
  echo "bus        already running (pid $(cat "$RUN_DIR/bus.pid"))"
else
  if [ ! -f "$BUS_DIR/dist/index.js" ]; then
    echo "bus        dist missing — building antlegion-bus…"
    (cd "$BUS_DIR" && npm run build --silent)
  fi
  ANTLEGION_BUS_SECRET="$SECRET" ANTLEGION_DATA_DIR="$DATA_DIR" PORT="$PORT" \
    node "$BUS_DIR/dist/index.js" >"$RUN_DIR/bus.log" 2>&1 &
  echo $! >"$RUN_DIR/bus.pid"
  echo "bus        started (pid $(cat "$RUN_DIR/bus.pid")) on :$PORT — secret=$SECRET data=$DATA_DIR"
fi

# ── wait for health ──
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then break; fi
  if [ "$i" = "60" ]; then echo "error: bus did not become healthy on :$PORT (see $RUN_DIR/bus.log)"; exit 1; fi
  sleep 0.5
done
echo "bus        healthy — $(curl -sf "http://localhost:$PORT/health")"

# ── ingestor ──
if [ ! -d "$ECU_DIR/node_modules" ]; then
  echo "ingestor   node_modules missing — npm install…"
  (cd "$ECU_DIR" && npm install --silent)
fi
if alive "$RUN_DIR/ingestor.pid"; then
  echo "ingestor   already running (pid $(cat "$RUN_DIR/ingestor.pid"))"
else
  (cd "$ECU_DIR" && exec npx tsx src/main.ts ingestor) >"$RUN_DIR/ingestor.log" 2>&1 &
  echo $! >"$RUN_DIR/ingestor.pid"
  echo "ingestor   started (pid $(cat "$RUN_DIR/ingestor.pid")) — log: $RUN_DIR/ingestor.log"
fi

# ── board ──
BOARD_PORT="${BOARD_PORT:-28091}"
if alive "$RUN_DIR/board.pid"; then
  echo "board      already running (pid $(cat "$RUN_DIR/board.pid"))"
else
  (cd "$ECU_DIR" && exec env BOARD_PORT="$BOARD_PORT" npx tsx src/main.ts board) >"$RUN_DIR/board.log" 2>&1 &
  echo $! >"$RUN_DIR/board.pid"
  echo "board      started (pid $(cat "$RUN_DIR/board.pid")) on :$BOARD_PORT — log: $RUN_DIR/board.log"
fi

echo ""
echo "up. bus http://localhost:$PORT · board http://localhost:$BOARD_PORT/board.html?bus=http://localhost:$PORT"
echo "logs: $RUN_DIR/{bus,ingestor,board}.log · stop: $ECU_DIR/scripts/down.sh"
