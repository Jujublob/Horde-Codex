import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import chalk from 'chalk';
import { searchWeb } from './search_tool.js';
import { FAVORITES, MAX_STEPS, NON_HORDE_MAX_STEPS } from './config.js';
import { getFavorites, getSearchKey, SETTINGS_FILE } from './settings.js';
import { chat, liveModels, listModels, getFinishReason } from './api.js';
import { parseRef, makeRef, shortName, iconFor } from './models.js';
import { spinner, printReply } from './ui.js';
import { buildSystem, setActiveConversation, activeConversationId } from './context.js';
import { sessionPath, memoryPath, globalMemoryPath, defaultConversationId, createConversation, listConversations, loadMeta, touchMeta, autoTitle, deleteConversation } from './convos.js';
import { extractBlocks, expand, writeFile, run, killRunning, isDangerous, isReadOnly, checkSyntax } from './exec.js';

const favs = getFavorites(FAVORITES);
export const S = {
  model: favs[0], models: [...favs], favs, auto: false, pending: [], last: null,
  stopped: false, ctrl: null, simple: false, convId: null,
  messages: [{ role: 'system', content: buildSystem(parseRef(favs[0]).provider) }]
};
const tried = new Set();
// Commandes de lecture déjà exécutées dans la suite d'étapes en cours (évite les boucles de
// re-vérification des mêmes fichiers) ; remise à zéro à chaque nouveau message de l'utilisateur.
const seenCmds = new Map();
// Chemins des fichiers de mémoire reconnus automatiquement (validés sans confirmation, JSON obligatoire) :
// la mémoire de la conversation courante + la mémoire globale. Les "mémoires de projet" libres
// ne sont plus demandées par le prompt : tout passe par ces deux fichiers, hors du dossier du programme.
const memoryTargets = () => [memoryPath(S.convId), globalMemoryPath()].filter(Boolean);
const isMemoryFile = (full) => memoryTargets().includes(full);

const BASE_CMDS = ['/help', '/live', '/use ', '/top', '/fav ', '/file ', '/paste', '/cd ', '/auto', '/assistant', '/stop', '/api ', '/apihorde ', '/apisearch ', '/save', '/clear', '/resume', '/new', '/delconv ', '/exit'];
const completer = (l) => {
  const all = [...BASE_CMDS, ...S.favs.map((_, i) => `/${i + 1}`)];
  const h = all.filter(c => c.startsWith(l));
  return [h.length ? h : all, l];
};
export const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer });

// Question o/N : peut être annulée par /stop ou Ctrl+C
let askAbort = null;
// raw = true : réponse telle quelle (clés API, URL) ; sinon minuscules (réponses o/N)
export const ask = (q, raw = false) => new Promise((resolve) => {
  const ac = new AbortController();
  askAbort = () => ac.abort();
  ac.signal.addEventListener('abort', () => { askAbort = null; resolve(raw ? '' : 'n'); }, { once: true });
  rl.question(q, { signal: ac.signal }, (a) => { askAbort = null; resolve(raw ? a.trim() : a.trim().toLowerCase()); });
});
export const askRaw = (q) => ask(q, true);

// Interrompt l'IA : requête en cours, commande en cours, question en attente
export function interrupt() {
  S.stopped = true;
  console.log(chalk.yellow('\n⛔ Interruption…'));
  S.ctrl?.abort();
  killRunning();
  askAbort?.();
}

// Reconstruit le prompt système (changement de modèle, de clé de recherche, de mode assistant...)
export function refreshSystem() {
  S.messages[0] = { role: 'system', content: buildSystem(parseRef(S.model).provider, S.simple) };
  saveSession();
}

// Avertit une seule fois par session au premier passage sur un fournisseur autre qu'AI Horde
// (ceux-là sont en général payants à l'usage, contrairement à Horde)
let warnedCloudOnce = false;
export function maybeWarnCloud(ref) {
  const provider = parseRef(ref).provider;
  if (provider !== 'horde' && !warnedCloudOnce) {
    warnedCloudOnce = true;
    console.log(chalk.yellow(`⚠ Modèle hors AI Horde (${provider}) : les appels à cette API peuvent être payants selon ton compte.`));
  }
}

const LIST_MAX = 20;

// Liste les modèles d'un fournisseur (AI Horde par défaut), filtrés par mots-clés
export async function showModels({ provider = 'horde', filter = '', unavailable = false } = {}) {
  try {
    let list = await listModels(provider);
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) list = list.filter(m => words.every(w => m.toLowerCase().includes(w)));
    if (!list.length) return console.log(chalk.red(words.length ? `Aucun modèle ne correspond à « ${filter} ».` : 'Aucun modèle disponible.'));
    S.models = list.slice(0, LIST_MAX).map(m => makeRef(provider, m));
    const where = provider === 'horde' ? 'AI Horde (en ligne)' : provider;
    console.log(chalk.cyan.bold(unavailable ? '\n⚠ Modèle indisponible. Choisis avec /use <n> :' : `\n🟢 Modèles ${where}${words.length ? ` · « ${filter} »` : ''} :`));
    S.models.forEach((ref, i) => {
      const { sym, color } = iconFor(ref);
      console.log(chalk.yellow(`  [${i + 1}] `) + chalk.hex(color)(sym) + ' ' + chalk.green(parseRef(ref).model));
    });
    if (list.length > LIST_MAX) console.log(chalk.gray(`  … ${list.length - LIST_MAX} autres : affine avec /live ${provider} <mot>`));
    console.log(chalk.gray('  Choisir : /use <n°>'));
  } catch (e) { console.log(chalk.red(`Liste des modèles : ${e.message}`)); }
}

async function confirm(q) {
  const a = await ask(chalk.yellow(q + ' [o/N/a=toujours] '));
  if (a === '/stop') { interrupt(); return false; }
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
    if (S.stopped) break;
    const q = m[1].trim();
    if (!q) continue;
    n++;
    if (!getSearchKey()) {
      console.log(chalk.yellow("🌐 L'IA veut chercher sur le web, mais aucune clé n'est définie : /apisearch <clé>"));
      S.pending.push("[Recherche web non activée (aucune clé définie par l'utilisateur) : réponds sans recherche, n'en redemande pas.]");
      break;
    }
    console.log(chalk.cyan(`🌐 Recherche web : ${q}`));
    const res = await safeSearch(q);
    S.pending.push(`[Résultats web pour « ${q} » :\n${res}]`);
  }
}

async function doFile(b) {
  if (S.simple) {
    console.log(chalk.gray(`↷ Écriture ignorée (mode assistant actif) : ${b.path}`));
    S.pending.push("[Écriture ignorée : le mode assistant est actif, aucun accès au système. /assistant pour repasser en mode agent complet.]");
    return;
  }
  const full = expand(b.path);
  const isMem = isMemoryFile(full);
  const secret = full === SETTINGS_FILE; // contient les clés API : validation toujours obligatoire
  console.log(chalk.blue(`\n📝 Écrire : ${b.path} (${b.code.split('\n').length} lignes)`));
  if (secret) console.log(chalk.yellow.bold('🔒 Ce fichier contient tes clés API : validation obligatoire.'));
  if (isMem) {
    try { JSON.parse(b.code); }
    catch (e) {
      console.log(chalk.red('✘ Mémoire non écrite : JSON invalide.'));
      S.pending.push(`[Fichier ${b.path} NON écrit : JSON invalide (${e.message}). Renvoie le contenu COMPLET en JSON valide.]`);
      return;
    }
  }
  // Un fichier existant nettement plus gros que le nouveau contenu : probablement une erreur
  // (un append: aurait dû être utilisé) — on demande confirmation même en mode auto.
  let shrink = false;
  try {
    if (!isMem && !secret && fs.existsSync(full)) {
      const oldLen = fs.statSync(full).size;
      const newLen = Buffer.byteLength(b.code, 'utf-8');
      if (oldLen > 200 && newLen < oldLen * 0.5) shrink = true;
    }
  } catch {}
  if (shrink) console.log(chalk.yellow.bold(`⚠ Ce fichier existant serait nettement raccourci (probable erreur : un append: était peut-être attendu).`));
  if ((secret || shrink || (!S.auto && !isMem)) && !(await confirm('Appliquer ?'))) return refuse();
  try {
    const r = writeFile(b.path, b.code);
    console.log(chalk.green(`✔ ${r.full}${r.bak ? ' (ancienne version : .bak)' : ''}`));
    S.pending.push(`[Fichier ${b.path} écrit avec succès]`);
    if (!isMem && !secret) {
      const err = await checkSyntax(full);
      if (err) {
        console.log(chalk.yellow(`⚠ Vérification automatique : ${err.split('\n')[0]}`));
        S.pending.push(`[Vérification automatique de ${b.path} :\n${err}\nCorrige ce fichier si besoin.]`);
      }
    }
  } catch (e) {
    console.log(chalk.red(`✘ Échec de l'écriture : ${e.message}`));
    S.pending.push(`[Échec de l'écriture de ${b.path} : ${e.message}]`);
  }
}

// Blocs ```append:chemin``` : ajoute la suite d'un fichier écrit en plusieurs réponses
async function doAppends(reply) {
  const re = /```append:([^\n]+)\n([\s\S]*?)```/g;
  if (S.simple) {
    if (re.test(reply)) S.pending.push("[Ajouts de fichier ignorés : le mode assistant est actif, aucun accès au système. /assistant pour repasser en mode agent complet.]");
    return;
  }
  let m;
  while ((m = re.exec(reply))) {
    const p = m[1].trim();
    const code = m[2].replace(/\n$/, '');
    const full = expand(p);
    if (isMemoryFile(full)) {
      S.pending.push(`[Append refusé sur ${p} : réécris la mémoire en entier avec un bloc file: en JSON valide.]`);
      continue;
    }
    const secret = full === SETTINGS_FILE;
    console.log(chalk.blue(`\n➕ Ajouter à : ${p} (${code.split('\n').length} lignes)`));
    if ((secret || !S.auto) && !(await confirm('Ajouter ?'))) return refuse();
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.appendFileSync(full, code + '\n');
      console.log(chalk.green(`✔ ${full} (suite ajoutée)`));
      S.pending.push(`[Suite ajoutée à ${p} avec succès]`);
      const err = await checkSyntax(full);
      if (err) {
        console.log(chalk.yellow(`⚠ Vérification automatique : ${err.split('\n')[0]}`));
        S.pending.push(`[Vérification automatique de ${p} :\n${err}\nCorrige ce fichier si besoin.]`);
      }
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
  const isDdgr = /^\s*ddgr\b/.test(b.code);
  if (S.simple && !isDdgr) {
    console.log(chalk.gray(`↷ Ignoré (mode assistant actif) : ${b.code}`));
    S.pending.push("[Action ignorée : le mode assistant est actif, aucun accès au système (seule la recherche web est permise). /assistant pour repasser en mode agent complet.]");
    return;
  }
  // Sécurité : ddgr sans --json peut rester en attente d'une touche (mode interactif) — on l'ajoute au besoin.
  if (isDdgr && !/--json|--np\b|--noprompt/.test(b.code)) {
    b.code = b.code.replace(/^(\s*ddgr\b)/, '$1 --json');
  }
  const danger = isDangerous(b.code);
  const safe = isReadOnly(b.code);
  // Le fichier des clés API ne part jamais vers le serveur sans ta validation
  const secret = /\.horde_settings/.test(b.code);
  // L'IA peut exiger ta validation en mettant "# CONFIRM" en première ligne du bloc bash
  const force = secret || /^\s*#\s*CONFIRM\b/i.test(b.code);
  if (/(node\s+|\.\/)index\.js/.test(b.code)) {
    console.log(chalk.red('⛔ Refusé : relancerait ce CLI.'));
    S.pending.push('[Refusé : node index.js relance ce CLI interactif. Utilise node --check index.js.]');
    return;
  }
  // Évite les boucles : une même commande de lecture déjà lancée dans cette suite d'étapes
  // n'est pas relancée, son résultat précédent est juste rappelé à l'IA.
  const norm = b.code.trim().replace(/\s+/g, ' ');
  if (safe && seenCmds.has(norm)) {
    console.log(chalk.gray(`↻ Déjà exécuté dans cette suite d'étapes (résultat réutilisé) : ${b.code}`));
    S.pending.push(`[Commande déjà exécutée plus tôt dans cette tâche, même résultat qu'avant (ne la relance pas) : ${b.code}\n${seenCmds.get(norm)}]`);
    return;
  }
  console.log(chalk.blue(safe ? '\n🔍 Lecture :\n' : '\n⚡ Commande :\n') + chalk.white(b.code));
  if (danger) console.log(chalk.red.bold('⛔ Commande dangereuse : confirmation obligatoire.'));
  if (secret) console.log(chalk.yellow.bold('🔒 Ce fichier contient tes clés API : validation obligatoire.'));
  else if (force) console.log(chalk.yellow.bold("🔒 L'IA demande ta validation pour cette commande."));
  const skip = !force && !danger && (safe || S.auto);
  if (!skip && !(await confirm('Exécuter ?'))) return refuse();
  const cd = b.code.trim().match(/^cd\s+(.+)$/);
  if (cd) return doCd(cd[1]);
  const r = await run(b.code);
  console.log(chalk.gray(`\n(code de sortie : ${r.code})`));
  if (safe) seenCmds.set(norm, `Code de sortie : ${r.code}\nSortie :\n${r.out}`);
  S.pending.push(`[Commande exécutée : ${b.code}\nCode de sortie : ${r.code}\nSortie :\n${r.out}]`);
}

async function handleBlocks(reply) {
  await doSearches(reply);
  for (const b of extractBlocks(reply)) {
    if (S.stopped) break;
    if (b.type === 'file') await doFile(b);
    else await doCmd(b);
    if (S.refused || S.stopped) break;
  }
  if (!S.refused && !S.stopped) await doAppends(reply);
}

export async function askAI(input, depth = 0, retry = false) {
  // Nouveau message de l'utilisateur : on repart avec une liste de modèles essayés vide
  if (depth === 0 && !retry) { tried.clear(); S.stopped = false; seenCmds.clear(); }
  // Première phrase de la conversation : elle devient son titre (affiché dans /resume)
  if (S.convId != null && !loadMeta(S.convId)?.title) touchMeta(S.convId, { title: autoTitle(input) });
  const prev = S.pending;
  S.pending = [];
  S.refused = false;
  S.messages.push({ role: 'user', content: [...prev, input].join('\n\n') });
  if (S.messages.length > 17) {
    S.messages = [S.messages[0], ...S.messages.slice(-12)];
    while (S.messages[1] && S.messages[1].role !== 'user') S.messages.splice(1, 1);
  }
  const stop = spinner(shortName(S.model));
  let replied = false;
  try {
    S.ctrl = new AbortController();
    const reply = await chat(S.model, S.messages, S.ctrl.signal);
    const cut = getFinishReason() === 'length';
    stop();
    if (S.stopped) { const e = new Error('Interrompu'); e.interrupted = true; throw e; }
    if (!reply) throw new Error('Réponse vide.');
    S.messages.push({ role: 'assistant', content: reply });
    replied = true;
    S.last = null; tried.clear(); saveSession();
    printReply(reply);
    await handleBlocks(reply);
    if (S.stopped) {
      S.pending.push("[L'utilisateur t'a interrompu avec /stop : arrête ce que tu faisais et attends ses instructions.]");
      return;
    }
    const isHorde = parseRef(S.model).provider === 'horde';
    if (cut) {
      if (isHorde) {
        console.log(chalk.yellow('✂ Réponse coupée par la limite de tokens.'));
        S.pending.push("[Ta réponse a été coupée (limite de tokens) : un bloc incomplet n'a PAS été exécuté. Reprends en blocs plus courts : file:chemin pour la 1re partie, puis append:chemin pour la suite, une partie par réponse.]");
      } else {
        console.log(chalk.yellow('✂ Réponse coupée (max_tokens atteint).'));
        S.pending.push("[Ta réponse a été coupée : continue à partir d'où tu t'es arrêté.]");
      }
    }
    if (S.pending.length && !S.refused) {
      const maxSteps = isHorde ? MAX_STEPS : NON_HORDE_MAX_STEPS;
      if (depth >= maxSteps) console.log(chalk.yellow(`⏸ Pause après ${maxSteps} étapes. Écris "continue" pour poursuivre.`));
      else await askAI('Résultats ci-dessus. Vérifie, poursuis ou termine (TERMINÉ).', depth + 1);
    }
  } catch (e) {
    stop();
    if (replied) { console.log(chalk.red(`✘ ${e.message}`)); return; }
    S.messages.pop();
    if (e.interrupted || S.stopped) {
      S.pending = [...prev, "[L'utilisateur t'a interrompu avec /stop avant ta réponse.]"];
      S.last = null;
      return;
    }
    S.pending = prev;
    S.last = S.last || input;
    console.log(chalk.red(`✘ ${e.status ? `Erreur API (${e.status}) : ` : ''}${e.message}`));
    if (parseRef(S.model).provider === 'horde' && [403, 404, 503].includes(e.status) && await failover(e, depth)) return;
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
  if (sizeOf(S.model) > 0 && sizeOf(S.model) < 20) console.log(chalk.yellow('⚠ Modèle plus petit : risque d\'erreurs accru sur du code complexe.'));
  await askAI(S.last, depth, true);
  return true;
}

// ---------- Conversations (dossier ~/.horde-cli-memoire/, hors du programme) ----------
// Chaque conversation a son numéro système (1, 2, 3... jamais réutilisé), sa session et SA mémoire ;
// la mémoire globale est partagée entre toutes. Supprimer une conversation supprime son dossier entier,
// donc aussi son fichier mémoire.

export function saveSession() {
  if (S.convId == null) return;
  try {
    fs.writeFileSync(sessionPath(S.convId), JSON.stringify(S.messages));
    touchMeta(S.convId, { model: S.model, messageCount: Math.max(0, S.messages.length - 1) });
  } catch {}
}

// Recharge la session d'une conversation dans S.messages (le prompt système est reconstruit avant)
export function loadSession(id = S.convId) {
  if (id == null) return 0;
  try {
    const m = JSON.parse(fs.readFileSync(sessionPath(id), 'utf-8'));
    if (Array.isArray(m) && m.length > 1) { m[0] = S.messages[0]; S.messages = m; return m.length - 1; }
  } catch {}
  return 0;
}

// Change de conversation : sauvegarde l'actuelle, bascule, recharge la nouvelle.
export function switchConversation(id) {
  saveSession();
  S.convId = id;
  setActiveConversation(id);
  refreshSystem();
  return loadSession(id);
}

export function newConversation() {
  saveSession();
  S.convId = createConversation();
  setActiveConversation(S.convId);
  S.messages = [{ role: 'system', content: buildSystem(parseRef(S.model).provider, S.simple) }];
  S.pending = [];
  S.last = null;
  seenCmds.clear();
  return S.convId;
}

// Au lancement : conversation la plus récente (créée/migrée si besoin), puis reprise de sa session.
export function initConversations() {
  S.convId = defaultConversationId();
  setActiveConversation(S.convId);
  refreshSystem();
  return loadSession();
}

// /resume [n°] : liste les conversations ou bascule sur l'une d'elles
export async function resumeCommand(arg) {
  const list = listConversations();
  if (!list.length) return console.log(chalk.gray('Aucune conversation enregistrée.'));
  const n = parseInt(String(arg || '').trim(), 10);
  if (!n) {
    console.log(chalk.hex('#c084fc').bold('\n Conversations\n'));
    for (const c of list) {
      const mark = c.id === S.convId ? chalk.green('● ') : '  ';
      const when = c.updatedAt ? new Date(c.updatedAt).toLocaleString('fr-FR') : '?';
      console.log(`  ${mark}${chalk.yellow(`#${c.id}`)} ${chalk.hex('#34d399')(c.title)} ${chalk.gray(`· ${c.messageCount} msg · ${shortName(c.model || S.model)} · ${when}`)}`);
    }
    console.log(chalk.gray('\n  Reprendre : /resume <n°> · Nouvelle : /new · Supprimer : /delconv <n°>\n'));
    return;
  }
  if (!list.some(c => c.id === n)) return console.log(chalk.red(`Pas de conversation n°${n}. /resume pour la liste.`));
  const count = switchConversation(n);
  console.log(count
    ? chalk.green(`↺ Conversation #${n} reprise (${count} messages).`)
    : chalk.green(`↺ Conversation #${n} ouverte (vide).`));
  return true; // index.js rafraîchira le bandeau
}

// /new : nouvelle conversation (l'actuelle reste enregistrée, récupérable avec /resume)
export function newConversationCommand() {
  const id = newConversation();
  console.log(chalk.green(`✔ Nouvelle conversation #${id}. L'ancienne reste accessible via /resume.`));
  return id;
}

// /delconv <n°> : supprime une conversation ET son fichier mémoire (tout est dans son dossier)
export async function delConvCommand(arg) {
  const n = parseInt(String(arg || '').trim(), 10);
  const list = listConversations();
  if (!n) return console.log(chalk.red('Usage : /delconv <n°> (/resume pour voir la liste).'));
  if (!list.some(c => c.id === n)) return console.log(chalk.red(`Pas de conversation n°${n}.`));
  const meta = loadMeta(n);
  console.log(chalk.yellow(`⚠ Conversation #${n} « ${meta?.title || '(sans titre)'} » : session ET fichier mémoire seront supprimés définitivement.`));
  if (!(await confirm('Supprimer ?'))) return;
  if (!deleteConversation(n)) return console.log(chalk.red('✘ Suppression impossible.'));
  console.log(chalk.green(`✔ Conversation #${n} supprimée (mémoire incluse). Le numéro ne sera pas réutilisé.`));
  if (n === S.convId) {
    const id = newConversation();
    console.log(chalk.gray(`  (la conversation supprimée était l'active : nouvelle conversation #${id} ouverte)`));
  }
}

export async function pickStrongest() {
  try {
    const list = await liveModels();
    return list.filter(m => sizeOf(m) >= 30).sort((a, b) => sizeOf(b) - sizeOf(a))[0] || "koboldcpp/Llama-3.3-70B-Instruct";
  } catch { return "koboldcpp/Llama-3.3-70B-Instruct"; }
}
