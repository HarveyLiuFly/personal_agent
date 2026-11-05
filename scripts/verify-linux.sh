#!/usr/bin/env bash
# Linux local verification for LINUX.compat.
#   bash scripts/verify-linux.sh               # no model requests
#   bash scripts/verify-linux.sh --with-model  # adds ONE read-only model request (smoke:codex; uses account quota)
# Runs on the host desktop session (not inside a container/sandbox: Electron and the Codex
# sandbox need unprivileged user namespaces). Failures do not stop the run.
# Output: terminal + .local/verify-linux/<stamp>.log; smoke evidence goes to
# .local/verify-linux/<stamp>-evidence/ so committed macOS evidence is never overwritten.
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$ROOT/.local/verify-linux"
mkdir -p "$OUT"
LOG="$OUT/$STAMP.log"
export PERSONAL_AGENT_EVIDENCE_DIR="$OUT/$STAMP-evidence"
mkdir -p "$PERSONAL_AGENT_EVIDENCE_DIR"
WITH_MODEL=0
for arg in "$@"; do [ "$arg" = --with-model ] && WITH_MODEL=1; done
SUMMARY=()
NODE_VERSION=24.19.0

log() { printf '%s\n' "$*" | tee -a "$LOG"; }
step() {
  local name="$1"; shift
  log ""; log "===== $name ====="; log "\$ $*"
  local start=$SECONDS
  ( "$@" ) 2>&1 | tee -a "$LOG"
  local code=${PIPESTATUS[0]}
  log "----- exit $code ($((SECONDS - start))s)"
  SUMMARY+=("$(printf '%-30s exit %s' "$name" "$code")")
  cp "$LOG" "$OUT/latest.log"
  return 0
}

# Node >=24.19 <25: shared with start.sh (existing .local Node, suitable system Node, or a checked download).
# shellcheck source=scripts/lib/node24.sh
source scripts/lib/node24.sh
NODE_DIR="$(pa_node_dir)"

# Same flags as `pnpm test`, but only the suites affected by the Linux changes.
TESTS=(tests/platform.test.ts tests/terminal.test.ts tests/project-isolation.test.ts tests/scheduled-execution.test.ts
  tests/workspace.test.ts tests/worktrees.test.ts tests/binary.test.ts tests/terminal-input.test.ts tests/ui-model.test.ts)

log "Personal Agent Linux verification $STAMP (with model: $WITH_MODEL)"
log "root: $ROOT"
log "evidence: $PERSONAL_AGENT_EVIDENCE_DIR"
step "os" bash -c 'uname -a; head -4 /etc/os-release; findmnt -T . -o TARGET,FSTYPE,OPTIONS || true'
step "toolchain" bash -c 'for c in node pnpm python3 make g++ git bwrap bash zsh; do printf "%-8s " $c; (command -v $c >/dev/null && { command -v $c; $c --version 2>&1 | head -1; }) || echo missing; done'
step "kernel sandbox knobs" bash -c 'for f in /proc/sys/kernel/apparmor_restrict_unprivileged_userns /proc/sys/kernel/unprivileged_userns_clone /proc/sys/user/max_user_namespaces; do printf "%s=" $f; cat $f 2>/dev/null || echo n/a; done; echo "DISPLAY=${DISPLAY:-} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-} XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-}"'
step "git status" git status --short --branch

step "node 24" ensure_node24
ensure_node24
log "node on PATH: $(command -v node) ($(node --version))"
PNPM=(pnpm)
command -v pnpm >/dev/null 2>&1 || PNPM=(corepack pnpm)

step "pnpm install" "${PNPM[@]}" install --frozen-lockfile
# node-pty has no Linux prebuild; compile it against the Node 24 headers shipped in the tarball.
if [ -d "$NODE_DIR/include/node" ]; then export npm_config_nodedir="$NODE_DIR"; fi
step "rebuild node-pty" "${PNPM[@]}" rebuild node-pty
step "install electron" "${PNPM[@]}" exec install-electron
if [ ! -e .local/codex-install/node_modules/@openai/codex/bin/codex.js ] && [ -z "${PERSONAL_AGENT_CODEX_PATH:-}" ]; then
  step "install pinned codex" npm install --prefix .local/codex-install --cache .local/npm-cache --no-audit --no-fund --save-exact @openai/codex@0.163.0
fi
step "setup terminal" "${PNPM[@]}" setup:terminal
step "diagnose" "${PNPM[@]}" diagnose
step "codex baseline (dry run)" "${PNPM[@]}" baseline:platform
step "typecheck" "${PNPM[@]}" typecheck
step "tests (incremental)" node --disable-warning=ExperimentalWarning --test --test-reporter=spec "${TESTS[@]}"
step "build" "${PNPM[@]}" build

# Real components, no inference.
# First start of a private Codex state directory indexes all of ~/.codex; finish that before the smokes.
step "codex state index" node --disable-warning=ExperimentalWarning scripts/warm-codex-index.ts
step "smoke: connection" "${PNPM[@]}" smoke:connection          # app-server initialize + model/list
step "smoke: verifier sandbox" "${PNPM[@]}" smoke:verification  # codex sandbox + node --test reporter
step "smoke: workspace sandbox" "${PNPM[@]}" smoke:workspace    # codex sandbox read-only git/files, network blocked
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  step "smoke: desktop window" "${PNPM[@]}" smoke:desktop        # Electron sandbox/isolation + live connection in the window
  # Normal start: the optional services must not log "unavailable".
  step "electron launch (25s)" bash -c 'timeout --signal=TERM --kill-after=15 25 node scripts/dev.mjs 2>&1 | tee "$PERSONAL_AGENT_EVIDENCE_DIR/dev-launch.txt"; code=${PIPESTATUS[0]}; if grep -q "unavailable:" "$PERSONAL_AGENT_EVIDENCE_DIR/dev-launch.txt"; then echo "OPTIONAL_SERVICE_UNAVAILABLE"; exit 2; fi; [ $code -eq 124 ] && echo "STILL_RUNNING_AFTER_25S (expected: window stayed up, then quit on SIGTERM)" && exit 0; exit $code'
  sleep 2; pgrep -f "$ROOT/node_modules/.*/electron" >/dev/null && { log "electron still running after SIGTERM; stopping it"; pkill -f "$ROOT/node_modules/.*/electron" || true; }
  [ -f .local/M0-desktop-smoke.png ] && cp .local/M0-desktop-smoke.png "$PERSONAL_AGENT_EVIDENCE_DIR/"
else
  log "desktop steps skipped: no DISPLAY/WAYLAND_DISPLAY"
fi
if [ "$WITH_MODEL" = 1 ]; then
  step "smoke: model (1 request)" "${PNPM[@]}" smoke:codex       # one read-only, tool-free turn
fi

log ""; log "===== SUMMARY ====="
for line in "${SUMMARY[@]}"; do log "$line"; done
log ""; log "Log: $LOG"; log "Evidence: $PERSONAL_AGENT_EVIDENCE_DIR"
cp "$LOG" "$OUT/latest.log"
