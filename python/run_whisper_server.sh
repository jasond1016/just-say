#!/usr/bin/env bash
set -euo pipefail

LISTEN_HOST="${LISTEN_HOST:-127.0.0.1}"
PORT="${PORT:-8765}"
WS_PORT="${WS_PORT:-8766}"
SENSEVOICE_MODEL_ID="${SENSEVOICE_MODEL_ID:-FunAudioLLM/SenseVoiceSmall}"
#SENSEVOICE_VAD_MODEL="${SENSEVOICE_VAD_MODEL:-fsmn-vad}"
SENSEVOICE_VAD_MERGE="${SENSEVOICE_VAD_MERGE:-true}"
SENSEVOICE_VAD_MERGE_LENGTH_S="${SENSEVOICE_VAD_MERGE_LENGTH_S:-15}"
SENSEVOICE_VAD_MAX_SINGLE_SEGMENT_TIME_MS="${SENSEVOICE_VAD_MAX_SINGLE_SEGMENT_TIME_MS:-30000}"
DISABLE_SENSEVOICE_VAD="${DISABLE_SENSEVOICE_VAD:-false}"
DOWNLOAD_ROOT="${DOWNLOAD_ROOT:-./.cache/models}"
COMPUTE_TYPE="${COMPUTE_TYPE:-float16}"
LOCK_MODEL="${LOCK_MODEL:-false}"
NO_LOCK_DEVICE_COMPUTE="${NO_LOCK_DEVICE_COMPUTE:-false}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${VENV_DIR:-$SCRIPT_DIR/.venv}"
PYTHON_BIN="${PYTHON_BIN:-$VENV_DIR/bin/python}"
SERVER_SCRIPT="$SCRIPT_DIR/whisper_server.py"

if [[ ! -f "$SERVER_SCRIPT" ]]; then
  echo "[Wrapper] whisper_server.py not found: $SERVER_SCRIPT" >&2
  exit 1
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "[Wrapper] python not found in venv: $PYTHON_BIN" >&2
  echo "[Wrapper] Hint: run 'cd $SCRIPT_DIR && uv sync' first, or set PYTHON_BIN" >&2
  exit 1
fi

RESOLVED_DOWNLOAD_ROOT="$("$PYTHON_BIN" -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$SCRIPT_DIR/$DOWNLOAD_ROOT")"

mapfile -t NVIDIA_LIB_DIRS < <("$PYTHON_BIN" - <<'PY'
import os
import site
import sys

dirs = []

def add(path: str) -> None:
    if path and os.path.isdir(path) and path not in dirs:
        dirs.append(path)

paths = []
if hasattr(site, "getsitepackages"):
    paths.extend(site.getsitepackages())
if hasattr(site, "getusersitepackages"):
    user_site = site.getusersitepackages()
    if user_site:
        paths.append(user_site)
for p in sys.path:
    if "site-packages" in p:
        paths.append(p)

for root in paths:
    nvidia_root = os.path.join(root, "nvidia")
    if not os.path.isdir(nvidia_root):
        continue
    # Keep order: cublas first, then cudnn.
    for pkg in ("cublas", "cudnn"):
        for sub in ("lib", "lib64", "bin"):
            add(os.path.join(nvidia_root, pkg, sub))

for path in dirs:
    print(path)
PY
)

PREPEND_PATH=""
for dir in "${NVIDIA_LIB_DIRS[@]:-}"; do
  if [[ -z "$PREPEND_PATH" ]]; then
    PREPEND_PATH="$dir"
  else
    PREPEND_PATH="$PREPEND_PATH:$dir"
  fi
done

if [[ -n "$PREPEND_PATH" ]]; then
  if [[ -n "${LD_LIBRARY_PATH:-}" ]]; then
    export LD_LIBRARY_PATH="$PREPEND_PATH:$LD_LIBRARY_PATH"
  else
    export LD_LIBRARY_PATH="$PREPEND_PATH"
  fi
fi

echo "[Wrapper] Python: $PYTHON_BIN"
echo "[Wrapper] LD_LIBRARY_PATH: ${LD_LIBRARY_PATH:-}"
echo "[Wrapper] Download root: $RESOLVED_DOWNLOAD_ROOT"
if [[ "$DISABLE_SENSEVOICE_VAD" == "true" ]]; then
  echo "[Wrapper] SenseVoice VAD: disabled"
else
  echo "[Wrapper] SenseVoice VAD: ${SENSEVOICE_VAD_MODEL:-off}"
fi

ORIGINAL_ARGS=("$@")
ARGS=("$SERVER_SCRIPT")

has_arg() {
  local key="$1"
  for arg in "${ORIGINAL_ARGS[@]}"; do
    if [[ "$arg" == "$key" || "$arg" == "$key="* ]]; then
      return 0
    fi
  done
  return 1
}

add_default_option() {
  local key="$1"
  local value="$2"
  if ! has_arg "$key"; then
    ARGS+=("$key" "$value")
  fi
}

add_default_flag() {
  local key="$1"
  if ! has_arg "$key"; then
    ARGS+=("$key")
  fi
}

add_default_option "--host" "$LISTEN_HOST"
add_default_option "--port" "$PORT"
add_default_option "--ws-port" "$WS_PORT"
add_default_option "--engine" "sensevoice"
add_default_option "--sensevoice-model-id" "$SENSEVOICE_MODEL_ID"
add_default_option "--sensevoice-use-itn" "true"
add_default_option "--device" "cuda"
add_default_option "--compute-type" "$COMPUTE_TYPE"
add_default_option "--download-root" "$RESOLVED_DOWNLOAD_ROOT"

if [[ "$DISABLE_SENSEVOICE_VAD" != "true" ]]; then
  if [[ -n "${SENSEVOICE_VAD_MODEL:-}" ]]; then
    add_default_option "--sensevoice-vad-model" "$SENSEVOICE_VAD_MODEL"
  fi
  add_default_option "--sensevoice-vad-merge" "$SENSEVOICE_VAD_MERGE"
  add_default_option "--sensevoice-vad-merge-length-s" "$SENSEVOICE_VAD_MERGE_LENGTH_S"
  add_default_option "--sensevoice-vad-max-single-segment-time-ms" "$SENSEVOICE_VAD_MAX_SINGLE_SEGMENT_TIME_MS"
fi

if [[ "$LOCK_MODEL" == "true" ]]; then
  add_default_flag "--lock-model"
fi

if [[ "$NO_LOCK_DEVICE_COMPUTE" != "true" ]]; then
  add_default_flag "--lock-device-compute"
fi

ARGS+=("${ORIGINAL_ARGS[@]}")

echo "[Wrapper] Starting whisper_server.py"

exec "$PYTHON_BIN" "${ARGS[@]}"
