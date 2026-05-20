#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/NANA3333333/ChatPulseGroupLogic.git"
ST_DIR="${SILLYTAVERN_DIR:-$HOME/SillyTavern}"
EXT_DIR="$ST_DIR/data/default-user/extensions/third-party/ChatPulseGroupLogic"
SERVER_PLUGIN_SRC="$EXT_DIR/server-plugin/chatpulse_group_logic_debug"
SERVER_PLUGIN_DST="$ST_DIR/plugins/chatpulse_group_logic_debug"

echo "[ChatPulseGroupLogic] SillyTavern: $ST_DIR"
mkdir -p "$(dirname "$EXT_DIR")"

if [ -d "$EXT_DIR/.git" ]; then
    echo "[ChatPulseGroupLogic] Updating local user extension..."
    git -C "$EXT_DIR" pull --ff-only
else
    echo "[ChatPulseGroupLogic] Installing local user extension..."
    rm -rf "$EXT_DIR"
    git clone "$REPO_URL" "$EXT_DIR"
fi

if [ -d "$SERVER_PLUGIN_SRC" ]; then
    echo "[ChatPulseGroupLogic] Installing optional debug server plugin..."
    mkdir -p "$ST_DIR/plugins"
    rm -rf "$SERVER_PLUGIN_DST"
    cp -R "$SERVER_PLUGIN_SRC" "$SERVER_PLUGIN_DST"
fi

echo "[ChatPulseGroupLogic] Installed version:"
grep '"version"' "$EXT_DIR/manifest.json" || true
echo "[ChatPulseGroupLogic] Done. Restart SillyTavern, then refresh the mobile page."
