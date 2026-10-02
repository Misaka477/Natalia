#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$REPO_ROOT/apps/cef-desktop/build/output"

RUNTIME_PORT="${NATALIA_RUNTIME_PORT:-8790}"
export NATALIA_FAST_EXECUTION_LOAD="${NATALIA_FAST_EXECUTION_LOAD:-1}"
export NATALIA_BROWSER_BRIDGE_URL="${NATALIA_BROWSER_BRIDGE_URL:-http://127.0.0.1:18765}"
WEB_PORT="${NATALIA_WEB_PORT:-5178}"
RUNTIME_PID=""
WEB_PID=""

# bun is a global runtime (the house standard: plain `bun`, never npx —
# the P5 closure's documented trap). A shell whose PATH lacks it (conda
# base, non-login terminals) used to die at `exec env … bun …` with an
# unreadable `env: "bun": 没有那个文件` AFTER both "starting" lines,
# leaving a CEF window with nothing to talk to. Resolve it the way bun's
# own installer lays it out, and fail with the named path if it is truly
# nowhere — a missing runtime is a sentence, not a stack of env noise.
if ! command -v bun >/dev/null 2>&1; then
  export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "[cef-desktop] bun not found — expected at ${BUN_INSTALL:-$HOME/.bun}/bin/bun (install from https://bun.sh)" >&2
  exit 1
fi

cleanup() {
  local status=$?
  # Drop every trap first so an INT followed by EXIT cannot run cleanup twice.
  trap - EXIT INT TERM
  if [[ -n "$WEB_PID" ]]; then
    kill -TERM "$WEB_PID" 2>/dev/null || true
    wait "$WEB_PID" 2>/dev/null || true
  fi
  if [[ -n "$RUNTIME_PID" ]]; then
    echo "[cef-desktop] stopping runtime (graceful shutdown)..."
    kill -TERM "$RUNTIME_PID" 2>/dev/null || true
    # Let the runtime flush durable state. The runtime has its own hard
    # shutdown watchdog (default 20s), so wait past it before escalating.
    local waited=0
    while kill -0 "$RUNTIME_PID" 2>/dev/null && (( waited < 25000 )); do
      sleep 0.2
      waited=$((waited + 200))
    done
    if kill -0 "$RUNTIME_PID" 2>/dev/null; then
      echo "[cef-desktop] runtime did not exit gracefully; killing"
      kill -KILL "$RUNTIME_PID" 2>/dev/null || true
    fi
    wait "$RUNTIME_PID" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

echo "[cef-desktop] starting runtime on 127.0.0.1:$RUNTIME_PORT"
(
  cd "$REPO_ROOT"
  # `exec` so $! is the bun process itself; a plain subshell would swallow the
  # SIGTERM and let bun keep running after the script exits.
  exec env \
    NATALIA_CONFIG="$REPO_ROOT/.natalia/global-config.json" \
    NATALIA_WORKSPACES_FILE="$REPO_ROOT/.natalia/workspaces.json" \
    bun apps/cli/src/main.ts serve "$RUNTIME_PORT"
) &
RUNTIME_PID=$!

echo "[cef-desktop] starting web server on 127.0.0.1:$WEB_PORT"
(
  cd "$REPO_ROOT"
  exec env NATALIA_WEB_PORT="$WEB_PORT" bun apps/cef-desktop/serve-web.ts
) &
WEB_PID=$!

# Wait briefly for both servers to be ready.
for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$RUNTIME_PORT/healthz" >/dev/null 2>&1 && \
     curl -fsS "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

echo "[cef-desktop] starting CEF window"
cd "$OUT_DIR"
LD_LIBRARY_PATH=. \
./natalia-cef-desktop \
  --url="http://127.0.0.1:$WEB_PORT/" \
  --ozone-platform=wayland \
  --user-data-dir="${NATALIA_CEF_USER_DATA_DIR:-$HOME/.config/natalia-cef}" "$@"
