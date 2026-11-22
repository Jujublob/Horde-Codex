import fs from 'fs';
import os from 'os';
import { SYSTEM_PROMPT, SYSTEM_PROMPT_CLOUD, SEARCH_PROMPT, SIMPLE_PROMPT } from './config.js';
import { getSearchKey } from './settings.js';

const MEM = os.homedir() + '/.ia_memory.json';

// provider : 'horde' (par défaut) ou l'id d'un autre fournisseur (gemini, openai, claude...)
// simple : true = mode "assistant" (juste parler + chercher, aucun accès au système, voir /assistant)
export function buildSystem(provider = 'horde', simple = false) {
  if (simple) return SIMPLE_PROMPT;

  let mem = '';
  let ls = '';
  try { mem = fs.readFileSync(MEM, 'utf-8').slice(0, 3000); } catch {}
  try { ls = fs.readdirSync(process.cwd()).slice(0, 40).join(', '); } catch {}
  const isHorde = provider === 'horde';
  const base = isHorde ? SYSTEM_PROMPT : SYSTEM_PROMPT_CLOUD;
  // Ancien mécanisme de recherche par clé API (Tavily), optionnel et réservé à Horde pour ne pas
  // surcharger le prompt des autres fournisseurs qui ont souvent déjà leur propre recherche.
  const search = (isHorde && getSearchKey()) ? '\n' + SEARCH_PROMPT : '';
  return [
    base + search, '',
    `Dossier courant : ${process.cwd()}`,
    "ACCES : tu peux lire et modifier TOUS les fichiers de l'utilisateur, pas seulement le dossier courant. Utilise des chemins absolus. Home : " + os.homedir() + ". Pour explorer, lance ls ~ ou find ~ -maxdepth 2, ne te limite jamais au dossier courant.",
    "Contenu du home : " + (() => { try { return fs.readdirSync(os.homedir()).slice(0, 40).join(', '); } catch { return ''; } })(),
    `Contenu : ${ls}`,
    `Date : ${new Date().toLocaleString('fr-FR')}`,
    `Mémoire (${MEM}) :`,
    mem || '(vide)'
  ].join('\n');
}
