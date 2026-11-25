import fs from 'fs';
import os from 'os';
import { SYSTEM_PROMPT, SYSTEM_PROMPT_CLOUD, SEARCH_PROMPT, SIMPLE_PROMPT } from './config.js';
import { getSearchKey } from './settings.js';
import { globalMemoryPath, memoryPath, sharedMemoryPath, readSharedMemory } from './convos.js';

let currentConvId = null;
export function setActiveConversation(id) { currentConvId = id; }
export function activeConversationId() { return currentConvId; }

export function buildSystem(provider = 'horde', simple = false, isAgent = false) {
  if (simple) return SIMPLE_PROMPT;

  const globMem = readMemoryRaw(globalMemoryPath());
  const convMem = currentConvId != null ? readMemoryRaw(memoryPath(currentConvId)) : '';
  // Les agents ont accès à une mémoire partagée plus large pour éviter les conflits
  const sharedMem = isAgent ? readMemoryRaw(sharedMemoryPath(), 5000) : ''; 
  
  let ls = '';
  try { ls = fs.readdirSync(process.cwd()).slice(0, 40).join(', '); } catch {}
  
  const isHorde = provider === 'horde';
  const base = isHorde ? SYSTEM_PROMPT : SYSTEM_PROMPT_CLOUD;
  const search = (isHorde && getSearchKey()) ? '\n' + SEARCH_PROMPT : '';
  
  const convLine = currentConvId != null
    ? `Conversation n°${currentConvId} — mémoire : ${convMem || '(vide)'}`
    : '';
    
  const agentLine = isAgent && sharedMem
    ? `MÉMOIRE PARTAGÉE DES AUTRES AGENTS (à consulter pour éviter les conflits et les doublons) :\n${sharedMem}`
    : '';

  return [
    base + search, '',
    `Dossier courant : ${process.cwd()}`,
    "ACCES : tu peux lire et modifier TOUS les fichiers de l'utilisateur. Utilise des chemins absolus. Home : " + os.homedir() + ". Pour explorer, lance ls ~ ou find ~ -maxdepth 2.",
    "Contenu du home : " + (() => { try { return fs.readdirSync(os.homedir()).slice(0, 40).join(', '); } catch { return ''; } })(),
    `Contenu dossier : ${ls}`,
    `Date : ${new Date().toLocaleString('fr-FR')}`,
    `Mémoire globale : ${globMem || '(vide)'}`,
    convLine,
    agentLine
  ].filter(Boolean).join('\n');
}

function readMemoryRaw(p, maxChars = 3000) {
  try { return fs.readFileSync(p, 'utf-8').slice(0, maxChars); } catch { return ''; }
}
