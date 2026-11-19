import fs from 'fs';
import os from 'os';
import { SYSTEM_PROMPT, SEARCH_PROMPT } from './config.js';
import { getSearchKey } from './settings.js';

const MEM = os.homedir() + '/.ia_memory.json';

export function buildSystem() {
  let mem = '';
  let ls = '';
  try { mem = fs.readFileSync(MEM, 'utf-8').slice(0, 3000); } catch {}
  try { ls = fs.readdirSync(process.cwd()).slice(0, 40).join(', '); } catch {}
  return [
    SYSTEM_PROMPT + (getSearchKey() ? '\n' + SEARCH_PROMPT : ''), '',
    `Dossier courant : ${process.cwd()}`,
    "ACCES : tu peux lire et modifier TOUS les fichiers de l'utilisateur, pas seulement le dossier courant. Utilise des chemins absolus. Home : " + os.homedir() + ". Pour explorer, lance ls ~ ou find ~ -maxdepth 2, ne te limite jamais au dossier courant.",
    "Contenu du home : " + (() => { try { return fs.readdirSync(os.homedir()).slice(0, 40).join(', '); } catch { return ''; } })(),
    `Contenu : ${ls}`,
    `Date : ${new Date().toLocaleString('fr-FR')}`,
    `Mémoire (${MEM}) :`,
    mem || '(vide)'
  ].join('\n');
}
