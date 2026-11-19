import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import chalk from 'chalk';
import { searchWeb } from './search_tool.js';
import { FAVORITES, MAX_STEPS } from './config.js';
import { chat, liveModels, getFinishReason } from './api.js';
import { spinner, printReply } from './ui.js';
import { buildSystem } from './context.js';
import { extractBlocks, expand, writeFile, run, isDangerous, isReadOnly } from './exec.js';

export const S = {
  model: FAVORITES[0], models: [...FAVORITES], auto: false, pending: [], last: null,
  messages: [{ role: 'system', content: buildSystem() }]
};
const tried = new Set();
const MEM_PATH = expand('~/.ia_memory.json');
const SESS = os.homedir() + '/.horde_session.json';

const CMDS = ['/help', '/live', '/use ', '/file ', '/paste', '/cd ', '/auto', '/save', '/clear', '/exit', '/1', '/2', '/3', '/4', '/5'];
const completer = (l) => { const h = CMDS.filter(c => c.startsWith(l)); return [h.length ? h : CMDS, l]; };
export const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer });
export const ask = (q) => new Promise(r => rl.question(q, a => r(a.trim().toLowerCase())));

export async function showModels(unavailable) {
  try {
    const list = await liveModels();
    if (!list.length) return console.log(chalk.red('Aucun modèle actif.'));
    S.models = list.slice(0, 15);
    console.log(chalk.cyan.bold(unavailable ? '\n⚠ Modèle indisponible. Choisis avec /use <n> :' : '\n🟢 Modèles en ligne :'));
    S.models.forEach((m, i) => console.log(chalk.yellow(`  [${i + 1}] `) + chalk.green(m)));
  } catch (e) { console.log(chalk.red(`Liste des modèles : ${e.message}`)); }
}

async function confirm(q) {
  const a = await ask(chalk.yellow(q + ' [o/N/a=toujours] '));
  if (a === 'a') { S.auto = true; console.log(chalk.red('Mode auto activé.')); }
  return a === 'o' || a === 'a';
}

function refuse() {
  S.pending.push("[L'utilisateur a refusé cette action]");
  S.refused = true;
}

// Recherche web : jamais d'exception, toujours une réponse exploitable par le modèle
async function safeSearch(query) {
  try {
    const r = await searchWeb(query);
    const txt = String(r ?? '').trim();
    return txt || '(aucun résultat)';
  } catch (e) {
    return `(recherche web indisponible : ${e.message})`;
  }
}

// Blocs ```search requête``` : le modèle lance une recherche de sa propre initiative, sans confirmation
async function doSearches(reply) {
  const re = /```search\n([\s\S]*?)```/g;
  let m, n = 0;
  while ((m = re.exec(reply)) && n < 3) {
    const q = m[1].trim();
    if (!q) continue;
    n++;
    console.log(chalk.cyan(`🌐 Recherche web : ${q}`));
    const res = await safeSearch(q);
    S.pending.push(`[Résultats web pour « ${q} » :\n${res}]`);
  }
}

async function doFile(b) {
  const isMem = expand(b.path) === MEM_PATH;
  console.log(chalk.blue(`\n📝 Écrire : ${b.path} (${b.code.split('\n').length} lignes)`));
  if (isMem) {
    try { JSON.parse(b.code); }
    catch (e) {
      console.log(chalk.red('✘ Mémoire non écrite : JSON invalide.'));
      S.pending.push(`[Fichier ${b.path} NON écrit : JSON invalide (${e.message}). Renvoie le contenu COMPLET en JSON valide.]`);
      return;
    }
  }
  if (!S.auto && !isMem && !(await confirm('Appliquer ?'))) return refuse();
  const r = writeFile(b.path, b.code);
  console.log(chalk.green(`✔ ${r.full}${r.bak ? ' (ancienne version : .bak)' : ''}`));
  S.pending.push(`[Fichier ${b.path} écrit avec succès]`);
}

// Blocs ```append:chemin``` : ajoute la suite d'un fichier écrit en plusieurs réponses
async function doAppends(reply) {
  const re = /```append:([^\n]+)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(reply))) {
    const p = m[1].trim();
    const code = m[2].replace(/\n$/, '');
    if (expand(p) === MEM_PATH) {
      S.pending.push(`[Append refusé sur ${p} : réécris la mémoire en entier avec un bloc file: en JSON valide.]`);
      continue;
    }
    console.log(chalk.blue(`\n➕ Ajouter à : ${p} (${code.split('\n').length} lignes)`));
    if (!S.auto && !(await confirm('Ajouter ?'))) return refuse();
    try {
      const full = expand(p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.appendFileSync(full, code + '\n');
      console.log(chalk.green(`✔ ${full} (suite ajoutée)`));
      S.pending.push(`[Suite ajoutée à ${p} avec succès]`);
    } catch (e) {
      console.log(chalk.red(e.message));
      S.pending.push(`[Échec de l'ajout à ${p} : ${e.message}]`);
    }
  }
}

function doCd(dir) {
  try {
    process.chdir(expand(dir.replace(/^["']|["']$/g, '')));
    S.pending.push(`[cd -> ${process.cwd()}]`);
    console.log(chalk.green('✔ ' + process.cwd()));
  } catch (e) { console.log(chalk.red(e.message)); }
}

async function doCmd(b) {
  const danger = isDangerous(b.code);
  const safe = isReadOnly(b.code);
  // L'IA peut exiger ta validation en mettant "# CONFIRM" en première ligne du bloc bash
  const force = /^\s*#\s*CONFIRM\b/i.test(b.code);
  if (/(node\s+|\.\/)index\.js/.test(b.code)) {
    console.log(chalk.red('⛔ Refusé : relancerait ce CLI.'));
    S.pending.push('[Refusé : node index.js relance ce CLI interactif. Utilise node --check index.js.]');
    return;
  }
  console.log(chalk.blue(safe ? '\n🔍 Lecture :\n' : '\n⚡ Commande :\n') + chalk.white(b.code));
  if (danger) console.log(chalk.red.bold('⛔ Commande dangereuse : confirmation obligatoire.'));
  if (force) console.log(chalk.yellow.bold('🔒 L\'IA demande ta validation pour cette commande.'));
  const skip = !force && !danger && (safe || S.auto || /^node\s+~\/horde-cli\/search_tool\.js/.test(b.code.trim()));
  if (!skip && !(await confirm('Exécuter ?'))) return refuse();
  const cd = b.code.trim().match(/^cd\s+(.+)$/);
  if (cd) return doCd(cd[1]);
  const r = await run(b.code);
  console.log(chalk.gray(`\n(code de sortie : ${r.code})`));
  S.pending.push(`[Commande exécutée : ${b.code}\nCode de sortie : ${r.code}\nSortie :\n${r.out}]`);
}

async function handleBlocks(reply) {
  await doSearches(reply);
  for (const b of extractBlocks(reply)) {
    if (b.type === 'file') await doFile(b);
    else await doCmd(b);
    if (S.refused) break;
  }
  if (!S.refused) await doAppends(reply);
}

export async function askAI(input, depth = 0, retry = false) {
  // Nouveau message de l'utilisateur : on repart avec une liste de modèles essayés vide
  if (depth === 0 && !retry) tried.clear();
  const prev = S.pending;
  S.pending = [];
  S.refused = false;
  S.messages.push({ role: 'user', content: [...prev, input].join('\n\n') });
  if (S.messages.length > 17) {
    S.messages = [S.messages[0], ...S.messages.slice(-12)];
    while (S.messages[1] && S.messages[1].role !== 'user') S.messages.splice(1, 1);
  }
  const stop = spinner(S.model.split('/').pop());
  try {
    const reply = await chat(S.model, S.messages);
    const cut = getFinishReason() === 'length';
    stop();
    if (!reply) throw new Error('Réponse vide.');
    S.messages.push({ role: 'assistant', content: reply });
    S.last = null; tried.clear(); saveSession();
    printReply(reply);
    await handleBlocks(reply);
    if (cut) {
      console.log(chalk.yellow('✂ Réponse coupée par la limite de tokens.'));
      S.pending.push("[Ta réponse a été coupée (limite de tokens) : un bloc incomplet n'a PAS été exécuté. Reprends en blocs plus courts : file:chemin pour la 1re partie, puis append:chemin pour la suite, une partie par réponse.]");
    }
    if (S.pending.length && !S.refused) {
      if (depth >= MAX_STEPS) console.log(chalk.yellow(`⏸ Pause après ${MAX_STEPS} étapes. Écris "continue" pour poursuivre.`));
      else await askAI('Résultats ci-dessus. Vérifie, poursuis ou termine (TERMINÉ).', depth + 1);
    }
  } catch (e) {
    stop();
    S.messages.pop();
    S.pending = prev;
    S.last = S.last || input;
    console.log(chalk.red(`✘ ${e.status ? `Erreur API (${e.status}) : ` : ''}${e.message}`));
    if ([403, 404, 503].includes(e.status) && await failover(e, depth)) return;
  }
}

const PREF = ['Coder', 'Qwen', 'Mistral', 'Llama-3.3', 'gemma', 'Llama'];
const sizeOf = (m) => parseFloat(m.match(/(\d+(?:\.\d+)?)B/i)?.[1] || 0);
const score = (m) => { const i = PREF.findIndex(p => m.includes(p)); return i < 0 ? 0 : PREF.length - i; };

async function failover(e, depth) {
  tried.add(S.model);
  const max = e.status === 403 ? 14 : 40;
  let list;
  try { list = await liveModels(); } catch { return false; }
  const ok = list.filter(m => !tried.has(m) && sizeOf(m) >= 7 && sizeOf(m) <= max)
    .sort((a, b) => score(b) - score(a) || sizeOf(b) - sizeOf(a));
  if (!ok.length) { console.log(chalk.red('Aucun modèle de remplacement. Réessaie plus tard.')); return false; }
  S.model = ok[0];
  console.log(chalk.yellow(`↻ Bascule auto vers ${S.model.split('/').pop()}`));
  await askAI(S.last, depth, true);
  return true;
}

export function saveSession() {
  try { fs.writeFileSync(SESS, JSON.stringify(S.messages)); } catch {}
}

export function loadSession() {
  try {
    const m = JSON.parse(fs.readFileSync(SESS, 'utf-8'));
    if (Array.isArray(m) && m.length > 1) { m[0] = S.messages[0]; S.messages = m; return m.length - 1; }
  } catch {}
  return 0;
}

export async function pickStrongest() {
  try {
    const list = await liveModels();
    return list.filter(m => sizeOf(m) >= 30).sort((a, b) => sizeOf(b) - sizeOf(a))[0] || "koboldcpp/Llama-3.3-70B-Instruct";
  } catch { return "koboldcpp/Llama-3.3-70B-Instruct"; }
}
