import fs from 'fs';
import os from 'os';

// Réglages persistants (clés API + modèles favoris), lisibles uniquement par l'utilisateur (chmod 600)
export const SETTINGS_FILE = os.homedir() + '/.horde_settings.json';
const ANON_HORDE = '0000000000';
let cache = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')); } catch { cache = {}; }
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  return cache;
}

function save() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
  try { fs.chmodSync(SETTINGS_FILE, 0o600); } catch {}
}

// Priorité : clé définie avec la commande /api..., sinon variable d'environnement, sinon rien
export const getHordeKey = () => load().hordeKey || process.env.AI_HORDE_API_KEY || ANON_HORDE;
export const getSearchKey = () => load().searchKey || process.env.SEARCH_API_KEY || '';

export function keySource(which) {
  const s = load();
  if (which === 'horde') return s.hordeKey ? 'commande' : (process.env.AI_HORDE_API_KEY ? 'variable d’environnement' : null);
  return s.searchKey ? 'commande' : (process.env.SEARCH_API_KEY ? 'variable d’environnement' : null);
}

export function setHordeKey(k) {
  const s = load();
  if (k) s.hordeKey = k; else delete s.hordeKey;
  save();
}

export function setSearchKey(k) {
  const s = load();
  if (k) s.searchKey = k; else delete s.searchKey;
  save();
}

export const maskKey = (k) => (k ? '••••' + k.slice(-4) : '(aucune)');

export function getFavorites(defaults) {
  const f = load().favorites;
  const ok = Array.isArray(f) ? f.filter(x => typeof x === 'string' && x) : [];
  return ok.length ? ok : [...defaults];
}

// null = revenir aux favoris par défaut
export function setFavorites(list) {
  const s = load();
  if (list) s.favorites = [...list]; else delete s.favorites;
  save();
}

// ---------- Autres fournisseurs IA (Gemini, OpenAI, Claude, personnalisés...) ----------
// Chaque fournisseur : { name, type: 'openai' | 'anthropic', baseUrl, key }
export function getProviders() {
  const p = load().providers;
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}
export const getProvider = (id) => getProviders()[id] || null;

export function setProvider(id, data) {
  const s = load();
  s.providers = { ...getProviders(), [id]: data };
  save();
}

export function removeProvider(id) {
  const s = load();
  const all = { ...getProviders() };
  const existed = id in all;
  delete all[id];
  s.providers = all;
  save();
  return existed;
}

// ---------- Dernier modèle utilisé, mémorisé par fournisseur (/use <fournisseur> sans nom) ----------
export function getLastModel(provider) {
  const m = load().lastModels;
  return m && typeof m === 'object' ? (m[provider] || null) : null;
}

export function setLastModel(provider, ref) {
  const s = load();
  s.lastModels = { ...(s.lastModels && typeof s.lastModels === 'object' ? s.lastModels : {}), [provider]: ref };
  save();
}
