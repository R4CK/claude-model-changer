#!/usr/bin/env bash
# Claude Model Changer - installer (Linux / macOS / Git Bash on Windows)
#
# Runs preflight checks and ONLY installs if all prerequisites are met.
# Attempts to auto-install Node.js (>=16) if missing.

set -u

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIN_NODE_MAJOR=16

c_reset='\033[0m'; c_red='\033[31m'; c_grn='\033[32m'; c_ylw='\033[33m'; c_cyn='\033[36m'
msg()  { printf '%b%s%b\n' "$c_cyn" "$1" "$c_reset"; }
ok()   { printf '%b[OK]  %s%b\n' "$c_grn" "$1" "$c_reset"; }
warn() { printf '%b[WARN]%b %s\n' "$c_ylw" "$c_reset" "$1"; }
fail() { printf '%b[FAIL]%b %s\n' "$c_red" "$c_reset" "$1"; }

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

try_install_node() {
  msg "Attempting to install Node.js (>=${MIN_NODE_MAJOR}) automatically..."
  local os
  os="$(uname -s 2>/dev/null || echo unknown)"

  if command -v brew >/dev/null 2>&1; then
    msg "Using Homebrew..."
    brew install node || true
    return $?
  fi

  if command -v apt-get >/dev/null 2>&1; then
    msg "Using apt-get (requires sudo)..."
    curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
    return $?
  fi

  if command -v dnf >/dev/null 2>&1; then
    msg "Using dnf (requires sudo)..."
    curl -fsSL "https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | sudo -E bash -
    sudo dnf install -y nodejs
    return $?
  fi

  if command -v pacman >/dev/null 2>&1; then
    msg "Using pacman (requires sudo)..."
    sudo pacman -S --noconfirm nodejs npm
    return $?
  fi

  case "$os" in
    MINGW*|MSYS*|CYGWIN*)
      warn "On Git Bash / MSYS. Please install Node.js manually from https://nodejs.org"
      warn "(winget install OpenJS.NodeJS.LTS  -or-  choco install nodejs-lts)"
      ;;
    *)
      warn "No known package manager detected. Install Node.js manually: https://nodejs.org"
      ;;
  esac
  return 1
}

# ---------------------------------------------------------------------------

msg "=== Claude Model Changer - Installer ==="
msg "Plugin directory: $PLUGIN_DIR"
echo

# 1. Node.js check (with auto-install attempt)
current_major="$(node_major)"
if [ "$current_major" -lt "$MIN_NODE_MAJOR" ]; then
  warn "Node.js not found or too old (found major=$current_major, need >= $MIN_NODE_MAJOR)"
  if try_install_node; then
    current_major="$(node_major)"
    if [ "$current_major" -lt "$MIN_NODE_MAJOR" ]; then
      fail "Auto-install completed but Node.js still < $MIN_NODE_MAJOR. Aborting."
      exit 1
    fi
    ok "Node.js installed: $(node --version)"
  else
    fail "Could not install Node.js automatically. Aborting."
    exit 1
  fi
else
  ok "Node.js present: $(node --version)"
fi

# 2. Central ~/.claude directory check
CLAUDE_HOME="${HOME:-$USERPROFILE}/.claude"
if [ ! -d "$CLAUDE_HOME" ]; then
  fail "Central Claude directory not found: $CLAUDE_HOME"
  warn "Run Claude Code at least once before installing plugins."
  exit 1
fi
ok "Central Claude directory: $CLAUDE_HOME"

# 3. Claude Code CLI check (informational - plugin works without claude on PATH
#    at install time, but you'll need it to actually use the plugin)
if command -v claude >/dev/null 2>&1; then
  ok "Claude Code CLI: $(claude --version 2>/dev/null || echo present)"
else
  warn "Claude Code CLI not on PATH. Install location is fine, but you'll need"
  warn "the 'claude' command to actually use the plugin."
fi

# 4. Preflight (full structure, JSON validity, hook references, logs writable, hook dry-run,
#    central .claude/ writability, install-plugin.js present)
msg "Running preflight checks..."
if ! node "$PLUGIN_DIR/scripts/preflight.js"; then
  fail "Preflight failed. Installation aborted - see errors above."
  exit 1
fi

# 5. Install via the project's own installer (copies to ~/.claude/plugins/cache/...
#    and registers in installed_plugins.json + settings.json)
msg "All prerequisites met. Installing plugin to central Claude directory..."
if node "$PLUGIN_DIR/scripts/install-plugin.js"; then
  ok "Plugin installed successfully."
else
  fail "scripts/install-plugin.js failed. Check output above."
  exit 1
fi

echo
ok "Installation complete. Restart Claude Code to activate the plugin."
