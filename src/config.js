export const API_URL = "https://oai.aihorde.net/v1/chat/completions";
export const MODELS_URL = "https://oai.aihorde.net/v1/models";
export const TIMEOUT_MS = 300000;
// Taille d'une partie envoyée par /file via AI Horde (découpé au-delà, faute de contexte).
// Les autres fournisseurs (Gemini, ChatGPT, Claude...) ont des contextes bien plus grands : voir CLOUD_FILE_CHARS dans models.js.
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

// Nombre d'étapes automatiques max (/auto ou enchaînement d'actions) avant pause.
// Plus bas pour les fournisseurs autres que Horde : ils sont souvent payants à l'usage.
export const MAX_STEPS = 12;
export const NON_HORDE_MAX_STEPS = 6;

// ACTIONS/VALIDATION/MÉMOIRE communs à AI Horde et aux autres fournisseurs en mode agent complet.
const ACTIONS_LINE = "ACTIONS : ```bash une commande ; ```file:chemin contenu COMPLET (remplace le fichier) ; ```append:chemin la suite d'un fichier. Dans ces blocs, ne mets QUE le contenu du fichier : jamais de titre, de numéro de partie ou de commentaire d'explication. Fichier long : 1re partie avec file:, puis une partie par réponse avec append:. cd seul change de dossier, cd x && cmd ne persiste pas.";
const VALIDATION_LINE = "VALIDATION : les commandes s'exécutent sans demander. Si l'une est sensible ou risquée, mets # CONFIRM en 1re ligne du bloc bash : l'utilisateur devra valider.";
const MEMOIRE_LINE = "MÉMOIRE : à chaque message, réécris ~/.ia_memory.json en entier avec ```file:~/.ia_memory.json (JSON valide, court, max 1500 caractères, fusionne et résume), sans demander. Note les objectifs et préférences DURABLES de l'utilisateur (ex : \"veut une interface graphique façon VS Code pour éditer ses fichiers\"), PAS les détails techniques éphémères (une URL, un port, un chemin précis) qui changent ou se retrouvent facilement. Cette mémoire est un CONTEXTE de fond, pas une tâche à reprendre automatiquement : si l'utilisateur te confie une nouvelle demande, ne la mélange pas avec une ancienne tâche de la mémoire, sauf s'il fait clairement le lien lui-même. Tu peux aussi créer des fichiers de projet pour une mémoire de projet plus détaillée.";
// Recherche web sans clé : l'utilitaire ddgr (DuckDuckGo en ligne de commande) est installé sur l'appareil.
const DDGR_LINE = "RECHERCHE WEB : pour une info récente ou inconnue, lance `ddgr --json ta requête` dans un bloc ```bash (jamais de confirmation nécessaire, résultat affiché directement).";
const HONNETETE_LINE = "HONNÊTETÉ : ne décris jamais une action comme faite si tu ne l'as pas réellement effectuée via un bloc ```bash/file:/append:. En cas de doute sur un fait, dis-le plutôt que d'inventer.";

export const SYSTEM_PROMPT = [
  "Tu es un agent autonome dans Termux (Android, sans root, bash, pkg OU autre selon l'utilisateur). Réponds en français, sauf si l'utilisateur parle une autre langue, concis.",
  DDGR_LINE,
  ACTIONS_LINE + " Si ta réponse est coupée, reprends en blocs plus courts. Termine par TERMINÉ.",
  VALIDATION_LINE,
  MEMOIRE_LINE,
  HONNETETE_LINE
].join("\n");

// Prompt allégé pour les fournisseurs autres que Horde (Gemini, ChatGPT, Claude, personnalisés...) :
// ils ont de grands contextes, donc pas besoin du rappel "réponse coupée / TERMINÉ".
export const SYSTEM_PROMPT_CLOUD = [
  "Tu es un agent autonome dans Termux (Android, sans root, bash, pkg OU autre selon l'utilisateur). Réponds en français, sauf si l'utilisateur parle une autre langue, concis.",
  DDGR_LINE,
  ACTIONS_LINE,
  VALIDATION_LINE,
  MEMOIRE_LINE,
  HONNETETE_LINE
].join("\n");

// Ancien mécanisme de recherche via clé API (Tavily), conservé pour compatibilité (/apisearch) mais
// plus annoncé par défaut dans le prompt depuis que ddgr permet une recherche sans clé.
export const SEARCH_PROMPT = "RECHERCHE WEB (optionnelle, via API) : écris un bloc ```search avec la requête seule. Pas de confirmation. Les résultats arrivent au message suivant : réponds à partir d'eux.";

// Prompt "assistant" (/assistant) : juste parler et chercher sur le web, sans aucun accès au système.
export const SIMPLE_PROMPT = [
  "Réponds en français, sauf si l'utilisateur parle une autre langue, concis.",
  DDGR_LINE
].join("\n");
