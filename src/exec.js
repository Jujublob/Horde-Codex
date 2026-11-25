import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DANGER = /\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\$HOME|\*)|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|>\s*\/dev\/sd|\bchmod\s+-R\s+777\s+\//;
export const isDangerous = (cmd) => DANGER.test(cmd);

export function extractBlocks(text) {
  const out = [];
  const re = /```([\w+-]*)(?::([^\n]+))?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    const lang = m[1].toLowerCase();
    const file = m[2] && m[2].trim();
    const code = m[3].replace(/\n$/, '');
    if (lang === 'file' && file) out.push({ type: 'file', path: file, code });
    else if (['bash', 'sh', 'shell', 'zsh'].includes(lang)) out.push({ type: 'cmd', code });
  }
  return out;
}

export function expand(p) {
  return p.startsWith('~') ? p.replace('~', os.homedir()) : path.resolve(p);
}

// Garde jusqu'à 3 sauvegardes en rotation (.bak le plus récent, .bak.2, .bak.3 le plus ancien)
// au lieu d'une seule écrasée à chaque réécriture.
const BACKUPS = 3;
function rotateBackups(full) {
  for (let i = BACKUPS - 1; i >= 1; i--) {
    const src = i === 1 ? `${full}.bak` : `${full}.bak.${i}`;
    const dst = `${full}.bak.${i + 1}`;
    if (fs.existsSync(src)) { try { fs.renameSync(src, dst); } catch {} }
  }
}

export function writeFile(p, code) {
  const full = expand(p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  let bak = false;
  if (fs.existsSync(full)) {
    rotateBackups(full);
    fs.copyFileSync(full, full + '.bak');
    bak = true;
  }
  fs.writeFileSync(full, code + '\n');
  return { full, bak };
}

let current = null;

// Tue la commande et tous ses sous-processus (groupe de processus)
function killTree(p) {
  try { process.kill(-p.pid, 'SIGTERM'); }
  catch { try { p.kill('SIGTERM'); } catch {} }
}

// Interrompt la commande en cours (utilisé par /stop)
export function killRunning() {
  if (!current) return false;
  killTree(current);
  return true;
}

export function run(cmd) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('bash', ['-c', cmd], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    current = p;
    const add = (d) => { process.stdout.write(d); out += d; };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    // PAS de timeout : la commande tourne autant que nécessaire.
    // L'interruption reste possible via /stop ou Ctrl+C (killRunning).
    const done = (r) => { if (current === p) current = null; resolve(r); };
    p.on('close', (code, sig) => done({ code: code ?? (sig ? `interrompu (${sig})` : -1), out: out.slice(-2500) }));
    p.on('error', (e) => done({ code: -1, out: e.message }));
  });
}

// Vérification automatique après écriture (attrape une bonne partie des erreurs d'hallucination
// avant qu'elles ne cassent le programme de l'utilisateur). Retourne null si OK ou non applicable,
// sinon un court message d'erreur à renvoyer à l'IA.
export async function checkSyntax(full) {
  const ext = full.split('.').pop().toLowerCase();
  const q = JSON.stringify(full);
  try {
    if (['js', 'mjs', 'cjs'].includes(ext)) {
      const r = await run(`node --check ${q} 2>&1`);
      return r.code === 0 ? null : `node --check a signalé un problème :\n${r.out.trim().slice(-500)}`;
    }
    if (ext === 'json') {
      JSON.parse(fs.readFileSync(full, 'utf-8'));
      return null;
    }
    if (ext === 'py') {
      const r = await run(`{ python3 -m py_compile ${q} || python -m py_compile ${q}; } 2>&1`);
      return r.code === 0 ? null : `Vérification Python :\n${r.out.trim().slice(-500)}`;
    }
    if (['sh', 'bash'].includes(ext)) {
      const r = await run(`bash -n ${q} 2>&1`);
      return r.code === 0 ? null : `bash -n a signalé un problème :\n${r.out.trim().slice(-500)}`;
    }
  } catch (e) {
    return `Vérification impossible : ${e.message}`;
  }
  return null; // extension non reconnue : pas de vérification
}

// ddgr (recherche web sans clé API) ajouté à la liste des commandes de lecture, exécutées sans confirmation.
const BAD = /[;&|><`]|\$\(|-delete|-exec/;
const SAFE = /^(ls|cat|pwd|head|tail|grep|find|wc|echo|which|stat|file|du|df|tree|node --check|ddgr|git (status|log|diff))(\s|$)/;
export const isReadOnly = (cmd) =>
  cmd.trim().split('\n').every(l => SAFE.test(l.trim()) && !BAD.test(l));
