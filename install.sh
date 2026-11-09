#!/usr/bin/env bash
# Conflux installer for Linux and macOS.
#
#   gh repo clone Gamface/Conflux ~/conflux && ~/conflux/install.sh
#   (or: git clone https://github.com/Gamface/Conflux.git ~/conflux && ~/conflux/install.sh)
#
# Options: --yes (no prompts)  --no-browser  --no-desktop  --service (systemd user service)  --no-start
#
# Does only this, inside the Conflux folder (no sudo, except Chromium's system libraries if missing):
#   1. Ensures Node.js 22.18+ (offers to install it per-user with nvm if missing/too old)
#   2. npm install
#   3. Chromium for the browser coworker (Playwright)
#   4. agent-cu for desktop control, installed locally into node_modules
#   5. Builds the web UI, runs the test suite and `doctor`
#   6. Adds a "Conflux" launcher (app menu) and optionally a systemd user service, then starts it
set -euo pipefail

YES=0; BROWSER=1; DESKTOP=1; SERVICE=0; START=1
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1 ;; --no-browser) BROWSER=0 ;; --no-desktop) DESKTOP=0 ;;
    --service) SERVICE=1 ;; --no-start) START=0 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
ok() { printf '    \033[32m%s\033[0m\n' "$*"; }
warn() { printf '    \033[33m%s\033[0m\n' "$*"; }
ask() { [ "$YES" = 1 ] && return 0; read -r -p "    $1 [Y/n] " r; [[ ! "$r" =~ ^([nN]|no)$ ]]; }

[ -f package.json ] && grep -q '"name": "conflux"' package.json || { echo "Run this from the Conflux folder (it lives next to package.json)."; exit 1; }

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'
}

step "Checking Node.js (need 22.18 or newer)"
if ! node_ok; then
  command -v node >/dev/null 2>&1 && warn "Found Node $(node -v), which is too old." || warn "Node.js is not installed."
  if ask "Install Node.js 22 for your user with nvm (no sudo)?"; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    fi
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm install 22
    nvm use 22 >/dev/null
  else
    echo "Install Node.js 22.18+ (https://nodejs.org) and run ./install.sh again."; exit 1
  fi
  node_ok || { echo "Node 22.18+ still not active; open a new terminal and re-run ./install.sh"; exit 1; }
fi
ok "Node $(node -v)"

step "Installing dependencies"
npm install --no-audit --no-fund

if [ "$BROWSER" = 1 ]; then
  step "Installing Chromium for the browser coworker"
  if ! npx playwright install --with-deps chromium 2>/dev/null; then
    warn "Could not install Chromium's system libraries (needs sudo); installing the browser only."
    npx playwright install chromium || warn "Chromium install failed; browser tools will be unavailable."
  fi
fi

if [ "$DESKTOP" = 1 ]; then
  step "Installing agent-cu for desktop control (local, no sudo)"
  npm install --no-save --no-audit --no-fund agent-cu || warn "agent-cu install failed; desktop tools will be unavailable."
  chmod +x node_modules/agent-cu/bin/agent-computer-use-* 2>/dev/null || true
  if [ "$(uname)" = "Linux" ]; then
    command -v busctl >/dev/null 2>&1 && busctl --user list 2>/dev/null | grep -q org.a11y.Bus \
      && ok "Accessibility bus (AT-SPI) is running" \
      || warn "AT-SPI accessibility bus not detected. Desktop control needs a graphical session with accessibility enabled (GNOME/KDE: on by default)."
  fi
fi

step "Building the web UI"
npm run build:web

step "Running the test suite"
npm test

step "Checking capabilities"
node bin/conflux.ts doctor

# Launcher scripts
cat > "$DIR/start-conflux.sh" <<EOF
#!/usr/bin/env bash
cd "$DIR"
[ -s "\${NVM_DIR:-\$HOME/.nvm}/nvm.sh" ] && . "\${NVM_DIR:-\$HOME/.nvm}/nvm.sh" >/dev/null && nvm use 22 >/dev/null 2>&1 || true
( sleep 2
  if command -v xdg-open >/dev/null; then xdg-open http://127.0.0.1:8787 >/dev/null 2>&1
  elif command -v open >/dev/null; then open http://127.0.0.1:8787; fi ) &
exec node apps/server/src/main.ts
EOF
chmod +x "$DIR/start-conflux.sh"

if [ "$(uname)" = "Linux" ]; then
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/conflux.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Conflux
Comment=Start Conflux and open it in your browser
Exec=$DIR/start-conflux.sh
Terminal=true
Categories=Development;Utility;
EOF
  ok "App launcher: Conflux (in your applications menu)"

  if [ "$SERVICE" = 1 ]; then
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/conflux.service" <<EOF
[Unit]
Description=Conflux AI coworkers

[Service]
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/apps/server/src/main.ts
Restart=on-failure

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload && systemctl --user enable --now conflux.service \
      && ok "systemd user service enabled: systemctl --user status conflux" \
      || warn "Could not enable the systemd user service."
    START=0
  fi
fi

printf '\n\033[32mConflux is installed in %s\033[0m\n' "$DIR"
echo "  Start: $DIR/start-conflux.sh   (or the 'Conflux' app launcher), then open http://127.0.0.1:8787"
echo "  Real models: export ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY, or OLLAMA_HOST=http://localhost:11434"

if [ "$START" = 1 ]; then
  step "Starting Conflux (Ctrl+C to stop)"
  exec "$DIR/start-conflux.sh"
fi
