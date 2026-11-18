#!/usr/bin/env bash

set -e

APP_DIR="$HOME/horde-codex-portable"
SRC_DIR="$APP_DIR/src"

if [ -z "${AI_HORDE_API_KEY:-}" ]; then
    echo "[ERREUR] AI_HORDE_API_KEY n'est pas définie."
    echo "Exécute : export AI_HORDE_API_KEY='votre_cle'"
    exit 1
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "[ERREUR] Horde-Codex est introuvable dans : $APP_DIR"
    exit 1
fi

cd "$SRC_DIR"

if [ ! -d node_modules ]; then
    echo "[INFO] Installation des dépendances..."
    npm install
fi

exec node index.js
