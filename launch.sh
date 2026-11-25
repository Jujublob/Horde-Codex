#!/usr/bin/env bash
set -e

# 1. Détermine le répertoire réel du script, peu importe son nom ou d'où il est lancé
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# 2. Le code source est soit dans ce répertoire, soit dans un sous-dossier src/
if [ -d "$SCRIPT_DIR/src" ]; then
    TARGET_DIR="$SCRIPT_DIR/src"
else
    TARGET_DIR="$SCRIPT_DIR"
fi

if [ -z "${AI_HORDE_API_KEY:-}" ]; then
    echo "[INFO] AI_HORDE_API_KEY non définie : HordeCLI démarre avec la clé anonyme (limites plus basses)."
    echo "[INFO] Astuce : utilise /apihorde ta_cle dans le programme pour la sauvegarder durablement."
fi

if [ ! -d "$TARGET_DIR" ]; then
    echo "[ERREUR] Répertoire du code introuvable dans : $TARGET_DIR"
    echo "[INFO] Vérifie que tu as extrait l'archive au bon endroit."
    exit 1
fi

cd "$TARGET_DIR"

if [ ! -d "node_modules" ]; then
    echo "[INFO] Première utilisation ou mise à jour : installation des dépendances..."
    npm install
fi

# Lance le programme de manière transparente (remplace le processus bash)
exec node index.js
