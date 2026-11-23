HordeCLI — agent IA autonome dans Termux (anciennement Horde Codex)

RECHERCHE WEB :
- Par défaut, l'IA cherche sur le web avec ddgr (DuckDuckGo en ligne de commande), installé
  séparément sur l'appareil (pas via pkg install ; voir la documentation de ddgr pour ton cas).
  Aucune clé API n'est nécessaire.
- Un ancien mécanisme optionnel existe aussi, via une clé API (tavily.com) : /apisearch ta_clé
  dans le programme. Sans ddgr ni clé, l'IA te le signale simplement, le reste fonctionne normalement.

CLÉ AI HORDE (optionnelle) :
- Par défaut, HordeCLI utilise une clé anonyme (limites plus basses, modèles parfois saturés).
- Pour utiliser ta propre clé, inscris-toi sur aihorde.net puis, dans le programme :
  /apihorde ta_clé
  Elle est enregistrée dans ~/.horde_settings.json (hors du dossier du programme) et survit
  aux mises à jour.

AUTRES IA (Gemini, ChatGPT, Claude, OpenRouter, Groq...) :
- /api add pour ajouter une clé via un menu guidé, ou /api add <id> <clé> en une ligne.
- Si l'une de ces API (ou AI Horde) ne répond plus (quota, panne), le programme te propose de
  basculer vers une autre de celles que tu as configurées.

CONVERSATIONS ET MÉMOIRE :
- Chaque conversation a sa propre mémoire, plus une mémoire globale partagée entre toutes.
- /resume pour voir et reprendre une autre conversation, /new pour en ouvrir une nouvelle.
- Tout est stocké hors du dossier du programme (~/.horde-cli-memoire/, ~/.horde_settings.json) :
  une mise à jour du code (git pull, copie de fichiers) ne touche jamais ces données.

INSTALLATION (Termux) :
- Si `npm install` échoue ou semble planter sans message clair, réessaie avec :
  npm install --loglevel=verbose
  pour voir le détail de l'erreur.

Tape /help une fois dans le programme pour la liste complète des commandes.
