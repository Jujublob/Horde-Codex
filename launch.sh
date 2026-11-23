#!/usr/bin/env bash

set -e

APP_DIR="$HOME/horde-codex-portable"
SRC_DIR="$APP_DIR/src"

if [ -z "${AI_HORDE_API_KEY:-}" ]; then
    echo "[INFO] AI_HORDE_API_KEY non définie : HordeCLI démarre avec la clé anonyme d'AI Horde (limites plus basses)."
    echo "[INFO] Pour utiliser ta propre clé de façon durable : /apihorde ta_cle une fois dans le programme."
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "[ERREUR] HordeCLI est introuvable dans : $APP_DIR"
    exit 1
fi

cd "$SRC_DIR"

if [ ! -d node_modules ]; then
    echo "[INFO] Installation des dépendances..."
    if ! npm install; then
        echo "[INFO] Échec de l'installation : nouvel essai avec plus de détails (--loglevel=verbose)."
        npm install --loglevel=verbose
    fi
fi

exec node index.js
