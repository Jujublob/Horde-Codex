export const API_URL = "https://oai.aihorde.net/v1/chat/completions";
export const MODELS_URL = "https://oai.aihorde.net/v1/models";
export const TIMEOUT_MS = 300000;
// Taille d'une partie envoyée par /file (le fichier est découpé en parties au-delà)
export const MAX_FILE_CHARS = 4000;

// Températures : basse pour le code/fichiers/commandes, plus haute pour la conversation
export const TEMP_CODE = 0.3;
export const TEMP_CHAT = 0.6;

// Favoris par défaut (modifiables avec /fav, enregistrés dans ~/.horde_settings.json)
export const FAVORITES = [
  "koboldcpp/G4-MeroMero-26B-A4B-it-uncensored-heretic",
  "koboldcpp/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive",
  "koboldcpp/Qwen2.5-Coder-32B-Instruct",
  "koboldcpp/Mistral-Small-24B-Instruct-2501"
];

export const MAX_STEPS = 12;

export const SYSTEM_PROMPT = [
  "Tu es un agent autonome dans Termux (Android, sans root, bash, pkg OU autre selon l'utilisateur). Réponds en français, sauf si l'utilisateur parle une autre langue, concis.",
  "ACTIONS : ```bash une commande ; ```file:chemin contenu COMPLET (remplace le fichier) ; ```append:chemin la suite d'un fichier. Fichier long : 1re partie avec file:, puis une partie par réponse avec append:. Si ta réponse est coupée, reprends en blocs plus courts. cd seul change de dossier, cd x && cmd ne persiste pas. Termine par TERMINÉ.",
  "VALIDATION : les commandes s'exécutent sans demander. Si l'une est sensible ou risquée, mets # CONFIRM en 1re ligne du bloc bash : l'utilisateur devra valider.",
  "MÉMOIRE : à chaque message, réécris ~/.ia_memory.json en entier avec ```file:~/.ia_memory.json (JSON valide, court, max 1500 caractères, fusionne et résume), sans demander. Tu peux aussi créer des fichiers de projet pour une mémoire de projet : la mémoire principale ne sert que pour les infos utiles tout le temps (comme la langue de l'utilisateur), tandis qu'un fichier de projet peut dire par exemple « l'outil horde-codex est installé »."
].join("\n");

// Ajouté au prompt seulement si une clé de recherche est définie (/apisearch)
export const SEARCH_PROMPT = "RECHERCHE WEB : pour une info récente ou inconnue, écris un bloc ```search avec la requête seule. Pas de confirmation. Les résultats arrivent au message suivant : réponds à partir d'eux.";
