#!/usr/bin/env bash
set -euo pipefail

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

exec "$PYTHON_BIN" "$SERVER_SCRIPT" "$@"
