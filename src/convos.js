import fs from 'fs';
import os from 'os';
import path from 'path';

// Tout ce qui est propre à l'utilisateur (conversations, mémoires) vit ici, hors du dossier du
// programme : un `git pull` ou une mise à jour des fichiers du programme ne touche jamais ce dossier.
const DATA_DIR = path.join(os.homedir(), '.horde-cli-memoire');
const CONVOS_DIR = path.join(DATA_DIR, 'conversations');
const GLOBAL_FILE = path.join(DATA_DIR, 'global.json');
// Anciens emplacements (avant la séparation par conversation), pour migration unique au premier lancement.
const LEGACY_MEMORY = path.join(os.homedir(), '.ia_memory.json');
const LEGACY_SESSION = path.join(os.homedir(), '.horde_session.json');

export const globalMemoryPath = () => GLOBAL_FILE;

function ensureDirs() {
  fs.mkdirSync(CONVOS_DIR, { recursive: true });
}

function convDir(id) { return path.join(CONVOS_DIR, String(id)); }
export function sessionPath(id) { return path.join(convDir(id), 'session.json'); }
export function memoryPath(id) { return path.join(convDir(id), 'memory.json'); }
function metaPath(id) { return path.join(convDir(id), 'meta.json'); }

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}
function writeJSON(p, data) {
  try { fs.writeFileSync(p, JSON.stringify(data)); } catch {}
}

// Migration unique : ancienne mémoire globale (~/.ia_memory.json) -> mémoire globale du nouveau système.
// On ne supprime jamais l'ancien fichier, on se contente de copier son contenu la première fois.
function migrateLegacyGlobalMemory() {
  if (fs.existsSync(GLOBAL_FILE)) return;
  try {
    if (fs.existsSync(LEGACY_MEMORY)) fs.copyFileSync(LEGACY_MEMORY, GLOBAL_FILE);
    else fs.writeFileSync(GLOBAL_FILE, '{}');
  } catch {}
}

export function listConversations() {
  ensureDirs();
  let ids;
  try { ids = fs.readdirSync(CONVOS_DIR).filter(n => /^\d+$/.test(n)); } catch { ids = []; }
  return ids
    .map(n => { const id = +n; return { id, ...readJSON(metaPath(id), {}) }; })
    .map(c => ({
      id: c.id,
      title: c.title || '(sans titre)',
      model: c.model || null,
      createdAt: c.createdAt || null,
      updatedAt: c.updatedAt || c.createdAt || null,
      messageCount: c.messageCount || 0
    }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function nextId() {
  const existing = listConversations().map(c => c.id);
  return existing.length ? Math.max(...existing) + 1 : 1;
}

// Dérive un titre court et lisible depuis le premier message de l'utilisateur
export function autoTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 48 ? t.slice(0, 47) + '…' : (t || '(sans titre)');
}

export function loadMeta(id) { return readJSON(metaPath(id), null); }
export function saveMeta(id, meta) { ensureDirs(); fs.mkdirSync(convDir(id), { recursive: true }); writeJSON(metaPath(id), meta); }

export function touchMeta(id, patch) {
  const cur = loadMeta(id) || { id, createdAt: new Date().toISOString() };
  saveMeta(id, { ...cur, ...patch, updatedAt: new Date().toISOString() });
}

// Crée une nouvelle conversation vide et renvoie son id
export function createConversation() {
  ensureDirs();
  const id = nextId();
  fs.mkdirSync(convDir(id), { recursive: true });
  const now = new Date().toISOString();
  saveMeta(id, { id, title: null, model: null, createdAt: now, updatedAt: now, messageCount: 0 });
  writeJSON(memoryPath(id), {});
  return id;
}

// La conversation à reprendre par défaut au lancement : la plus récemment active, sinon une nouvelle.
// Migration unique : si l'ancienne session globale existe mais qu'aucune conversation n'existe encore,
// elle devient la conversation n°1.
export function defaultConversationId() {
  ensureDirs();
  migrateLegacyGlobalMemory();
  const list = listConversations();
  if (list.length) return list[0].id;
  const id = createConversation();
  try {
    if (fs.existsSync(LEGACY_SESSION)) {
      const m = JSON.parse(fs.readFileSync(LEGACY_SESSION, 'utf-8'));
      if (Array.isArray(m) && m.length > 1) {
        fs.writeFileSync(sessionPath(id), JSON.stringify(m));
        const firstUser = m.find(x => x.role === 'user');
        touchMeta(id, { title: autoTitle(firstUser?.content), messageCount: m.length });
      }
    }
  } catch {}
  return id;
}

export function readMemoryRaw(p, maxChars = 3000) {
  try { return fs.readFileSync(p, 'utf-8').slice(0, maxChars); } catch { return ''; }
}

// Supprime définitivement une conversation : dossier session + mémoire incluse.
export function deleteConversation(id) {
  const dir = convDir(id);
  if (!fs.existsSync(dir)) return false;
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}
