#!/usr/bin/env bash
# One-click start for Personal Agent.
#   bash scripts/start.sh                          prepare whatever is missing, then open the app
#   bash scripts/start.sh --check                  prepare and run diagnostics, do not open the app
#   bash scripts/start.sh --no-warm                skip the Codex state index warm-up
#   bash scripts/start.sh --install-desktop-entry  add "Personal Agent" to the Linux app menu
#   bash scripts/start.sh --log                    append all output to .local/start.log (used by the menu entry)
# Safe to run repeatedly: finished steps are skipped. Never sends model requests and keeps the
# Electron sandbox on. Verified on Linux x64; the macOS branch follows the same steps but is untested here.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
# shellcheck source=scripts/lib/node24.sh
source scripts/lib/node24.sh

CHECK=0 WARM=1 DESKTOP_ENTRY=0 LOG=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --no-warm) WARM=0 ;;
    --install-desktop-entry) DESKTOP_ENTRY=1 ;;
    --log) LOG=1 ;;
    -h | --help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

if [ "$LOG" = 1 ]; then mkdir -p "$ROOT/.local"; exec >>"$ROOT/.local/start.log" 2>&1; echo "--- $(date '+%F %T') start"; fi

step() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[31m✗ %s\033[0m\n' "$*" >&2
  # Started from the app menu there is no terminal to read; surface the failure on the desktop.
  if [ ! -t 2 ] && command -v notify-send >/dev/null 2>&1; then notify-send "Personal Agent" "$*" || true; fi
  exit 1
}

case "$(uname -s)" in
  Linux) OS=linux; USER_DATA="${XDG_CONFIG_HOME:-$HOME/.config}/personal-agent" ;;
  Darwin) OS=darwin; USER_DATA="$HOME/Library/Application Support/personal-agent" ;;
  *) die "Unsupported OS: $(uname -s)" ;;
esac

if [ "$DESKTOP_ENTRY" = 1 ]; then
  [ "$OS" = linux ] || die "--install-desktop-entry is for Linux desktops"
  dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$dir" "$ROOT/.local"
  cat >"$dir/personal-agent.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Personal Agent
Comment=Local personal agent on Codex
Exec=bash "$ROOT/scripts/start.sh" --log
Path=$ROOT
Icon=applications-development
Terminal=false
Categories=Development;
StartupWMClass=personal-agent
EOF
  echo "Added $dir/personal-agent.desktop (output goes to .local/start.log)."
  exit 0
fi

# An open app holds Chromium's SingletonLock (<hostname>-<pid>). Never rebuild under a live app:
# relaunching Electron hands over to the running instance, which shows its window.
app_running() {
  local lock
  lock="$(readlink "$USER_DATA/SingletonLock" 2>/dev/null)" || return 1
  [ "${lock%-*}" = "$(hostname)" ] && kill -0 "${lock##*-}" 2>/dev/null
}

step "Node 24"
ensure_node24 || die "Node 24.19+ is required (automatic download failed; install it and retry)"
echo "  $(command -v node) $(node --version)"
if command -v pnpm >/dev/null 2>&1; then PNPM=(pnpm); else PNPM=(corepack pnpm); fi
nodex() { node --disable-warning=ExperimentalWarning "$@"; }

RUNNING=0; app_running && RUNNING=1
if [ "$CHECK" = 0 ] && [ "$RUNNING" = 1 ]; then
  step "Personal Agent is already running; bringing its window back"
  exec "$(node -p "require('electron')")" .
fi

if [ "$OS" = linux ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && [ "$CHECK" = 0 ]; then
  die "No desktop session (DISPLAY/WAYLAND_DISPLAY). Run this from a terminal inside your desktop."
fi

step "Dependencies"
stamp="$ROOT/.local/start-deps.sha256"
want="$(cat package.json pnpm-lock.yaml | sha256sum 2>/dev/null || cat package.json pnpm-lock.yaml | shasum -a 256)"
if [ ! -d node_modules ] || [ "$(cat "$stamp" 2>/dev/null)" != "$want" ]; then
  "${PNPM[@]}" install --frozen-lockfile
  mkdir -p "$ROOT/.local" && printf '%s' "$want" >"$stamp"
else
  echo "  up to date"
fi

if [ "$OS" = linux ]; then
  step "Terminal (node-pty)"
  terminal_ok() {
    nodex --input-type=module -e "const m=await import('./packages/workspace/src/terminal-binding.ts');process.exit(m.terminalAvailable('.local/terminal-binding.json')?0:1)" 2>/dev/null \
      && node -e "require('node-pty')" 2>/dev/null
  }
  if terminal_ok; then
    echo "  ready"
  else
    missing=""
    for tool in python3 make g++; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
    if [ -n "$missing" ]; then
      warn "Terminal panel stays off: build tools missing:$missing (e.g. sudo apt install python3 make g++)."
    else
      node_dir="$(pa_node_dir)"
      if [ -d "$node_dir/include/node" ]; then export npm_config_nodedir="$node_dir"; fi
      "${PNPM[@]}" rebuild node-pty && "${PNPM[@]}" setup:terminal || true
      terminal_ok && echo "  rebuilt" || warn "Terminal panel stays off (node-pty did not build; see output above)."
    fi
  fi
fi

step "Electron"
if node -e "process.exit(require('fs').existsSync(require('electron'))?0:1)" 2>/dev/null; then
  echo "  ready"
else
  "${PNPM[@]}" exec install-electron
fi

step "Codex CLI (pinned)"
codex_version="$(node -p "require('./codex-version.lock.json').cliVersion.replace('codex-cli ','')")"
codex_entry="${PERSONAL_AGENT_CODEX_PATH:-$ROOT/.local/codex-install/node_modules/@openai/codex/bin/codex.js}"
if [ -z "${PERSONAL_AGENT_CODEX_PATH:-}" ] && [ ! -e "$codex_entry" ]; then
  npm install --prefix .local/codex-install --no-audit --no-fund --save-exact "@openai/codex@$codex_version"
fi
if ! pin_error="$(nodex --input-type=module -e "const {verifiedCodex}=await import('./packages/codex-adapter/src/binary.ts');verifiedCodex(process.cwd())" 2>&1)"; then
  die "Codex CLI does not match codex-version.lock.json ($(printf '%s' "$pin_error" | grep -o -E 'CODEX_[A-Z_]+' | head -1)). Run: pnpm baseline:platform (see docs/progress/LINUX_PLATFORM.md)"
fi
echo "  codex-cli $codex_version, pinned hash matches"
if [[ "$codex_entry" == *.js ]]; then codex_cmd=(node "$codex_entry"); else codex_cmd=("$codex_entry"); fi
if login="$("${codex_cmd[@]}" login status 2>&1)"; then
  echo "  $(printf '%s\n' "$login" | grep -v '^WARNING' | head -1)"
else
  warn "Codex is not logged in. Run: ${codex_cmd[*]} login   (the app opens, but cannot talk to a model until then)"
fi

if [ "$WARM" = 1 ] && [ "$RUNNING" = 1 ]; then
  step "Codex state index: skipped while the app is running (it maintains the index itself)"
elif [ "$WARM" = 1 ]; then
  step "Codex state index"
  echo "  first start indexes your ~/.codex history; this can take a few minutes once"
  nodex scripts/warm-codex-index.ts "$USER_DATA/codex-state" \
    || warn "Index not finished yet; the app shows \"index not ready\" and retries on its own."
fi

if [ "$CHECK" = 1 ]; then
  step "Diagnostics"
  exec node --disable-warning=ExperimentalWarning scripts/doctor.mjs
fi

step "Building and opening Personal Agent"
echo "  Closing the window keeps it running in the background (tray icon). Stop it with Ctrl+C here or the menu item \"退出并停止运行\"."
exec node scripts/dev.mjs
