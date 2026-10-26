#!/usr/bin/env bash
#
# Ensures local video tooling: ffmpeg/ffprobe + whisper-cli + model.
# Idempotent and fast when everything is present. Tools the package manager
# cannot provide are downloaded into ~/.config/creagent/bin (binaries) and
# ~/.config/creagent/models (whisper weights).
#
set -euo pipefail

BIN_DIR="${CREAGENT_BIN:-$HOME/.config/creagent/bin}"
MODEL_DIR="${CREAGENT_MODELS:-$HOME/.config/creagent/models}"
WHISPER_MODEL="ggml-large-v3-turbo.bin"
mkdir -p "$BIN_DIR" "$MODEL_DIR"

log() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"

# --- ffmpeg ---------------------------------------------------------------
if ! have ffmpeg && [ ! -x "$BIN_DIR/ffmpeg" ]; then
  if have brew; then
    log "Installing ffmpeg via Homebrew…"
    brew install ffmpeg
  elif [ "$OS" = "Darwin" ]; then
    log "Downloading static ffmpeg (imageio-ffmpeg wheel)…"
    command -v python3 >/dev/null 2>&1 || { log "ERROR: python3 is required for the no-brew ffmpeg fallback"; exit 1; }
    rm -rf /tmp/creagent-ffmpegwhl && mkdir -p /tmp/creagent-ffmpegwhl
    python3 -m pip download imageio-ffmpeg --no-deps -q -d /tmp/creagent-ffmpegwhl || { log "ERROR: wheel download failed"; exit 1; }
    mkdir -p "$BIN_DIR/tmpff"
    unzip -o -j /tmp/creagent-ffmpegwhl/*.whl 'imageio_ffmpeg/binaries/ffmpeg-*' -d "$BIN_DIR/tmpff"
    mv "$BIN_DIR"/tmpff/ffmpeg-* "$BIN_DIR/ffmpeg"
    chmod +x "$BIN_DIR/ffmpeg"
    rm -rf /tmp/creagent-ffmpegwhl "$BIN_DIR/tmpff"
    if [ ! -x "$BIN_DIR/ffprobe" ] && command -v npm >/dev/null 2>&1; then
      log "Fetching static ffprobe (ffprobe-static npm package)…"
      rm -rf /tmp/creagent-ffprobe && mkdir -p /tmp/creagent-ffprobe
      (cd /tmp/creagent-ffprobe && npm pack ffprobe-static >/dev/null 2>&1 && tar -xzf ffprobe-static-*.tgz) || true
      if [ "$(uname -m)" = "arm64" ]; then FP_SRC="/tmp/creagent-ffprobe/package/bin/darwin/arm64/ffprobe";
      else FP_SRC="/tmp/creagent-ffprobe/package/bin/darwin/x64/ffprobe"; fi
      if [ -f "$FP_SRC" ]; then cp "$FP_SRC" "$BIN_DIR/ffprobe" && chmod +x "$BIN_DIR/ffprobe"; fi
      rm -rf /tmp/creagent-ffprobe
    fi
    [ -x "$BIN_DIR/ffprobe" ] || log "NOTE: no ffprobe; media probing falls back to ffmpeg -i"
  else
    log "Downloading static ffmpeg (johnvansickle.com)…"
    curl -fsSL -o /tmp/creagent-ffmpeg.txz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
    rm -rf /tmp/creagent-ffmpeg && mkdir -p /tmp/creagent-ffmpeg
    tar -xJf /tmp/creagent-ffmpeg.txz -C /tmp/creagent-ffmpeg
    cp /tmp/creagent-ffmpeg/ffmpeg-*-amd64-static/ffmpeg /tmp/creagent-ffmpeg/ffmpeg-*-amd64-static/ffprobe "$BIN_DIR/"
    rm -rf /tmp/creagent-ffmpeg /tmp/creagent-ffmpeg.txz
  fi
fi

# --- whisper ---------------------------------------------------------------
if ! have whisper-cli && ! have whisper-cpp && [ ! -x "$BIN_DIR/whisper-cli" ]; then
  if have brew; then
    log "Installing whisper-cpp via Homebrew…"
    brew install whisper-cpp
  else
    log "Building whisper.cpp from source (needs cmake + a C++ compiler)…"
    command -v cmake >/dev/null 2>&1 || { log "ERROR: cmake is required to build whisper.cpp"; exit 1; }
    command -v c++ >/dev/null 2>&1 || { log "ERROR: a C++ compiler is required to build whisper.cpp"; exit 1; }
    rm -rf /tmp/creagent-whisper && mkdir -p /tmp/creagent-whisper
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git /tmp/creagent-whisper/src
    cmake -S /tmp/creagent-whisper/src -B /tmp/creagent-whisper/build -DCMAKE_BUILD_TYPE=Release
    cmake --build /tmp/creagent-whisper/build --config Release -j
    cp /tmp/creagent-whisper/build/bin/whisper-cli "$BIN_DIR/whisper-cli"
    rm -rf /tmp/creagent-whisper
  fi
fi

# --- whisper model ----------------------------------------------------------
if [ ! -f "$MODEL_DIR/$WHISPER_MODEL" ]; then
  log "Downloading whisper model large-v3-turbo (~1.6GB)…"
  curl -fsSL -o "$MODEL_DIR/$WHISPER_MODEL" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WHISPER_MODEL"
fi

export PATH="$BIN_DIR:$PATH"
log "tools ok: ffmpeg=$(command -v ffmpeg || echo MISSING) whisper=$(command -v whisper-cli || command -v whisper-cpp || echo MISSING)"
