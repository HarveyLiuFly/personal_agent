# shellcheck shell=bash
# Puts Node >=24.19 <25 first on PATH (sourced by start.sh and verify-linux.sh).
# Order matches the Host's resolveVerifierNode(): an existing .local/node-v24.19.0-<os>-<arch>,
# then a suitable system Node, otherwise the official Node 24.19.0 is downloaded once into .local/
# and its SHA-256 checked against nodejs.org SHASUMS256.txt.

PA_NODE_VERSION=24.19.0

pa_node_dir() {
  local os arch
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) return 1 ;; esac
  case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) return 1 ;; esac
  printf '%s/.local/node-v%s-%s-%s' "$ROOT" "$PA_NODE_VERSION" "$os" "$arch"
}

pa_system_node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a===24&&b>=19?0:1)' 2>/dev/null
}

ensure_node24() {
  local dir name ext tmp
  dir="$(pa_node_dir)" || { echo "Unsupported platform $(uname -s) $(uname -m)" >&2; return 1; }
  if [ -x "$dir/bin/node" ]; then export PATH="$dir/bin:$PATH"; return 0; fi
  if pa_system_node_ok; then return 0; fi
  name="$(basename "$dir")"
  ext=tar.xz; [ "$(uname -s)" = Darwin ] && ext=tar.gz
  echo "Installing official Node $PA_NODE_VERSION into .local/ (system Node is missing or not 24.19+)…"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v$PA_NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" \
    && curl -fSL --progress-bar "https://nodejs.org/dist/v$PA_NODE_VERSION/$name.$ext" -o "$tmp/$name.$ext" \
    && (cd "$tmp" && grep " $name.$ext\$" SHASUMS256.txt | sha256sum -c - >/dev/null 2>&1 || grep " $name.$ext\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) \
    && mkdir -p "$ROOT/.local" && tar -xf "$tmp/$name.$ext" -C "$ROOT/.local" \
    || { rm -rf "$tmp"; echo "Node download or checksum failed." >&2; return 1; }
  rm -rf "$tmp"
  export PATH="$dir/bin:$PATH"
}
