# Journal des modifications — HordeCLI (anciennement Horde Codex)

Numérotation indicative (pas de tags Git officiels tant que tu ne les poses pas toi-même).

## 1.9.1 — Correctif de syntaxe, l'IA lance elle-même des agents, fiabilité du multi-agents
- **Correctif bloquant** : apostrophe droite introduite par erreur dans `index.js` (`d'espace` au lieu de `d’espace`) → `SyntaxError` au démarrage. Corrigé (2 occurrences). Tout le nouveau code a été validé syntaxiquement avec un moteur JavaScript réel avant livraison.
- **L'IA sait maintenant qu'elle peut lancer des agents** : nouveau `AGENTS_PROMPT` (config.js) injecté dans le prompt système de la conversation principale ET des agents (sauf mode assistant). Convention unique : bloc ```agent:<modèle> <auto|safe> pour déléguer, lignes /agents, /agent stop|resume|msg|new pour piloter.
- **Ces demandes sont réellement exécutées** : `processAgentControl` parse les réponses de n'importe quelle IA (principale, superviseur, agent) et exécute les délégations/commandes ; les états et résultats sont renvoyés au modèle au message suivant. Avant, le superviseur donnait des ordres que personne n'exécutait.
- **Les agents ne travaillent plus à l'aveugle** : les résultats de leurs commandes/écritures sont réinjectés dans leur conversation (avant, ils ne voyaient jamais la sortie).
- **Vrais bugs corrigés dans la boucle des agents** : prompt système réellement injecté à chaque étape ; message initial `user` avec la tâche (compatible Claude) ; détection de fin uniquement quand TERMINÉ est la dernière ligne (plus d'arrêt prématuré sur le mot « terminé » en milieu de phrase) ; une seule boucle par agent ; appel API interruptible par /agent stop.
- **Sécurité en arrière-plan alignée sur le premier plan** : commandes dangereuses, fichier de clés API, # CONFIRM, raccourcissement suspect de fichier → mise en pause avec action en attente. `/agent resume <n°>` vaut validation et exécute l'action ; `/agent stop <n°>` annule. Le mode safe met toute action sensible en attente. Les agents n'écrivent plus jamais via le readline du premier plan.
- **Dossier figé par agent** : un `/cd` du premier plan ne déplace plus les agents en cours.
- **Persistance par conversation corrigée** : chaque conversation sauvegarde SES agents dans son propre `agents.json` ; `/resume` et le lancement restaurent le groupe d'agents de la conversation (en pause). Supprimer une conversation supprime ses agents.
- **/stop ne touche que le premier plan** : les agents continuent ; chacun s'arrête avec `/agent stop <n°>`.
- **Commandes agents disponibles même quand l'IA travaille** : /agents, /agents watch, /agent ..., /supervise passent pendant que le premier plan est occupé.
- **/agents watch corrigé** : bascule marche/arrêt, s'arrête tout seul quand plus aucun agent n'est actif, Ctrl+C quitte la surveillance sans quitter le programme.
- **Garde-fou anti-récursion** : profondeur de délégation limitée à 4 (pas de limite sur le nombre d'agents en parallèle).

## 1.9.0 — Superviseur IA, persistance des agents, suppression du timeout
- **Suppression du timeout de 120 secondes** dans `run()` (exec.js) : les commandes longues tournent autant que nécessaire ; interruption via /stop ou Ctrl+C.
- **Superviseur IA** : `/supervise <modèle> "<tâche>"` lance une IA qui découpe, délègue, vérifie et recadre des agents, en respectant la mémoire globale de l'utilisateur.
- **Persistance des agents** dans la conversation ; restauration via `/resume` (en pause).
- **`/agents watch`** : tableau de bord rafraîchi toutes les 2 secondes.
- **`/agent msg <n°> "<message>"`** : parler à un agent ; **`/agent clear-shared`** : vider la mémoire partagée.

## 1.8.0 — Système multi-agents et correction critique
- **Correction critique de `launch.sh`** : suppression des chemins codés en dur ; détection automatique du dossier du script et de `src/`.
- **Système multi-agents autonome** : plusieurs agents en tâche de fond, chacun avec son modèle ; exécution asynchrone non bloquante ; mémoire partagée (`~/.horde-cli-memoire/agents_shared.json`) ; sorties minimalistes (une phrase + l'action).
- **Commandes** : `/agent new`, `/agents`, `/agent stop`, `/agent resume`.

## 1.7.0 — Recherche sans clé, fiabilité, mode assistant, renommage
- Projet renommé **HordeCLI** (bandeau, `package.json`).
- Recherche web sans clé API : l'IA lance `ddgr --json ta requête` dans un bloc bash (corrigé automatiquement si le modèle oublie `--json`, ajouté à la liste des commandes sans confirmation). L'ancien mécanisme par clé (Tavily, `/apisearch`) reste disponible mais n'est plus mis en avant dans le prompt.
- Prompt : instruction de ne mettre que le contenu du fichier dans un bloc `file:`/`append:` (jamais de titre ni de commentaire) ; mémoire décrite comme un contexte de fond (pas une tâche à reprendre automatiquement) et consigne de n'y noter que des objectifs durables, pas des détails techniques éphémères (URL, port...) ; ligne anti-hallucination ("ne décris jamais une action que tu n'as pas faite").
- `/clear` propose maintenant de vider aussi `~/.ia_memory.json`, pour repartir d'une mémoire propre.
- Nouvelle commande `/assistant` : bascule en mode "juste parler et chercher" (comme une appli de chat classique), sans aucun accès au système — seul `ddgr` reste autorisé.
- Anti-boucle : une commande de lecture déjà exécutée dans la même suite d'étapes n'est plus relancée (évite de re-vérifier indéfiniment les mêmes fichiers).
- Vérification automatique après chaque écriture de fichier (`node --check`, `python -m py_compile`, `bash -n`, JSON) : l'IA est informée si le fichier qu'elle vient d'écrire a un problème.
- Confirmation exigée (même en mode auto) quand un `file:` remplacerait un fichier existant par un contenu nettement plus court (signe probable d'erreur).
- Sauvegardes en rotation (jusqu'à 3 : `.bak`, `.bak.2`, `.bak.3`) au lieu d'une seule écrasée à chaque fois.
- Correction d'affichage : les blocs `file:`/`append:`/`search` ne faisaient plus planter le rendu de la réponse.
- Avertissement si le failover bascule vers un modèle plus petit (moins de 20B).

## 1.6.0 — Ajustements multi-fournisseurs
- Correction : une écriture de fichier qui échoue (`file:`) ne bloque plus le programme, l'IA en est informée.
- Nombre d'étapes automatiques réduit (6 au lieu de 12) pour les fournisseurs autres qu'AI Horde.
- Avertissement (une fois par session) à la première utilisation d'un fournisseur payant.
- Nouvelle tentative automatique (une fois, après 1s) sur une erreur temporaire (429/5xx) des fournisseurs autres que Horde.
- Budget de tokens et taille de fichier (`/file`) adaptés à chaque fournisseur (Horde reste volontairement petit).
- Prompt système différent pour Horde et pour les autres fournisseurs (plus léger).
- Dernier modèle utilisé mémorisé par fournisseur (`/use <fournisseur>` sans nom de modèle).
- Icônes et couleurs par fournisseur/modèle (Gemini, Claude, ChatGPT/Qwen, Horde, personnalisé).

## 1.5.0 — Multi-fournisseurs IA
- `settings.js` : stockage des fournisseurs (Gemini, ChatGPT, Claude, OpenRouter, Groq, Mistral, DeepSeek, Together, ou personnalisé).
- `models.js` : références de modèles `@fournisseur:nom`.
- Commandes `/api`, `/api add`, `/api del`, `/api test`, `/live <fournisseur> [mots]`, `/use <fournisseur> <modèle>`.

## 1.4.0 — Clés API persistantes
- `/apihorde` et `/apisearch` : clés stockées dans `~/.horde_settings.json`, hors du dossier du programme (survivent aux mises à jour).
- Le fichier des clés est protégé : validation toujours obligatoire avant lecture/écriture par l'IA.

## 1.3.0 — Contrôle et confort
- `/stop` et Ctrl+C (double) pour interrompre l'IA à tout moment, y compris en mode auto.
- `/fav` : favoris illimités (add/del/reset), remplace l'ancienne liste figée `/1`-`/4`.
- `/file <chemin> [n°]` : envoi d'un gros fichier par parties.
- Nouveau visuel (bandeau, spinner, `/help` par sections).

## 1.2.0 — Fiabilité de l'API
- Blocs ```append:chemin``` pour écrire un fichier en plusieurs réponses.
- Détection d'une réponse coupée par la limite de tokens, avec consigne de reprise.
- Température variable (basse pour le code, plus haute pour la conversation).
- Timeout sur la liste des modèles, messages d'erreur plus clairs.

## 1.1.0 — Recherche web
- Blocs ```search requête``` : l'IA lance une recherche de sa propre initiative, sans confirmation.
- Correctifs : plus de recherche automatique par mots-clés, plus de doublon de résultats après un changement de modèle.

## 1.0.0 — Version de départ
- Agent terminal autonome via AI Horde, actions `bash`/`file:`, mémoire `~/.ia_memory.json`, favoris fixes, sauvegarde de session.
