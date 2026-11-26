#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { buildSystem } from './context.js';
import { FAVORITES, MAX_FILE_CHARS } from './config.js';
import { DEFAULT_CLOUD_LIMITS } from './models.js';
import { banner, help } from './ui.js';
import { expand, run } from './exec.js';
import { getHordeKey, getSearchKey, setHordeKey, setSearchKey, keySource, maskKey, setFavorites, getProviders, getProvider, setProvider, removeProvider, getLastModel, setLastModel } from './settings.js';
import { S, rl, ask, askAI, askRaw, showModels, saveSession, loadSession, initConversations, resumeCommand, newConversationCommand, delConvCommand, pickStrongest, interrupt, refreshSystem, maybeWarnCloud, createAgent, getAllAgents, stopAgent, resumeAgent, clearSharedMemoryCommand, createSupervisor, sendMessageToAgent } from './agent.js';
import { listModels } from './api.js';
import { PRESETS, PRESET_ALIASES, parseRef, makeRef, iconFor } from './models.js';
import { memoryPath, globalMemoryPath } from './convos.js';

let buffer = null;
let busy = false;
let lastSigint = 0;
let watchTimer = null; // /agents watch : rafraîchissement auto (null = inactif)

const show = () => banner(S.model, S.auto, { search: !!getSearchKey(), simple: S.simple, conv: S.convId });
const prompt = () => {
  const dir = process.cwd().split('/').pop() || '/';
  rl.setPrompt(chalk.cyan.bold(`\n${dir}${S.auto ? " [AUTO]" : ""} ❯ `));
  rl.prompt();
};

// Nom lisible d'une référence de modèle
const label = (ref) => {
  const { provider, model } = parseRef(ref);
  return provider === 'horde' ? model : `${model}  (${provider})`;
};

// "gemini gemini-2.5-flash" → référence ; null si le premier mot n'est pas un fournisseur
function refFromArgs(tokens) {
  const [first, ...rest] = tokens;
  if (rest.length && (first === 'horde' || getProvider(first))) return makeRef(first, rest.join(' '));
  return null;
}

async function useModel(m) {
  S.model = m;
  setLastModel(parseRef(m).provider, m);
  maybeWarnCloud(m);
  refreshSystem();
  show();
  console.log(chalk.green('✔ Modèle : ' + label(m)));
  if (S.last) await askAI(S.last);
}

// ---------- Fichiers (découpés en parties pour respecter le budget de tokens) ----------
// Taille d'une partie envoyée par /file : généreuse pour les fournisseurs cloud (gros contexte),
// plus stricte pour AI Horde (petit contexte, voir config.js).
function fileChunkSize() {
  if (parseRef(S.model).provider === 'horde') return MAX_FILE_CHARS;
  const p = getProvider(parseRef(S.model).provider);
  const limits = p?.limits || DEFAULT_CLOUD_LIMITS;
  return Math.floor(limits.prompt * 2.5); // large marge, laissée à fitToTokenBudget pour l'ajustement fin
}

function splitParts(text, size) {
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    let l = line;
    while (l.length > size) {
      if (cur) { parts.push(cur); cur = ''; }
      parts.push(l.slice(0, size));
      l = l.slice(size);
    }
    if (cur && cur.length + l.length + 1 > size) { parts.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + l;
  }
  if (cur) parts.push(cur);
  return parts.length ? parts : [''];
}

async function sendFile(arg) {
  let target = arg.trim();
  let part = 1;
  const m = target.match(/^(.*\S)\s+(\d+)$/);
  if (m && fs.existsSync(expand(m[1]))) { target = m[1]; part = parseInt(m[2], 10); }
  const p = expand(target);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    console.log(chalk.red('Fichier introuvable : ' + p));
    return;
  }
  const parts = splitParts(fs.readFileSync(p, 'utf-8'), fileChunkSize());
  if (part < 1 || part > parts.length) {
    console.log(chalk.red(`Ce fichier n'a que ${parts.length} partie(s).`));
    return;
  }
  const multi = parts.length > 1;
  if (multi) {
    console.log(chalk.yellow(`📄 Partie ${part}/${parts.length}` + (part < parts.length ? ` — /file ${target} ${part + 1} pour la suite.` : ' (dernière).')));
  }
  await askAI(
    `Contenu de \`${p}\`${multi ? ` (partie ${part}/${parts.length})` : ''} :\n\n\`\`\`\n${parts[part - 1]}\n\`\`\`\n` +
    (multi ? "Fichier envoyé en plusieurs parties : analyse celle-ci, la suite viendra si besoin." : 'Analyse-le.')
  );
}

// ---------- Sauvegarde de la conversation ----------
function save() {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const f = path.join(dir, `historique-${Date.now()}.md`);
    fs.writeFileSync(f, S.messages.slice(1).map(m => `## ${m.role}\n\n${m.content}\n`).join('\n'));
    console.log(chalk.green('✔ Sauvegardé : ' + f));
  } catch (e) { console.log(chalk.red('✘ Sauvegarde impossible : ' + e.message)); }
}

// ---------- Modèles favoris ----------
function showFavs() {
  console.log(chalk.hex('#c084fc').bold('\n Modèles favoris'));
  S.favs.forEach((m, i) => {
    const { sym, color } = iconFor(m);
    console.log(`  ${chalk.hex('#fbbf24')(`/${i + 1}`.padEnd(5))}${m === S.model ? chalk.green('● ') : '  '}${chalk.hex(color)(sym)} ${chalk.hex('#34d399')(label(m))}`);
  });
  console.log(chalk.gray('\n  /fav add [n°|nom] · /fav del <n°> · /fav reset\n'));
}

function favCommand(arg) {
  const [sub, ...rest] = arg.trim().split(/\s+/).filter(Boolean);
  const val = rest.join(' ');
  if (!sub) return showFavs();
  if (sub === 'add') {
    const m = !val ? S.model : /^\d+$/.test(val) ? S.models[+val - 1] : (refFromArgs(val.split(/\s+/)) || val);
    if (!m) return console.log(chalk.red('Numéro invalide (utilise celui de /live).'));
    if (S.favs.includes(m)) return console.log(chalk.yellow('Déjà dans les favoris.'));
    S.favs.push(m);
    setFavorites(S.favs);
    console.log(chalk.green(`✔ Ajouté : /${S.favs.length} → ${label(m)}`));
  } else if (sub === 'del' || sub === 'rm') {
    const i = parseInt(val, 10) - 1;
    if (!(i >= 0 && i < S.favs.length)) return console.log(chalk.red('Numéro de favori invalide.'));
    if (S.favs.length === 1) return console.log(chalk.red('Garde au moins un favori.'));
    const [gone] = S.favs.splice(i, 1);
    setFavorites(S.favs);
    console.log(chalk.green(`✔ Retiré : ${label(gone)}`));
  } else if (sub === 'reset') {
    S.favs.splice(0, S.favs.length, ...FAVORITES);
    setFavorites(null);
    console.log(chalk.green('✔ Favoris par défaut rétablis.'));
  } else {
    return console.log(chalk.red('Usage : /fav, /fav add [n°|nom], /fav del <n°>, /fav reset'));
  }
  showFavs();
}

// ---------- Clés API (enregistrées dans ~/.horde_settings.json, hors du dossier du programme) ----------
function keyCommand(which, arg) {
  const horde = which === 'horde';
  const label = horde ? 'AI Horde' : 'recherche web';
  const v = arg.trim();
  if (!v) {
    const src = keySource(which);
    const k = horde ? getHordeKey() : getSearchKey();
    if (horde && !src) console.log(`Clé ${label} : anonyme (aucune clé définie). /apihorde <clé> pour en définir une.`);
    else if (!k) console.log(`Clé ${label} : non définie. /apisearch <clé> pour activer la recherche web.`);
    else console.log(`Clé ${label} : ${maskKey(k)} (via ${src})`);
    return;
  }
  if (/\s/.test(v)) return console.log(chalk.red('La clé ne doit pas contenir d’espace.'));
  if (v.toLowerCase() === 'off') {
    if (horde) setHordeKey(null); else setSearchKey(null);
    console.log(chalk.green(`✔ Clé ${label} retirée.`));
  } else {
    if (horde) setHordeKey(v); else setSearchKey(v);
    console.log(chalk.green(`✔ Clé ${label} enregistrée (${maskKey(v)}) : elle sera conservée après les mises à jour.`));
  }
  if (!horde) {
    refreshSystem();
    console.log(chalk.gray(getSearchKey() ? 'Recherche web activée.' : 'Recherche web désactivée.'));
  }
}

// ---------- Fournisseurs IA (Gemini, ChatGPT, Claude, personnalisés...) ----------
const normKey = (k) => (['none', '-', 'aucune'].includes((k || '').toLowerCase()) ? '' : k);

function showProviders() {
  const row = (id, name, detail) => console.log(`  ${chalk.hex('#fbbf24')(id.padEnd(12))}${chalk.hex('#34d399')(name.padEnd(20))}${chalk.hex('#94a3b8')(detail)}`);
  console.log(chalk.hex('#c084fc').bold('\n Fournisseurs IA'));
  const hk = keySource('horde');
  row('horde', 'AI Horde', hk ? `clé ${maskKey(getHordeKey())} (${hk})` : 'clé anonyme');
  for (const [id, p] of Object.entries(getProviders())) {
    row(id, clipName(p.name || id), `${p.key ? 'clé ' + maskKey(p.key) : 'sans clé'} · ${p.type}`);
  }
  console.log(chalk.gray('\n  /api add · /api del <id> · /api test <id> · /live <id> [mots] · /use <id> <modèle>\n'));
}
const clipName = (s) => (s.length > 19 ? s.slice(0, 18) + '…' : s);

async function testProvider(id) {
  try {
    const list = await listModels(id);
    console.log(chalk.green(`✔ Connexion OK : ${list.length} modèle(s). /live ${id} pour les voir, /live ${id} <mot> pour chercher.`));
  } catch (e) {
    console.log(chalk.yellow(`⚠ Test échoué : ${e.message}`));
    console.log(chalk.gray(`  La configuration est enregistrée. Pour corriger la clé : /api add ${id} <nouvelle clé>`));
  }
}

async function saveProvider(id, data) {
  setProvider(id, data);
  console.log(chalk.green(`✔ ${data.name} enregistré (${data.key ? maskKey(data.key) : 'sans clé'}) : conservé après les mises à jour.`));
  await testProvider(id);
}

// Menu guidé : choisir un fournisseur dans la liste, puis coller la clé
async function providerWizard() {
  const ids = Object.keys(PRESETS);
  console.log(chalk.hex('#c084fc').bold('\n Ajouter un fournisseur IA\n'));
  ids.forEach((id, i) => console.log(`  ${chalk.yellow(`[${i + 1}]`)} ${PRESETS[id].name}`));
  console.log(`  ${chalk.yellow(`[${ids.length + 1}]`)} Autre (n'importe quelle API compatible OpenAI, ou Ollama / LM Studio en local)\n`);
  const n = parseInt(await askRaw(chalk.cyan(' Numéro (vide = annuler) : ')), 10);
  if (!(n >= 1 && n <= ids.length + 1)) return console.log(chalk.gray('Annulé.'));
  let id, data;
  if (n <= ids.length) {
    id = ids[n - 1];
    data = { ...PRESETS[id] };
  } else {
    id = (await askRaw(chalk.cyan(' Identifiant court (ex : monia) : '))).toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(id) || id === 'horde') return console.log(chalk.red('Identifiant invalide (lettres, chiffres, - et _).'));
    const url = await askRaw(chalk.cyan(' URL de base (ex : https://exemple.com/v1) : '));
    if (!/^https?:\/\//.test(url)) return console.log(chalk.red('URL invalide.'));
    const claude = /anthropic\.com/.test(url) || (await askRaw(chalk.cyan(' API de type Claude/Anthropic ? (o/N) : '))).toLowerCase() === 'o';
    data = { name: id, type: claude ? 'anthropic' : 'openai', baseUrl: url.replace(/\/+$/, '') };
  }
  const key = await askRaw(chalk.cyan(` Clé API ${data.name} (« none » si aucune) : `));
  if (!key) return console.log(chalk.gray('Annulé.'));
  if (/\s/.test(key)) return console.log(chalk.red('La clé ne doit pas contenir d’espace.'));
  await saveProvider(id, { ...data, key: normKey(key) });
}

async function addProvider(args) {
  if (!args.length) return providerWizard();
  let [id, key, url, type] = args;
  id = id.toLowerCase();
  id = PRESET_ALIASES[id] || id;
  if (id === 'horde') return console.log(chalk.yellow('Pour AI Horde : /apihorde <clé>'));
  if (!/^[a-z0-9_-]+$/.test(id)) return console.log(chalk.red('Identifiant invalide (lettres, chiffres, - et _).'));
  if (!key) return console.log(chalk.red('Usage : /api add <id> <clé> [url] [anthropic]   (ou /api add pour le menu)'));
  const preset = PRESETS[id];
  let data;
  if (preset && !url) data = { ...preset };
  else if (url && /^https?:\/\//.test(url)) {
    data = { name: preset?.name || id, type: (type === 'anthropic' || /anthropic\.com/.test(url)) ? 'anthropic' : 'openai', baseUrl: url.replace(/\/+$/, '') };
  } else {
    return console.log(chalk.red(`« ${id} » n'est pas un fournisseur connu : ajoute l'URL (ex : /api add ${id} <clé> https://exemple.com/v1).`));
  }
  await saveProvider(id, { ...data, key: normKey(key) });
}

async function apiCommand(arg) {
  const [sub, ...rest] = arg.trim().split(/\s+/).filter(Boolean);
  if (!sub || sub === 'list') return showProviders();
  if (sub === 'add') return addProvider(rest);
  if (sub === 'del' || sub === 'rm') {
    const id = (rest[0] || '').toLowerCase();
    if (!removeProvider(id)) return console.log(chalk.red(`Fournisseur inconnu : « ${id} ».`));
    console.log(chalk.green(`✔ ${id} retiré.`));
    if (parseRef(S.model).provider === id) console.log(chalk.yellow('⚠ Le modèle actuel venait de ce fournisseur : choisis-en un autre (/1, /live...).'));
    if (S.favs.some(f => parseRef(f).provider === id)) console.log(chalk.gray('  Des favoris utilisent ce fournisseur : /fav pour les retirer.'));
    return;
  }
  if (sub === 'test') {
    const id = (rest[0] || '').toLowerCase();
    if (id !== 'horde' && !getProvider(id)) return console.log(chalk.red(`Fournisseur inconnu : « ${id} ». /api pour la liste.`));
    return testProvider(id);
  }
  console.log(chalk.red('Usage : /api, /api add, /api del <id>, /api test <id>'));
}

// /live [fournisseur] [mots] : liste / recherche de modèles
async function liveCommand(arg) {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  let provider = 'horde';
  if (tokens.length && (tokens[0].toLowerCase() === 'horde' || getProvider(tokens[0].toLowerCase()))) provider = tokens.shift().toLowerCase();
  await showModels({ provider, filter: tokens.join(' ') });
}

// ---------- Agents : tableau de bord, surveillance, commandes ----------
function showAgentsDashboard() {
  const list = getAllAgents();
  if (list.length === 0) {
    console.log(chalk.gray('\nAucun agent actif. Utilise /agent new ou /supervise pour en créer un.'));
    return;
  }
  console.log(chalk.bold.cyan('\n📊 Tableau de bord des agents :'));
  list.forEach(a => {
    const statusColor = a.status === 'running' ? chalk.green : (a.status === 'paused' ? chalk.yellow : (a.status === 'finished' ? chalk.blue : chalk.red));
    const supervisorMark = a.isSupervisor ? chalk.hex('#fbbf24')(' 👑 SUPERVISEUR') : '';
    console.log(`  #${a.id}${supervisorMark} | ${statusColor(a.status.toUpperCase().padEnd(8))} | ${a.modelRef}`);
    console.log(`     Tâche : ${a.task}`);
    console.log(`     Dernier acte : ${a.lastAction}`);
  });
  console.log(chalk.gray('\n  /agent stop <id> · /agent resume <id> · /agent msg <id> "<msg>" · /agent clear-shared · /agents watch'));
}

function stopWatch(msg) {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; if (msg) console.log(chalk.gray(msg)); }
}

function drawWatch() {
  const list = getAllAgents();
  console.clear();
  console.log(chalk.bold.cyan(`📊 Agents — ${new Date().toLocaleTimeString('fr-FR')}   (Ctrl+C ou /agents watch pour quitter)`));
  console.log(chalk.gray('─'.repeat(Math.min(process.stdout.columns || 60, 64))));
  if (!list.length) console.log(chalk.gray('Aucun agent.'));
  for (const a of list) {
    const statusColor = a.status === 'running' ? chalk.green : (a.status === 'paused' ? chalk.yellow : (a.status === 'finished' ? chalk.blue : chalk.red));
    const supervisorMark = a.isSupervisor ? chalk.hex('#fbbf24')(' 👑') : '';
    console.log(`  #${a.id}${supervisorMark} | ${statusColor(a.status.toUpperCase().padEnd(8))} | ${a.modelRef}`);
    console.log(`     Tâche : ${a.task.slice(0, 70)}`);
    console.log(`     Dernier acte : ${a.lastAction}`);
  }
  if (!list.some(a => a.status === 'running' || a.status === 'paused')) {
    stopWatch();
    console.log(chalk.gray('\nPlus aucun agent actif — surveillance arrêtée.'));
    prompt();
  }
}

// Commandes agents : utilisables AUSSI pendant que l'IA du premier plan travaille (voir plus bas).
async function agentCommands(input) {
  if (input === '/agents') { showAgentsDashboard(); return; }
  if (input === '/agents watch') {
    if (watchTimer) { stopWatch('\nSurveillance arrêtée.'); return; }
    if (!getAllAgents().length) { console.log(chalk.gray('\nAucun agent à surveiller.')); return; }
    drawWatch();
    watchTimer = setInterval(drawWatch, 2000);
    return;
  }
  if (input.startsWith('/agent ')) {
    const parts = input.slice(7).trim().split(/\s+/);
    const subCmd = parts[0]?.toLowerCase();
    if (subCmd === 'new') {
      if (parts.length < 4) {
        console.log(chalk.yellow('\nUsage: /agent new <modèle> <auto|safe> "<tâche>"'));
        console.log(chalk.gray('Ex: /agent new @openai:gpt-4 auto "Analyse tous les fichiers .js du dossier"'));
      } else {
        const model = parts[1];
        const mode = parts[2].toLowerCase();
        if (mode !== 'auto' && mode !== 'safe') console.log(chalk.red('\nLe mode doit être "auto" ou "safe".'));
        else createAgent(parts.slice(3).join(' ').replace(/^"|"$/g, ''), model, mode);
      }
    } else if (subCmd === 'stop') {
      const id = parseInt(parts[1]);
      if (!stopAgent(id)) console.log(chalk.red(`\n❌ Agent ${id} introuvable ou déjà arrêté.`));
    } else if (subCmd === 'resume') {
      const id = parseInt(parts[1]);
      if (!resumeAgent(id)) console.log(chalk.red(`\n❌ Impossible de relancer l'agent ${id}.`));
    } else if (subCmd === 'msg') {
      if (parts.length < 3) console.log(chalk.yellow('\nUsage: /agent msg <id> "<message>"'));
      else sendMessageToAgent(parseInt(parts[1]), parts.slice(2).join(' ').replace(/^"|"$/g, ''));
    } else if (subCmd === 'clear-shared') {
      clearSharedMemoryCommand();
    } else {
      console.log(chalk.yellow('\nCommande /agent inconnue. Tape /help.'));
    }
    return;
  }
  if (input.startsWith('/supervise ')) {
    const parts = input.slice(11).trim().split(/\s+/);
    if (parts.length < 2) {
      console.log(chalk.yellow('\nUsage: /supervise <modèle> "<tâche>"'));
      console.log(chalk.gray('Ex: /supervise @openai:gpt-4 "Refactorise tout le code du projet"'));
      console.log(chalk.gray("Le superviseur est une IA qui crée et coordonne d'autres agents."));
    } else {
      createSupervisor(parts.slice(1).join(' ').replace(/^"|"$/g, ''), parts[0]);
    }
    return;
  }
}

// ---------- Commandes ----------
async function command(input) {
  if (input === '/help') help(S.favs);
  else if (input === '/clear') {
    S.messages = [{ role: 'system', content: buildSystem(parseRef(S.model).provider, S.simple) }];
    S.pending = []; saveSession();
    S.last = null;
    show();
    // La mémoire vit dans le dossier de la conversation courante (~/.horde-cli-memoire/conversations/<n°>/),
    // plus jamais dans ~/.ia_memory.json : on propose de vider celle de cette conversation.
    const hasContent = (p) => { try { const t = fs.readFileSync(p, 'utf-8').trim(); return !!t && t !== '{}' && t !== '[]'; } catch { return false; } };
    const memTargets = [memoryPath(S.convId), globalMemoryPath()].filter(Boolean);
    const existing = memTargets.filter(hasContent);
    if (existing.length) {
      const a = await ask(chalk.yellow('Vider aussi la mémoire de cette conversation ? [o/N] '));
      if (a === 'o') {
        try {
          for (const p of existing) fs.writeFileSync(p, '{}');
          refreshSystem();
          console.log(chalk.green('✔ Mémoire de la conversation vidée (la mémoire globale est conservée ; /resume <n°> pour retrouver les autres conversations).'));
        } catch (e) { console.log(chalk.red('✘ ' + e.message)); }
      }
    }
  }
  else if (input === '/resume' || input.startsWith('/resume ')) { if (await resumeCommand(input.slice(7))) show(); }
  else if (input === '/new') { newConversationCommand(); show(); }
  else if (input.startsWith('/delconv')) await delConvCommand(input.slice(8));
  else if (input === '/assistant') {
    S.simple = !S.simple;
    refreshSystem();
    show();
    console.log(S.simple
      ? chalk.yellow('Mode assistant : juste parler et chercher sur le web (ddgr), aucun accès au système.')
      : chalk.green('Mode agent complet rétabli.'));
  }
  else if (input === '/live' || input.startsWith('/live ')) await liveCommand(input.slice(5));
  else if (input === '/top') await useModel(await pickStrongest());
  else if (/^\/\d+$/.test(input)) {
    const m = S.favs[+input.slice(1) - 1];
    if (m) await useModel(m); else console.log(chalk.red(`Pas de favori n°${input.slice(1)}. /fav pour la liste.`));
  }
  else if (input === '/fav' || input.startsWith('/fav ')) favCommand(input.slice(4));
  else if (input.startsWith('/use ')) {
    const arg = input.slice(5).trim();
    const tokens = arg.split(/\s+/).filter(Boolean);
    const bareProvider = tokens.length === 1 && (tokens[0] === 'horde' || getProvider(tokens[0])) ? tokens[0] : null;
    let m = null;
    if (/^\d+$/.test(arg)) m = S.models[+arg - 1];
    else if (bareProvider) {
      m = getLastModel(bareProvider);
      if (!m) console.log(chalk.yellow(`Aucun modèle mémorisé pour ${bareProvider}. /live ${bareProvider} pour en choisir un.`));
    } else m = refFromArgs(tokens);
    if (m) await useModel(m);
    else if (!bareProvider) console.log(chalk.red('Numéro invalide. Usage : /use <n°>, /use <fournisseur> (dernier utilisé) ou /use <fournisseur> <modèle>'));
  }
  else if (input === '/auto') { S.auto = !S.auto; show(); }
  else if (/^\d+$/.test(input)) {
    const m = S.models[+input - 1];
    if (m) await useModel(m); else console.log(chalk.red('Numéro invalide.'));
  }
  else if (input === '/api' || input.startsWith('/api ')) await apiCommand(input.slice(4));
  else if (input === '/apihorde' || input.startsWith('/apihorde ')) keyCommand('horde', input.slice(9));
  else if (input === '/apisearch' || input.startsWith('/apisearch ')) keyCommand('search', input.slice(10));
  else if (input.startsWith('/cd ')) {
    try { process.chdir(expand(input.slice(4).trim())); show(); }
    catch (e) { console.log(chalk.red(e.message)); }
  }
  else if (input.startsWith('!')) {
    const r = await run(input.slice(1));
    S.pending.push(`[L'utilisateur a lancé : ${input.slice(1)}\nSortie :\n${r.out}]`);
  }
  else if (input === '/save') save();
  else if (input.startsWith('/file ')) await sendFile(input.slice(6));
  else if (input === '/agents' || input === '/agents watch' || input.startsWith('/agent ') || input.startsWith('/supervise ')) await agentCommands(input);
  else if (/^\/[a-z0-9]+(\s|$)/i.test(input)) console.log(chalk.red('Commande inconnue. /help pour la liste.'));
  else await askAI(input);
}

// Exécute une action en marquant le programme comme occupé (les lignes tapées pendant ce temps sont ignorées)
async function guarded(fn) {
  busy = true;
  try { await fn(); }
  catch (e) { console.log(chalk.red('✘ ' + e.message)); }
  finally { busy = false; }
}

show();
const restored = initConversations();
if (restored) console.log(chalk.green(`↺ Conversation #${S.convId} reprise (${restored} messages). /clear pour repartir de zéro, /resume pour changer de conversation.`));
else console.log(chalk.gray(`Conversation #${S.convId}. /resume : liste des conversations · /new : nouvelle · /delconv <n°> : supprimer.`));
prompt();
rl.on('close', () => process.exit(0));

// Ctrl+C : quitte d'abord la surveillance ; sinon interrompt l'IA si elle travaille ;
// sinon il faut le faire 2 fois de suite pour quitter
rl.on('SIGINT', () => {
  if (watchTimer) { stopWatch('\nSurveillance arrêtée.'); return prompt(); }
  const now = Date.now();
  if (buffer !== null) {
    buffer = null;
    console.log(chalk.gray('\nSaisie multi-lignes annulée.'));
    return prompt();
  }
  if (now - lastSigint < 2000) { console.log(); process.exit(0); }
  lastSigint = now;
  if (busy) return interrupt();
  console.log(chalk.yellow('\nCtrl+C encore une fois pour quitter (ou /exit).'));
  prompt();
});

rl.on('line', async (raw) => {
  const input = raw.trim();
  if (buffer !== null) {
    if (input === '/end') {
      const t = buffer.join('\n');
      buffer = null;
      if (t) await guarded(() => askAI(t));
      prompt();
    } else buffer.push(raw);
    return;
  }
  if (input === '/exit') process.exit(0);
  if (input === '/stop') {
    if (busy) interrupt(); else console.log(chalk.gray('Rien à interrompre.'));
    return;
  }
  if (busy) {
    if (input === '/auto') {
      S.auto = !S.auto;
      console.log(chalk.yellow(`Mode auto : ${S.auto ? 'ON' : 'OFF'}`));
    } else if (input === '/agents' || input === '/agents watch' || input.startsWith('/agent ') || input.startsWith('/supervise ')) {
      // Les commandes agents restent disponibles PENDANT que l'IA du premier plan travaille :
      // voir, arrêter, relancer, lancer un superviseur à tout moment.
      await agentCommands(input);
      prompt();
    } else if (input) console.log(chalk.yellow("⏳ L'IA travaille… /stop pour l'interrompre."));
    return;
  }
  if (!input) return prompt();
  if (input === '/paste') {
    buffer = [];
    console.log(chalk.gray('Colle ton texte, puis tape /end sur une ligne seule.'));
    return;
  }
  await guarded(() => command(input));
  prompt();
});
