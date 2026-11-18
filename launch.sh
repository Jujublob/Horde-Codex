#!/bin/bash
if [ -z "$AI_HORDE_API_KEY" ]; then
    echo "⚠️  ERREUR : AI_HORDE_API_KEY non définie."
    echo "export AI_HORDE_API_KEY='votre_cle'"
    exit 1
fi
cd ~/horde-codex-portable/src
if [ ! -d node_modules ]; then
    echo "[INFO] Installation des dépendances (npm install)..."
    npm install
fi
node index.js
