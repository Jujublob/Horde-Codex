import fs from 'fs';
import os from 'os';
import { SYSTEM_PROMPT, SYSTEM_PROMPT_CLOUD, SEARCH_PROMPT, SIMPLE_PROMPT } from './config.js';
import { getSearchKey } from './settings.js';
import { globalMemoryPath, memoryPath, sharedMemoryPath, readSharedMemory } from './convos.js';

// Conversation active (fixée au lancement / après /resume ou /new) : c'est elle qui détermine
// quel fichier de mémoire est lu et demandé à l'IA. La mémoire globale (~/.horde-cli-memoire/global.json)
// est toujours injectée en plus. Les deux vivent hors du dossier du programme.
let currentConvId = null;
export function setActiveConversation(id) { currentConvId = id; }
export function activeConversationId() { return currentConvId; }

// provider : 'horde' (par défaut) ou l'id d'un autre fournisseur (gemini, openai, claude...)
// simple : true = mode "assistant" (juste parler + chercher, aucun accès au système, voir /assistant)
// isAgent : true = mode agent autonome en tâche de fond (accède à la mémoire partagée des agents)
export function buildSystem(provider = 'horde', simple = false, isAgent = false) {
  if (simple) return SIMPLE_PROMPT;

  const globMem = readMemoryRaw(globalMemoryPath());
  const convMem = currentConvId != null ? readMemoryRaw(memoryPath(currentConvId)) : '';
  // Mémoire partagée : injectée uniquement pour les agents en tâche de fond
  const sharedMem = isAgent ? readMemoryRaw(sharedMemoryPath(), 5000) : '';
  let ls = '';
  try { ls = fs.readdirSync(process.cwd()).slice(0, 40).join(', '); } catch {}
  const isHorde = provider === 'horde';
  const base = isHorde ? SYSTEM_PROMPT : SYSTEM_PROMPT_CLOUD;
  // Ancien mécanisme de recherche par clé API (Tavily), optionnel et réservé à Horde pour ne pas
  // surcharger le prompt des autres fournisseurs qui ont souvent déjà leur propre recherche.
  const search = (isHorde && getSearchKey()) ? '\n' + SEARCH_PROMPT : '';
  const convLine = currentConvId != null
    ? `Conversation n°${currentConvId} — mémoire de cette conversation (${memoryPath(currentConvId)}) : ${convMem || '(vide)'}`
    : '';
  // Ligne mémoire partagée pour les agents
  const agentLine = isAgent && sharedMem
    ? `MÉMOIRE PARTAGÉE DES AUTRES AGENTS (à consulter pour éviter les conflits et les doublons) :\n${sharedMem}`
    : '';
  return [
    base + search, '',
    `Dossier courant : ${process.cwd()}`,
    "ACCES : tu peux lire et modifier TOUS les fichiers de l'utilisateur, pas seulement le dossier courant. Utilise des chemins absolus. Home : " + os.homedir() + ". Pour explorer, lance ls ~ ou find ~ -maxdepth 2, ne te limite jamais au dossier courant.",
    "Contenu du home : " + (() => { try { return fs.readdirSync(os.homedir()).slice(0, 40).join(', '); } catch { return ''; } })(),
    `Contenu : ${ls}`,
    `Date : ${new Date().toLocaleString('fr-FR')}`,
    `Mémoire globale (${globalMemoryPath()}) : ${globMem || '(vide)'}`,
    convLine,
    agentLine
  ].filter(Boolean).join('\n');
}

// Lecture directe d'un fichier JSON tronqué (évite une dépendance vers convos.js dans ce sens-là)
function readMemoryRaw(p, maxChars = 3000) {
  try { return fs.readFileSync(p, 'utf-8').slice(0, maxChars); } catch { return ''; }
}
