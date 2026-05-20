#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/NANA3333333/ChatPulseGroupLogic.git"
ST_DIR="${SILLYTAVERN_DIR:-$HOME/SillyTavern}"
EXT_ROOT="$ST_DIR/data/default-user/extensions"
EXT_DIR="$EXT_ROOT/ChatPulseGroupLogic"
WRONG_NESTED_EXT_DIR="$EXT_ROOT/third-party/ChatPulseGroupLogic"
SERVER_PLUGIN_SRC="$EXT_DIR/server-plugin/chatpulse_group_logic_debug"
SERVER_PLUGIN_DST="$ST_DIR/plugins/chatpulse_group_logic_debug"
SETTINGS_FILE="$ST_DIR/data/default-user/settings.json"

echo "[ChatPulseGroupLogic] SillyTavern: $ST_DIR"
mkdir -p "$EXT_ROOT"

if [ -d "$WRONG_NESTED_EXT_DIR" ]; then
    echo "[ChatPulseGroupLogic] Removing old wrongly-nested install: $WRONG_NESTED_EXT_DIR"
    rm -rf "$WRONG_NESTED_EXT_DIR"
    rmdir "$EXT_ROOT/third-party" 2>/dev/null || true
fi

if [ -d "$EXT_DIR/.git" ]; then
    echo "[ChatPulseGroupLogic] Updating local user extension..."
    git -C "$EXT_DIR" pull --ff-only
else
    echo "[ChatPulseGroupLogic] Installing local user extension..."
    if [ -d "$EXT_DIR" ]; then
        BACKUP_DIR="$EXT_DIR.backup.$(date +%Y%m%d%H%M%S)"
        echo "[ChatPulseGroupLogic] Existing non-git folder moved to: $BACKUP_DIR"
        mv "$EXT_DIR" "$BACKUP_DIR"
    fi
    git clone "$REPO_URL" "$EXT_DIR"
fi

if [ -d "$SERVER_PLUGIN_SRC" ]; then
    echo "[ChatPulseGroupLogic] Installing optional debug server plugin..."
    mkdir -p "$ST_DIR/plugins"
    rm -rf "$SERVER_PLUGIN_DST"
    cp -R "$SERVER_PLUGIN_SRC" "$SERVER_PLUGIN_DST"
fi

if [ -f "$SETTINGS_FILE" ]; then
    echo "[ChatPulseGroupLogic] Enabling extension in settings.json..."
    node - "$SETTINGS_FILE" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
settings.extension_settings ||= {};
const disabled = Array.isArray(settings.extension_settings.disabledExtensions)
    ? settings.extension_settings.disabledExtensions
    : [];
const blockedNames = new Set([
    'ChatPulseGroupLogic',
    'third-party/ChatPulseGroupLogic',
    '/ChatPulseGroupLogic',
]);
settings.extension_settings.disabledExtensions = disabled.filter(name => !blockedNames.has(String(name)));
settings.extension_settings.ChatPulseGroupLogic ||= {};
settings.extension_settings.ChatPulseGroupLogic.enabled = true;
settings.extension_settings.ChatPulseGroupLogic.orchestratedEntry = true;
fs.writeFileSync(file, JSON.stringify(settings, null, 4));
NODE
fi

echo "[ChatPulseGroupLogic] Installed version:"
grep '"version"' "$EXT_DIR/manifest.json" || true
echo "[ChatPulseGroupLogic] Frontend URL should resolve to:"
echo "  /scripts/extensions/third-party/ChatPulseGroupLogic/manifest.json"
echo "[ChatPulseGroupLogic] Done. Restart SillyTavern, then refresh the mobile page."
