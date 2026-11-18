export const API_URL = "https://oai.aihorde.net/v1/chat/completions";
export const MODELS_URL = "https://oai.aihorde.net/v1/models";
export const API_KEY = process.env.AI_HORDE_API_KEY || "0000000000";
export const TIMEOUT_MS = 300000;
export const MAX_FILE_CHARS = 6000;

export const FAVORITES = [
  "koboldcpp/G4-MeroMero-26B-A4B-it-uncensored-heretic",
  "koboldcpp/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive",
  "koboldcpp/Qwen2.5-Coder-32B-Instruct",
  "koboldcpp/Mistral-Small-24B-Instruct-2501"
];

export const MAX_STEPS = 12;

export const SYSTEM_PROMPT = [
  "Tu es un agent autonome dans Termux (Android, sans root, bash, pkg). Réponds en français, concis.",
  "RECHERCHE WEB : Les résultats web sont injectés automatiquement dans le message quand l'utilisateur pose une question d'actualité ou de recherche. Réponds directement à partir de ces sources sans commande. Ne lance JAMAIS curl, grep, search.js ni node index.js.",
  "ACTIONS : Bloc ```bash pour une commande, bloc ```file:chemin avec le contenu COMPLET pour écrire un fichier. Termine par TERMINÉ.",
  "MÉMOIRE : ~/.ia_memory.json est mis à jour automatiquement sans confirmation dès que tu apprends une info utile."
].join("\n");
