import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import chalk from 'chalk';
import { exec } from 'child_process';
import { searchWeb } from './search_tool.js';
import { FAVORITES, MAX_STEPS, NON_HORDE_MAX_STEPS } from './config.js';
import { getFavorites, getSearchKey, getProviders, getLastModel, setLastModel, SETTINGS_FILE } from './settings.js';
import { chat, liveModels, listModels } from './api.js';
import { parseRef, makeRef, shortName, iconFor } from './models.js';
import { spinner, printReply } from './ui.js';
import { buildSystem, setActiveConversation, activeConversationId } from './context.js';
import { sessionPath, memoryPath, globalMemoryPath, defaultConversationId, createConversation, listConversations, loadMeta, touchMeta, autoTitle, deleteConversation, appendToSharedMemory, clearSharedMemory, saveAgentsData, loadAgentsData, addMessageToConv } from './convos.js';
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

const BASE_CMDS = ['/help', '/live', '/use ', '/top', '/fav ', '/file ', '/paste', '/cd ', '/auto', '/assistant', '/stop', '/api ', '/apihorde ', '/apisearch ', '/save', '/clear', '/resume', '/new', '/delconv ', '/exit', '/agents', '/agents watch', '/agent ', '/supervise '];
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

// Interrompt l'IA du premier plan : requête en cours, commande en cours, question en attente.
// Les agents en tâche de fond ne sont PAS touchés par /stop (chacun s'arrête avec /agent stop <n°>).
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
  // Délégation / supervision d'agents demandée par l'IA dans sa réponse :
  // blocs ```agent (lancer) et lignes /agents, /agent stop|resume|msg|new|auto|valid|allow|deny|user|show.
  for (const f of processAgentControl(reply, null)) S.pending.push(f);
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
    const { text: reply, finish } = await chat(S.model, S.messages, S.ctrl.signal);
    const cut = finish === 'length';
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
    if (parseRef(S.model).provider === 'horde' && ([403, 404, 503].includes(e.status) || isProviderDown(e)) && await failover(e, depth)) return;
  }
}

const PREF = ['Coder', 'Qwen', 'Mistral', 'Llama-3.3', 'gemma', 'Llama'];
const sizeOf = (m) => parseFloat(m.match(/(\d+(?:\.\d+)?)B/i)?.[1] || 0);
const score = (m) => { const i = PREF.findIndex(p => m.includes(p)); return i < 0 ? 0 : PREF.length - i; };

async function failover(e, depth) {
  tried.add(S.model);
  const max = e.status === 403 ? 14 : 40;
  let list;
  try { list = await liveModels(); } catch { return providerFailover(e, depth); }
  const ok = list.filter(m => !tried.has(m) && sizeOf(m) >= 7 && sizeOf(m) <= max)
    .sort((a, b) => score(b) - score(a) || sizeOf(b) - sizeOf(a));
  if (!ok.length) return providerFailover(e, depth);
  S.model = ok[0];
  console.log(chalk.yellow(`↻ Bascule auto vers ${S.model.split('/').pop()}`));
  if (sizeOf(S.model) > 0 && sizeOf(S.model) < 20) console.log(chalk.yellow('⚠ Modèle plus petit : risque d\'erreurs accru sur du code complexe.'));
  await askAI(S.last, depth, true);
  return true;
}

// ---------- Bascule entre fournisseurs (IA gratuite locale, style FreeLLMAPI — sans le serveur) ----------
// Quand AI Horde n'a plus aucun modèle disponible (panne, quota, saturé), on propose à l'utilisateur
// de continuer avec un AUTRE fournisseur qu'il a configuré (/api add). Seuls les fournisseurs réellement
// enregistrés apparaissent dans le choix — si Gemini n'est pas ajouté, il n'est pas proposé.
const PROVIDER_HINTS = {
  horde: 'AI Horde', gemini: 'Gemini', openai: 'ChatGPT', claude: 'Claude',
  openrouter: 'OpenRouter', groq: 'Groq', mistral: 'Mistral', deepseek: 'DeepSeek', together: 'Together'
};
// Erreurs qui signifient "ce fournisseur ne répondra pas" : quota dépassé, interdiction, panne, timeout
const isProviderDown = (e) => [402, 403, 429, 500, 502, 503, 504].includes(e?.status) || /timeout|ECONN|network|fetch failed/i.test(e?.message || '');

async function providerFailover(e, depth) {
  const current = parseRef(S.model).provider;
  // On ne bascule que depuis AI Horde : pour les autres fournisseurs, c'est l'utilisateur qui gère ses clés.
  if (current !== 'horde') return false;
  const others = Object.entries(getProviders()).filter(([id, p]) => p && p.baseUrl);
  if (!others.length) {
    console.log(chalk.red('Aucun modèle de remplacement. Réessaie plus tard (ou /api add pour configurer un autre fournisseur : le programme pourra te proposer de basculer).'));
    return false;
  }
  console.log(chalk.yellow(`\n⚠ AI Horde ne répond pas (${e.status || e.message}).`));
  console.log(chalk.hex('#c084fc').bold('Choisis un autre fournisseur pour continuer cette conversation :'));
  others.forEach(([id, p], i) => {
    const last = getLastModel(id);
    console.log(`  ${chalk.yellow(`[${i + 1}]`)} ${p.name || PROVIDER_HINTS[id] || id}${last ? chalk.gray(' — dernier modèle utilisé : ' + shortName(last)) : chalk.gray(' — aucun modèle choisi (il faudra /use ' + id + ' <modèle>)')}`);
  });
  console.log(`  ${chalk.gray('[Entrée = garder AI Horde et réessayer plus tard]')}\n`);
  const n = parseInt(await askRaw(chalk.cyan('Numéro (vide = annuler) : ')), 10);
  if (!(n >= 1 && n <= others.length)) return false;
  const [id] = others[n - 1];
  const ref = getLastModel(id);
  if (!ref) {
    console.log(chalk.gray(`Fournisseur ${id} sélectionné mais aucun modèle mémorisé.`));
    console.log(chalk.gray(`Affiche la liste avec /live ${id}, choisis avec /use ${id} <modèle>, puis renvoie ton dernier message.`));
    S.last = S.last || null;
    return true; // erreur déjà expliquée : on ne l'affiche pas une seconde fois
  }
  console.log(chalk.green(`↪ Bascule vers ${PROVIDER_HINTS[id] || id} (${shortName(ref)}) — la conversation est conservée.`));
  await useModelFromAgent(ref);
  await askAI(S.last, depth, true);
  return true;
}

// Change de modèle depuis ce module (même chemin que /use dans index.js)
async function useModelFromAgent(ref) {
  S.model = ref;
  setLastModel(parseRef(ref).provider, ref);
  maybeWarnCloud(ref);
  refreshSystem();
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

// Au lancement : conversation la plus récente (créée/migrée si besoin), puis reprise de sa session
// et de son groupe d'agents (restaurés en pause, prêts à reprendre avec /agent resume <n°>).
export function initConversations() {
  S.convId = defaultConversationId();
  setActiveConversation(S.convId);
  refreshSystem();
  const n = loadSession();
  const restored = restoreAgentsFromConv(S.convId);
  if (restored.length) console.log(chalk.gray(`↺ ${restored.length} agent(s) de cette conversation restauré(s) en pause (/agents, /agent resume <n°>).`));
  return n;
}

// /resume [n°] : liste les conversations ou bascule sur l'une d'elles (avec son groupe d'agents)
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
  // Le groupe d'agents de cette conversation revient avec elle (en pause, /agent resume <n°> pour reprendre)
  const restored = restoreAgentsFromConv(n);
  if (restored.length) {
    console.log(chalk.green(`↺ ${restored.length} agent(s) restauré(s) avec cette conversation (en pause).`));
    for (const a of restored) console.log(chalk.gray(`   Agent #${a.id}${a.isSupervisor ? ' 👑' : ''} : ${a.task.slice(0, 70)}`));
  }
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
  // Les agents rattachés à cette conversation disparaissent avec elle
  for (const a of [...agents.values()]) {
    if (a.convId === n) { a.ctrl?.abort(); agents.delete(a.id); if (supervisorId === a.id) supervisorId = null; }
  }
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

// ========== SYSTÈME MULTI-AGENTS (arrière-plan, non bloquant) ==========
// Chaque agent : sa tâche, son modèle, son mode de risque, sa conversation de rattachement.
// L'IA (conversation principale ou superviseur) peut elle-même lancer des agents via des blocs
// ```agent et les piloter via des lignes /agent ... (voir processAgentControl plus bas).

export const agents = new Map();
let supervisorId = null;
const nextAgentId = () => (agents.size ? Math.max(...agents.keys()) + 1 : 1);

// Exécution isolée pour les agents : ne touche pas au processus courant de exec.js (réservé au
// premier plan), PAS de timeout (comme run()), sortie capturée pour être renvoyée au modèle.
const execCapture = (cmd, cwd) => new Promise((resolve) => {
  exec(cmd, { cwd, shell: 'bash', maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    const out = `${stdout || ''}${stderr ? '\n' + stderr : ''}`.trim();
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: out.slice(-2500) });
  });
});

// Prompt système d'un agent : contexte complet (mémoire globale + partagée + capacité agents)
// + son rôle + son régime de supervision. Reconstruit à chaque étape.
function agentSystemPrompt(agent) {
  const role = agent.isSupervisor
    ? "RÔLE : SUPERVISEUR — tu délègues aux agents, tu vérifies leur travail, tu les recadres (msg) ou les arrêtes s'ils dévient de la tâche. Respecte les préférences durables de la mémoire globale de l'utilisateur."
    : "RÔLE : AGENT DE TÂCHE — exécute uniquement ta tâche, sans bavardage, sans empiéter sur le travail des autres agents.";
  let supLine = '';
  if (agent.supervision === 'approval') supLine = "\nSUPERVISION : chacune de tes actions doit être validée par le superviseur avant exécution. Propose une action à la fois et attends sa décision.";
  else if (agent.supervision === 'auto') supLine = `\nSUPERVISION : mode auto accordé par le superviseur, il te reste ${agent.autoStepsLeft} étape(s) avant pause automatique.`;
  return buildSystem(parseRef(agent.modelRef).provider, false, true)
    + '\n' + role + supLine
    + "\nSTYLE : une phrase courte décrivant l'action en cours + le bloc d'action. C'est tout. Quand la tâche est finie et vérifiée, termine ta réponse par TERMINÉ seul sur la dernière ligne.";
}

// Crée et lance un agent en tâche de fond (non bloquant : le prompt principal reste disponible)
export function createAgent(task, modelRef, mode, isSupervisor = false, parentId = null) {
  const id = nextAgentId();
  const agent = {
    id, task, modelRef, mode,
    status: 'running', // running | paused | stopped | finished
    convId: S.convId,
    cwd: process.cwd(), // dossier figé au lancement (un /cd du premier plan ne le déplace pas)
    lastAction: 'Initialisation…',
    isSupervisor, parentId,
    supervision: null,   // null = utilisateur | 'auto' = 10 étapes accordées | 'approval' = superviseur valide tout
    autoStepsLeft: 0,
    pendingFor: null,    // 'user' | 'supervisor' : qui doit valider l'action en attente
    pendingAction: null, ctrl: null, loopRunning: false,
    messages: []
  };
  agent.messages = [
    { role: 'system', content: agentSystemPrompt(agent) },
    { role: 'user', content: `TÂCHE : ${task}\nCommence maintenant. Une phrase + l'action à chaque étape.` }
  ];
  agents.set(id, agent);
  if (isSupervisor) supervisorId = id;
  console.log(chalk.green(`\n✅ [Agent ${id}${isSupervisor ? ' 👑' : ''}] ${shortName(modelRef)} · ${mode} · ${task.slice(0, 80)}`));
  saveAgentsToConv();
  runAgentLoop(agent);
  return agent;
}

// "modèle auto" / "modèle safe" / "modèle" / "" → référence + mode (défaut : modèle actuel, auto)
function parseAgentSpec(spec) {
  let modelRef = S.model, mode = 'auto';
  const tokens = (spec || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length) {
    const last = tokens[tokens.length - 1].toLowerCase();
    if (last === 'auto' || last === 'safe') { mode = last; tokens.pop(); }
    if (tokens.length) modelRef = tokens.join(' ');
  }
  return { modelRef, mode };
}

// Photo de tous les agents, en texte brut (renvoyée au modèle qui demande /agents)
function agentsReport() {
  const list = getAllAgents();
  if (!list.length) return 'Aucun agent.';
  return list.map(a =>
    `#${a.id}${a.isSupervisor ? ' (superviseur)' : ''} [${a.status}] ${shortName(a.modelRef)} · tâche: ${a.task} · dernier: ${a.lastAction}`
  ).join('\n');
}

// Extrait lisible des derniers échanges d'un agent (pour /agent show, renvoyé au modèle)
function agentTranscript(id) {
  const a = agents.get(id);
  if (!a) return `Agent #${id} introuvable.`;
  const head = `#${a.id} [${a.status}] ${a.modelRef} — tâche: ${a.task}`;
  const recent = a.messages.slice(-6).map(m => `${m.role}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 180)}`).join('\n');
  return head + '\n' + recent;
}

// Profondeur de délégation (agent → sous-agent → ...) : garde-fou anti-récursion, pas une limite
// sur le nombre d'agents en parallèle (il n'y en a pas).
function agentDepth(a) {
  let d = 0, cur = a;
  while (cur && cur.parentId != null && d < 10) { cur = agents.get(cur.parentId); d++; }
  return d;
}

// Exécute les demandes de délégation / supervision trouvées dans une réponse d'IA.
// fromAgent = null → conversation principale ; sinon l'agent auteur (ne peut pas agir sur lui-même).
// Retourne des messages de résultat à réinjecter dans la conversation de l'auteur.
function processAgentControl(reply, fromAgent) {
  const feedback = [];
  const blocks = [...reply.matchAll(/```agent(?::([^\n]+))?\n([\s\S]*?)```/g)];
  const directives = [];
  for (const line of reply.split('\n')) {
    const l = line.trim();
    let m;
    if (l === '/agents') directives.push({ type: 'list' });
    else if ((m = /^\/agent\s+stop\s+(\d+)\s*$/i.exec(l))) directives.push({ type: 'stop', id: +m[1] });
    else if ((m = /^\/agent\s+resume\s+(\d+)\s*$/i.exec(l))) directives.push({ type: 'resume', id: +m[1] });
    else if ((m = /^\/agent\s+msg\s+(\d+)\s+(.+)$/i.exec(l))) directives.push({ type: 'msg', id: +m[1], text: m[2].replace(/^"|"$/g, '') });
    else if ((m = /^\/agent\s+new\s+(\S+)\s+(auto|safe)\s+(.+)$/i.exec(l))) directives.push({ type: 'new', model: m[1], mode: m[2].toLowerCase(), task: m[3].replace(/^"|"$/g, '') });
    else if ((m = /^\/agent\s+(auto|valid|allow|deny|user|show)\s+(\d+)\s*$/i.exec(l))) directives.push({ type: 'sup', op: m[1].toLowerCase(), id: +m[2] });
  }
  if (!blocks.length && !directives.length) return feedback;
  if (!fromAgent && S.simple) return ['[Délégation ignorée : le mode assistant est actif, aucun accès au système. /assistant pour repasser en mode agent complet.]'];
  const spawn = (task, modelRef, mode) => {
    if (fromAgent && agentDepth(fromAgent) >= 4) { feedback.push('[Refusé : profondeur de délégation maximale atteinte (4). Fais le travail toi-même ou via un agent existant.]'); return; }
    const a = createAgent(task, modelRef, mode, false, fromAgent ? fromAgent.id : null);
    feedback.push(`[Agent #${a.id} lancé (${shortName(modelRef)}, ${mode}) : ${a.task}]`);
  };
  for (const b of blocks) {
    const task = b[2].trim();
    if (!task) { feedback.push('[Agent non lancé : tâche vide dans le bloc agent.]'); continue; }
    const { modelRef, mode } = parseAgentSpec(b[1]);
    spawn(task, modelRef, mode);
  }
  for (const d of directives) {
    if (d.type === 'list') { feedback.push(`[État des agents :\n${agentsReport()}]`); continue; }
    if (d.type === 'new') { spawn(d.task, d.model, d.mode); continue; }
    const target = agents.get(d.id);
    if (!target) { feedback.push(`[Agent #${d.id} introuvable.]`); continue; }
    if (fromAgent && target.id === fromAgent.id) { feedback.push('[Refusé : un agent ne peut pas agir sur lui-même via commande.]'); continue; }
    if (d.type === 'stop') { feedback.push(stopAgent(d.id) ? `[Agent #${d.id} arrêté.]` : `[Agent #${d.id} déjà arrêté ou terminé.]`); continue; }
    if (d.type === 'resume') { feedback.push(resumeAgent(d.id) ? `[Agent #${d.id} relancé.]` : `[Agent #${d.id} non relançable (statut ${target.status}).]`); continue; }
    if (d.type === 'msg') {
      const src = fromAgent ? `superviseur #${fromAgent.id}` : "utilisateur";
      target.messages.push({ role: 'user', content: `[MESSAGE du ${src}] : ${d.text}` });
      feedback.push(`[Message transmis à l'agent #${d.id}${target.status === 'running' ? '' : ' (en pause : lu à sa reprise)'}]`);
      continue;
    }
    if (d.type === 'sup') {
      // Seul le superviseur (ou l'utilisateur / l'IA principale) peut gérer l'autonomie des agents.
      const canSup = !fromAgent || fromAgent.isSupervisor;
      if (!canSup) { feedback.push("[Refusé : seul le superviseur (ou l'utilisateur) peut gérer la supervision.]"); continue; }
      if (d.op === 'show') { feedback.push(`[Agent #${d.id} :\n${agentTranscript(d.id)}]`); continue; }
      let ok = false;
      if (d.op === 'auto') ok = grantAgentAuto(d.id);
      else if (d.op === 'valid') ok = setAgentApproval(d.id);
      else if (d.op === 'allow') ok = supervisorAllow(d.id);
      else if (d.op === 'deny') ok = supervisorDeny(d.id);
      else if (d.op === 'user') ok = setAgentUserControl(d.id);
      feedback.push(ok ? `[Agent #${d.id} : ${d.op} appliqué.]` : `[Agent #${d.id} : ${d.op} impossible.]`);
      continue;
    }
  }
  return feedback;
}

// Une réponse se termine quand sa DERNIÈRE ligne est TERMINÉ (ou "tâche terminée"),
// pas quand le mot apparaît au milieu d'une phrase.
function isFinishedReply(reply) {
  const lines = reply.trim().split('\n').map(s => s.trim()).filter(Boolean);
  const last = (lines[lines.length - 1] || '').replace(/[.!?]+$/, '');
  return /^terminé$/i.test(last) || /^tâche terminée$/i.test(last);
}

// Met un agent en pause avec une action en attente de l'UTILISATEUR : /agent resume <n°> = valider.
function pauseForValidation(agent, action, why) {
  agent.pendingAction = action;
  agent.pendingFor = 'user';
  agent.status = 'paused';
  agent.lastAction = `En attente de validation : ${why}`;
  console.log(chalk.yellow(`\n⏸️ [Agent ${agent.id}] ${why}`));
  console.log(chalk.gray(`   /agent resume ${agent.id} = valider et continuer · /agent stop ${agent.id} = annuler`));
  saveAgentsToConv();
}

// ---------- Régime de supervision décidé par le superviseur ----------
// Décide qui valide une action : exécution directe, utilisateur, ou superviseur.
function actionGate(agent) {
  if (agent.supervision === 'approval') return 'supervisor';
  if (agent.supervision === 'auto') return 'execute'; // les étapes restantes sont vérifiées en tête de boucle
  return agent.mode === 'safe' ? 'user' : 'execute';
}

// Informe le superviseur (s'il tourne) ; sinon l'utilisateur voit le message.
function notifySupervisor(agent, text) {
  const sup = getSupervisor();
  if (sup && sup.status === 'running' && sup.id !== agent.id) sup.messages.push({ role: 'user', content: text });
  else console.log(chalk.gray(`\nℹ️ ${text}`));
}

// Soumet une action au superviseur pour validation. Retourne false s'il n'est pas disponible
// (l'appelant retombe alors sur une validation utilisateur).
function sendToSupervisor(agent, action, why) {
  const sup = getSupervisor();
  if (sup && sup.status === 'running' && sup.id !== agent.id) {
    agent.pendingAction = action;
    agent.pendingFor = 'supervisor';
    agent.status = 'paused';
    agent.lastAction = `En attente du superviseur : ${why}`;
    const desc = action.kind === 'bash' ? action.code : `${action.kind} ${action.path}`;
    sup.messages.push({ role: 'user', content: `[DEMANDE DE VALIDATION — agent #${agent.id}] ${desc}\nRéponds sur une ligne : /agent allow ${agent.id} (autoriser) ou /agent deny ${agent.id} (refuser).` });
    console.log(chalk.yellow(`\n📨 [Agent ${agent.id}] Action soumise au superviseur : ${why}`));
    saveAgentsToConv();
    return true;
  }
  return false;
}

// /agent auto <n°> : accorde 10 étapes autonomes puis pause (renouvelable par le superviseur).
export function grantAgentAuto(id) {
  const a = agents.get(id);
  if (!a) { console.log(chalk.red(`\n❌ Agent #${id} introuvable.`)); return false; }
  a.supervision = 'auto'; a.autoStepsLeft = 10; a.pendingFor = null;
  console.log(chalk.green(`\n🤖 [Agent ${id}] Mode auto accordé : 10 étapes puis pause.`));
  saveAgentsToConv();
  if (a.status === 'paused' || a.status === 'stopped') {
    a.status = 'running';
    if (a.pendingAction) { const p = a.pendingAction; a.pendingAction = null; executeApproved(a, p); }
    else runAgentLoop(a);
  }
  return true;
}

// /agent valid <n°> : chaque action de l'agent devra être validée par le superviseur.
export function setAgentApproval(id) {
  const a = agents.get(id);
  if (!a) { console.log(chalk.red(`\n❌ Agent #${id} introuvable.`)); return false; }
  a.supervision = 'approval'; a.autoStepsLeft = 0;
  console.log(chalk.green(`\n🔐 [Agent ${id}] Chaque action devra être validée par le superviseur.`));
  saveAgentsToConv();
  if (a.status === 'paused' || a.status === 'stopped') { a.status = 'running'; runAgentLoop(a); }
  return true;
}

// /agent allow <n°> : le superviseur autorise l'action en attente.
export function supervisorAllow(id) {
  const a = agents.get(id);
  if (!a || !a.pendingAction) { console.log(chalk.yellow(`\n⚠ Agent #${id} : rien en attente.`)); return false; }
  const p = a.pendingAction; a.pendingAction = null; a.pendingFor = null; a.status = 'running';
  console.log(chalk.green(`\n✔ [Agent ${id}] Action autorisée.`));
  saveAgentsToConv();
  executeApproved(a, p);
  return true;
}

// /agent deny <n°> : le superviseur refuse l'action en attente.
export function supervisorDeny(id) {
  const a = agents.get(id);
  if (!a || !a.pendingAction) { console.log(chalk.yellow(`\n⚠ Agent #${id} : rien en attente.`)); return false; }
  a.pendingAction = null; a.pendingFor = null; a.status = 'running';
  a.messages.push({ role: 'user', content: '[Le superviseur a REFUSÉ cette action. Propose autre chose ou termine.]' });
  console.log(chalk.yellow(`\n✘ [Agent ${id}] Action refusée par le superviseur.`));
  saveAgentsToConv();
  runAgentLoop(a);
  return true;
}

// /agent user <n°> : rendre le contrôle à l'utilisateur.
export function setAgentUserControl(id) {
  const a = agents.get(id);
  if (!a) { console.log(chalk.red(`\n❌ Agent #${id} introuvable.`)); return false; }
  a.supervision = null; a.autoStepsLeft = 0;
  if (a.pendingFor === 'supervisor') a.pendingFor = 'user';
  console.log(chalk.green(`\n👤 [Agent ${id}] Contrôle rendu à l'utilisateur (/agent resume pour valider).`));
  saveAgentsToConv();
  return true;
}

// /agent show <n°> : voir les derniers échanges d'un agent SANS l'arrêter.
export function showAgentCommand(id) {
  const a = agents.get(id);
  if (!a) { console.log(chalk.red(`\n❌ Agent #${id} introuvable.`)); return; }
  console.log(chalk.bold.cyan(`\n🔎 Agent #${id} — ${a.status} — ${a.modelRef}`));
  console.log(chalk.gray(`Tâche : ${a.task}`));
  if (a.supervision) console.log(chalk.gray(`Supervision : ${a.supervision === 'auto' ? `auto (${a.autoStepsLeft} étapes restantes)` : 'validation par le superviseur'}`));
  for (const m of a.messages.slice(-8)) {
    const who = m.role === 'user' ? '→' : '✦';
    console.log(chalk.gray(`  ${who} [${m.role}] ${String(m.content).replace(/\s+/g, ' ').slice(0, 200)}`));
  }
  if (a.pendingAction) console.log(chalk.yellow(`  ⏸ Action en attente (${a.pendingFor || 'utilisateur'}) : ${a.pendingAction.kind === 'bash' ? a.pendingAction.code.split('\n')[0] : a.pendingAction.path}`));
}

// Boucle asynchrone d'un agent : appelle son modèle, exécute ses blocs, LUI RENVOIE les résultats
// (sans ça l'agent travaillerait à l'aveugle), et continue jusqu'à TERMINÉ, pause ou erreur.
async function runAgentLoop(agent) {
  if (agent.loopRunning) return; // une seule boucle par agent
  agent.loopRunning = true;
  try {
    while (agent.status === 'running') {
      // Mode auto accordé par le superviseur : 10 étapes puis pause automatique.
      if (agent.supervision === 'auto') {
        if (agent.autoStepsLeft <= 0) {
          agent.status = 'paused';
          agent.lastAction = '10 étapes auto effectuées — en attente du superviseur.';
          notifySupervisor(agent, `[Agent #${agent.id} a effectué ses 10 étapes auto et s'est arrêté. /agent auto ${agent.id} pour 10 de plus, /agent valid ${agent.id} pour validation, /agent stop ${agent.id} pour arrêter.]`);
          console.log(chalk.yellow(`\n⏸️ [Agent ${agent.id}] 10 étapes auto effectuées — en attente du superviseur.`));
          saveAgentsToConv();
          break;
        }
        agent.autoStepsLeft--;
      }
      agent.messages[0] = { role: 'system', content: agentSystemPrompt(agent) };
      if (agent.messages.length > 17) {
        agent.messages = [agent.messages[0], ...agent.messages.slice(-12)];
        while (agent.messages[1] && agent.messages[1].role !== 'user') agent.messages.splice(1, 1);
      }
      agent.ctrl = new AbortController();
      let reply;
      try { reply = (await chat(agent.modelRef, agent.messages, agent.ctrl.signal)).text; }
      finally { agent.ctrl = null; }
      if (agent.status !== 'running') break; // arrêté pendant l'appel
      if (!reply) throw new Error('Réponse vide.');
      agent.messages.push({ role: 'assistant', content: reply });
      addMessageToConv(agent.convId, 'assistant', `[Agent ${agent.id}] ${reply}`);
      const feedback = [];
      // 1) Délégation / supervision (blocs agent + lignes /agent...)
      feedback.push(...processAgentControl(reply, agent));
      // Phrase d'avancement : première ligne non vide hors bloc (une seule phrase affichée)
      const phrase = (reply.trim().split('\n').find(l => l.trim() && !l.trim().startsWith('```')) || 'Action…').trim().slice(0, 100);
      // 2) Blocs file: et bash, avec garde-fous + régime de supervision
      for (const b of extractBlocks(reply)) {
        if (agent.status !== 'running') break;
        if (b.type === 'file') { await agentFileBlock(agent, b, feedback); continue; }
        if (/(node\s+|\.\/)index\.js/.test(b.code)) { feedback.push('[Refusé : node index.js relance ce CLI interactif. Utilise node --check index.js.]'); continue; }
        const danger = isDangerous(b.code);
        const secret = /\.horde_settings/.test(b.code);
        const force = /^\s*#\s*CONFIRM\b/i.test(b.code);
        const action = { kind: 'bash', code: b.code };
        // Garde-fous durs : TOUJOURS l'utilisateur, jamais le superviseur.
        if (danger || secret || force) {
          const why = danger ? 'commande dangereuse' : secret ? 'fichier de clés API' : 'validation demandée (# CONFIRM)';
          pauseForValidation(agent, action, `${why} : ${b.code.split('\n')[0].slice(0, 70)}`);
          feedback.push('[Action en attente de validation utilisateur, non exécutée.]');
          break;
        }
        const gate = actionGate(agent);
        if (gate === 'supervisor') {
          if (!sendToSupervisor(agent, action, b.code.split('\n')[0].slice(0, 70))) pauseForValidation(agent, action, 'superviseur indisponible — validation utilisateur');
          feedback.push('[Action soumise pour validation, non exécutée.]');
          break;
        }
        if (gate === 'user') {
          pauseForValidation(agent, action, 'mode safe');
          feedback.push('[Action en attente de validation utilisateur, non exécutée.]');
          break;
        }
        agent.lastAction = phrase;
        console.log(chalk.blue(`\n⚡ [Agent ${agent.id}] ${phrase}`));
        console.log(chalk.gray(`   $ ${b.code.split('\n')[0]}${b.code.includes('\n') ? ' …' : ''}`));
        const r = await execCapture(b.code, agent.cwd);
        appendToSharedMemory(agent.id, `${phrase} -> code ${r.code}`);
        feedback.push(`[Commande exécutée : ${b.code}\nCode de sortie : ${r.code}\nSortie :\n${r.out}]`);
      }
      // 3) Blocs append: (suite de fichier), mêmes garde-fous
      if (agent.status === 'running') await agentAppends(agent, reply, feedback);
      // Résultats renvoyés à l'agent (même en cas de pause : il saura ce qui a été fait)
      if (feedback.length) {
        const msg = feedback.join('\n\n');
        agent.messages.push({ role: 'user', content: msg });
        addMessageToConv(agent.convId, 'user', `[Agent ${agent.id}] ${msg}`);
      }
      if (agent.status !== 'running') { saveAgentsToConv(); break; }
      if (isFinishedReply(reply)) {
        agent.status = 'finished';
        agent.lastAction = 'Tâche terminée.';
        console.log(chalk.green(`\n🏁 [Agent ${agent.id}] Tâche terminée.`));
        appendToSharedMemory(agent.id, `TÂCHE TERMINÉE : ${agent.task}`);
        saveAgentsToConv();
        break;
      }
      if (!feedback.length) agent.messages.push({ role: 'user', content: 'Poursuis la tâche (une phrase + action), ou termine par TERMINÉ seul sur la dernière ligne si fini.' });
      saveAgentsToConv();
      await new Promise(r => setTimeout(r, 1500)); // petite pause anti-spam API
    }
  } catch (err) {
    if (agent.status === 'running') {
      agent.status = 'paused';
      agent.lastAction = `Erreur : ${err.message}`;
      console.log(chalk.red(`\n❌ [Agent ${agent.id}] ${err.message} — /agent resume ${agent.id} pour réessayer.`));
    }
    saveAgentsToConv();
  } finally {
    agent.loopRunning = false;
  }
}

// Écriture de fichier par un agent : mêmes règles que doFile (mémoire JSON valide, clés API et
// raccourcissement suspect → validation utilisateur), plus le régime de supervision.
async function agentFileBlock(agent, b, feedback) {
  const full = expand(b.path);
  const isMem = [memoryPath(agent.convId), globalMemoryPath()].includes(full);
  const secret = full === SETTINGS_FILE;
  if (isMem) {
    try { JSON.parse(b.code); }
    catch (e) { feedback.push(`[Fichier ${b.path} NON écrit : JSON invalide (${e.message}). Renvoie le contenu COMPLET en JSON valide.]`); return; }
  }
  let shrink = false;
  try {
    if (!isMem && !secret && fs.existsSync(full)) {
      const oldLen = fs.statSync(full).size;
      const newLen = Buffer.byteLength(b.code, 'utf-8');
      if (oldLen > 200 && newLen < oldLen * 0.5) shrink = true;
    }
  } catch {}
  const action = { kind: 'file', path: b.path, code: b.code };
  if (secret || shrink) {
    pauseForValidation(agent, action, `écrire ${b.path} (${secret ? 'fichier de clés API' : 'raccourcissement suspect'})`);
    feedback.push('[Écriture en attente de validation utilisateur, non effectuée.]');
    return;
  }
  const gate = actionGate(agent);
  if (gate === 'supervisor') {
    if (!sendToSupervisor(agent, action, `écrire ${b.path}`)) pauseForValidation(agent, action, `écrire ${b.path} (superviseur indisponible)`);
    feedback.push('[Écriture soumise pour validation, non effectuée.]');
    return;
  }
  if (gate === 'user') {
    pauseForValidation(agent, action, `écrire ${b.path} (mode safe)`);
    feedback.push('[Écriture en attente de validation utilisateur, non effectuée.]');
    return;
  }
  try {
    writeFile(b.path, b.code);
    console.log(chalk.green(`\n📝 [Agent ${agent.id}] ${b.path} (${b.code.split('\n').length} lignes)`));
    appendToSharedMemory(agent.id, `écriture ${b.path}`);
    feedback.push(`[Fichier ${b.path} écrit avec succès]`);
    if (!isMem && !secret) {
      const err = await checkSyntax(full);
      if (err) feedback.push(`[Vérification automatique de ${b.path} :\n${err}\nCorrige ce fichier si besoin.]`);
    }
  } catch (e) {
    feedback.push(`[Échec de l'écriture de ${b.path} : ${e.message}]`);
  }
}

// Blocs append: d'un agent (suite d'un fichier long), mêmes garde-fous + supervision.
async function agentAppends(agent, reply, feedback) {
  const re = /```append:([^\n]+)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(reply))) {
    if (agent.status !== 'running') break;
    const p = m[1].trim();
    const code = m[2].replace(/\n$/, '');
    const full = expand(p);
    if ([memoryPath(agent.convId), globalMemoryPath()].includes(full)) {
      feedback.push(`[Append refusé sur ${p} : réécris la mémoire en entier avec un bloc file: en JSON valide.]`);
      continue;
    }
    const secret = full === SETTINGS_FILE;
    const action = { kind: 'append', path: p, code };
    if (secret) {
      pauseForValidation(agent, action, `ajouter à ${p} (fichier de clés API)`);
      feedback.push('[Ajout en attente de validation utilisateur, non effectué.]');
      break;
    }
    const gate = actionGate(agent);
    if (gate === 'supervisor') {
      if (!sendToSupervisor(agent, action, `ajouter à ${p}`)) pauseForValidation(agent, action, `ajouter à ${p} (superviseur indisponible)`);
      feedback.push('[Ajout soumis pour validation, non effectué.]');
      break;
    }
    if (gate === 'user') {
      pauseForValidation(agent, action, `ajouter à ${p} (mode safe)`);
      feedback.push('[Ajout en attente de validation utilisateur, non effectué.]');
      break;
    }
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.appendFileSync(full, code + '\n');
      console.log(chalk.green(`\n➕ [Agent ${agent.id}] ${p} (suite ajoutée)`));
      appendToSharedMemory(agent.id, `ajout à ${p}`);
      feedback.push(`[Suite ajoutée à ${p} avec succès]`);
      const err = await checkSyntax(full);
      if (err) feedback.push(`[Vérification automatique de ${p} :\n${err}\nCorrige ce fichier si besoin.]`);
    } catch (e) {
      feedback.push(`[Échec de l'ajout à ${p} : ${e.message}]`);
    }
  }
}

// Arrête un agent (interrompt aussi son appel API en cours). Utilisable à tout moment,
// même pendant que l'IA du premier plan travaille.
export function stopAgent(id) {
  const a = agents.get(id);
  if (!a || (a.status !== 'running' && a.status !== 'paused')) return false;
  a.status = 'stopped';
  a.lastAction = 'Arrêté.';
  a.pendingAction = null;
  a.pendingFor = null;
  a.ctrl?.abort();
  if (a.isSupervisor && supervisorId === id) supervisorId = null;
  console.log(chalk.yellow(`\n🛑 [Agent ${id}] Arrêté.`));
  saveAgentsToConv();
  return true;
}

// Reprend un agent en pause / arrêté. S'il avait une action en attente de validation,
// la reprise vaut VALIDATION : l'action est exécutée puis la boucle continue.
export function resumeAgent(id) {
  const a = agents.get(id);
  if (!a || (a.status !== 'paused' && a.status !== 'stopped')) return false;
  a.status = 'running';
  console.log(chalk.green(`\n▶️ [Agent ${id}] Repris.`));
  saveAgentsToConv();
  if (a.pendingAction) { const p = a.pendingAction; a.pendingAction = null; a.pendingFor = null; executeApproved(a, p); }
  else runAgentLoop(a);
  return true;
}

// Exécute l'action validée (par l'utilisateur via /agent resume, ou le superviseur via /agent allow),
// puis relance la boucle.
async function executeApproved(agent, p) {
  const feedback = [];
  try {
    if (p.kind === 'bash') {
      console.log(chalk.blue(`\n⚡ [Agent ${agent.id}] (validé) $ ${p.code.split('\n')[0]}`));
      const r = await execCapture(p.code, agent.cwd);
      appendToSharedMemory(agent.id, `(validé) ${p.code.split('\n')[0]} -> code ${r.code}`);
      feedback.push(`[Action validée exécutée : ${p.code}\nCode de sortie : ${r.code}\nSortie :\n${r.out}]`);
    } else {
      const full = expand(p.path);
      if (p.kind === 'append') { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.appendFileSync(full, p.code + '\n'); }
      else writeFile(p.path, p.code);
      console.log(chalk.green(`\n📝 [Agent ${agent.id}] (validé) ${p.path}`));
      appendToSharedMemory(agent.id, `(validé) écriture ${p.path}`);
      const err = await checkSyntax(full);
      feedback.push(`[Action validée : ${p.kind} ${p.path} appliqué.${err ? '\nVérification : ' + err : ''}]`);
    }
  } catch (e) {
    feedback.push(`[Échec de l'action validée : ${e.message}]`);
  }
  agent.messages.push({ role: 'user', content: feedback.join('\n\n') });
  saveAgentsToConv();
  runAgentLoop(agent);
}

export function getAgent(id) { return agents.get(id); }
export function getAllAgents() { return Array.from(agents.values()); }
export function getSupervisor() { return supervisorId ? agents.get(supervisorId) : null; }

export function clearSharedMemoryCommand() {
  clearSharedMemory();
  console.log(chalk.green('✅ Mémoire partagée des agents effacée.'));
}

// ========== PERSISTANCE : le groupe d'agents vit dans SA conversation ==========
// Sauvegardé dans agents.json du dossier de la conversation (séparé de session.json).
// Chaque conversation sauvegarde SES agents : changer de conversation ne mélange rien.

export function saveAgentsToConv() {
  const byConv = new Map();
  for (const a of agents.values()) {
    if (a.convId == null) continue;
    if (!byConv.has(a.convId)) byConv.set(a.convId, []);
    byConv.get(a.convId).push({
      id: a.id, task: a.task, modelRef: a.modelRef, mode: a.mode, status: a.status,
      lastAction: a.lastAction, isSupervisor: a.isSupervisor, parentId: a.parentId, cwd: a.cwd,
      supervision: a.supervision, autoStepsLeft: a.autoStepsLeft,
      messages: a.messages.slice(-10)
    });
  }
  for (const [cid, data] of byConv) saveAgentsData(cid, data);
}

// Restaure le groupe d'agents d'une conversation (appelé par /resume et au lancement).
// Toujours en pause : pas d'appels API surprise à la reprise ; /agent resume <n°> pour repartir.
export function restoreAgentsFromConv(convId) {
  if ([...agents.values()].some(a => a.convId === convId)) return []; // déjà en mémoire
  const saved = loadAgentsData(convId);
  if (!Array.isArray(saved) || !saved.length) return [];
  const restored = [];
  for (const s of saved) {
    if (s.status !== 'running' && s.status !== 'paused') continue;
    let id = s.id;
    while (agents.has(id)) id = nextAgentId();
    const a = {
      id, task: s.task, modelRef: s.modelRef, mode: s.mode,
      status: 'paused', convId, cwd: s.cwd || process.cwd(),
      lastAction: `Restauré (en pause) — /agent resume ${id} pour reprendre.`,
      isSupervisor: !!s.isSupervisor, parentId: s.parentId ?? null,
      supervision: s.supervision ?? null, autoStepsLeft: s.autoStepsLeft ?? 0, pendingFor: null,
      pendingAction: null, ctrl: null, loopRunning: false,
      messages: Array.isArray(s.messages) && s.messages.length ? s.messages : []
    };
    if (!a.messages.length || a.messages[0].role !== 'system') {
      a.messages = [
        { role: 'system', content: agentSystemPrompt(a) },
        { role: 'user', content: `TÂCHE : ${a.task}\nReprends là où tu en étais.` }
      ];
    }
    agents.set(id, a);
    if (a.isSupervisor) supervisorId = id;
    restored.push(a);
  }
  return restored;
}

// ========== SUPERVISEUR ==========
// /supervise <modèle> "<tâche>" : une IA qui découpe, délègue à des agents, vérifie leur travail
// et les recadre. Elle utilise les MÊMES mécanismes que l'IA principale (blocs agent + lignes /agent),
// donc tout ce qu'elle demande est réellement exécuté par processAgentControl.
export function createSupervisor(task, modelRef) {
  const t = [
    `SUPERVISION : ${task}`,
    "Découpe en sous-tâches et délègue : bloc ```agent:<modèle> <auto|safe> puis la tâche complète (un agent par sous-tâche, modèle adapté au domaine : code, rédaction, analyse...).",
    "Contrôle de l'autonomie des agents (chaque commande sur sa propre ligne) :",
    "/agent auto <n°> = l'agent agit seul pendant 10 étapes puis se met en pause (tu peux lui en redonner 10).",
    "/agent valid <n°> = chaque action de l'agent doit être validée par toi : tu recevras une demande, réponds /agent allow <n°> ou /agent deny <n°>.",
    "/agent user <n°> = rendre le contrôle à l'utilisateur. /agent show <n°> = voir ses derniers échanges.",
    "Surveille : /agents. Vérifie le travail produit avec des blocs ```bash (cat, node --check, git diff...).",
    "Recadre un agent qui dérive ou hallucine : /agent msg <n°> \"consigne\". Arrête-le si nécessaire : /agent stop <n°>.",
    "Respecte les préférences durables de la mémoire globale de l'utilisateur. Évite les doublons entre agents (mémoire partagée).",
    "Quand TOUT est fini et vérifié : TERMINÉ seul sur la dernière ligne."
  ].join('\n');
  return createAgent(t, modelRef, 'auto', true);
}

// /agent msg <n°> "<message>" côté utilisateur : transmis à l'agent (lu à sa prochaine étape,
// ou à sa reprise s'il est en pause).
export function sendMessageToAgent(agentId, message) {
  const a = agents.get(agentId);
  if (!a) { console.log(chalk.red(`\n❌ Agent #${agentId} introuvable.`)); return false; }
  a.messages.push({ role: 'user', content: `[MESSAGE de l'utilisateur] : ${message}` });
  addMessageToConv(a.convId, 'user', `[Message utilisateur pour agent #${agentId}] : ${message}`);
  console.log(chalk.green(`\n✉️ Message transmis à l'agent #${agentId}${a.status === 'running' ? '' : ' (lu à sa reprise)'}.`));
  saveAgentsToConv();
  return true;
}
