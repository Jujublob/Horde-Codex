import { searchWeb } from './search_tool.js';
import readline from 'readline';
import chalk from 'chalk';
import { FAVORITES, SYSTEM_PROMPT } from './config.js';
import { chat, liveModels } from './api.js';
import { spinner, printReply } from './ui.js';
import { buildSystem } from './context.js';
import { MAX_STEPS } from './config.js';
import { extractBlocks, expand, writeFile, run, isDangerous, isReadOnly } from './exec.js';

export const S = {
  model: FAVORITES[0], models: [...FAVORITES], auto: false, pending: [], last: null,
  messages: [{ role: 'system', content: buildSystem() }]
};
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
  } catch { console.log(chalk.red('Erreur réseau (liste des modèles).')); }
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

async function doFile(b) {
  console.log(chalk.blue(`\n📝 Écrire : ${b.path} (${b.code.split('\n').length} lignes)`));
  if (!S.auto && expand(b.path) !== expand('~/.ia_memory.json') && !(await confirm('Appliquer ?'))) return refuse();
  const r = writeFile(b.path, b.code);
  console.log(chalk.green(`✔ ${r.full}${r.bak ? ' (ancienne version : .bak)' : ''}`));
  S.pending.push(`[Fichier ${b.path} écrit avec succès]`);
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
  if (/(node\s+|\.\/)index\.js/.test(b.code)) {
    console.log(chalk.red('⛔ Refusé : relancerait ce CLI.'));
    S.pending.push('[Refusé : node index.js relance ce CLI interactif. Utilise node --check index.js.]');
    return;
  }
  console.log(chalk.blue(safe ? '\n🔍 Lecture :\n' : '\n⚡ Commande :\n') + chalk.white(b.code));
  if (danger) console.log(chalk.red.bold('⛔ Commande dangereuse : confirmation obligatoire.'));
  const skip = !danger && (safe || S.auto || /^node\s+~\/horde-cli\/search_tool\.js/.test(b.code.trim()));
  if (!skip && !(await confirm('Exécuter ?'))) return refuse();
  const cd = b.code.trim().match(/^cd\s+(.+)$/);
  if (cd) return doCd(cd[1]);
  const r = await run(b.code);
  console.log(chalk.gray(`\n(code de sortie : ${r.code})`));
  S.pending.push(`[Commande exécutée : ${b.code}\nCode de sortie : ${r.code}\nSortie :\n${r.out}]`);
}

async function handleBlocks(reply) {
  for (const b of extractBlocks(reply)) {
    if (b.type === 'file') await doFile(b);
    else await doCmd(b);
    if (S.refused) break;
  }
}

export async function askAI(input, depth = 0) {
  const prev = S.pending;
  S.pending = [];
  S.refused = false;
  if (depth === 0 && !/(\.js|horde-cli|fichier)/i.test(input) && /(\?|cherche|recherche|actualit|news|qui est|quel|quelle|m[ée]t[ée]o|prix|2025|2026)/i.test(input)) { console.log(chalk.cyan("🌐 Recherche web...")); prev.push("[Résultats Web (réponds directement sans commande) :\n" + await searchWeb(input.replace(/^\?\s*/, "")) + "]"); }
  S.messages.push({ role: 'user', content: [...prev, input].join('\n\n') });
  if (S.messages.length > 17) {
    S.messages = [S.messages[0], ...S.messages.slice(-12)];
    while (S.messages[1] && S.messages[1].role !== 'user') S.messages.splice(1, 1);
  }
  const stop = spinner(S.model.split('/').pop());
  try {
    const reply = await chat(S.model, S.messages);
    stop();
    if (!reply) throw new Error('Réponse vide.');
    S.messages.push({ role: 'assistant', content: reply });
    S.last = null; tried.clear(); saveSession();
    printReply(reply);
    await handleBlocks(reply);
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

const tried = new Set();
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
  await askAI(S.last, depth);
  return true;
}

import fs from 'fs';
import os from 'os';
const SESS = os.homedir() + '/.horde_session.json';

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
