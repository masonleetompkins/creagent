#!/bin/bash
# One-shot CorridorKey 2.0 installer for Creagent.
# Clones the repo and builds a project-local env under vendor/corridorkey
# (gitignored). Prefers uv, falls back to python3 -m venv + pip.
# Idempotent: re-runs pull latest and top up missing packages.
# Usage (from the repo root): scripts/setup-corridorkey.sh
set -u

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CK_ROOT="${CORRIDORKEY_ROOT:-${PROJECT_DIR}/vendor/corridorkey}"
REPO_DIR="${CK_ROOT}/repo"
VENV_DIR="${CK_ROOT}/.venv"
REPO_URL="${CORRIDORKEY_REPO:-https://github.com/nikopueringer/CorridorKey2.0}"

log() { echo "[corridorkey-setup] $*"; }
fail() { echo "[corridorkey-setup] ERROR: $*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git is required but was not found on PATH"
mkdir -p "${CK_ROOT}"

if [ -d "${REPO_DIR}/.git" ]; then
  log "updating checkout at ${REPO_DIR}"
  git -C "${REPO_DIR}" pull --ff-only 2>&1 | tail -2 || log "pull failed, keeping existing checkout"
else
  log "cloning ${REPO_URL}"
  rm -rf "${REPO_DIR}"
  git clone --depth 1 "${REPO_URL}" "${REPO_DIR}" || fail "clone failed"
fi

[ -f "${REPO_DIR}/infer.py" ] || fail "infer.py not found in checkout (repo layout changed?)"

if command -v uv >/dev/null 2>&1; then
  log "using uv"
  [ -x "${VENV_DIR}/bin/python" ] || uv venv "${VENV_DIR}" || fail "uv venv failed"
  VPY="${VENV_DIR}/bin/python"
  PIP=(uv pip install --python "${VPY}" -q)
else
  command -v python3 >/dev/null 2>&1 || fail "python3 is required but was not found on PATH"
  if [ ! -x "${VENV_DIR}/bin/python" ]; then
    log "creating venv"
    python3 -m venv "${VENV_DIR}" || fail "venv creation failed (need python3-venv?)"
  fi
  VPY="${VENV_DIR}/bin/python"
  "${VPY}" -m pip install -q --upgrade pip || fail "pip upgrade failed"
  PIP=("${VPY}" -m pip install -q)
fi

log "installing torch (one-time, ~2GB)"
"${PIP[@]}" torch torchvision 2>/dev/null \
  || "${PIP[@]}" torch torchvision --index-url https://download.pytorch.org/whl/cpu \
  || fail "torch install failed"

if [ -f "${REPO_DIR}/requirements.txt" ]; then
  log "installing repo requirements"
  "${PIP[@]}" -r "${REPO_DIR}/requirements.txt" || fail "requirements install failed"
fi

"${VPY}" -c "import torch; print('torch', torch.__version__)" || fail "torch smoke test failed"
log "ready: ${REPO_DIR}"
log "run: ${VPY} sidecar/corridorkey_server.py (or let Creagent start it for you)"
