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

export function writeFile(p, code) {
  const full = expand(p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  let bak = false;
  if (fs.existsSync(full)) { fs.copyFileSync(full, full + '.bak'); bak = true; }
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
    const timer = setTimeout(() => killTree(p), 120000);
    const done = (r) => { clearTimeout(timer); if (current === p) current = null; resolve(r); };
    p.on('close', (code, sig) => done({ code: code ?? (sig ? `interrompu (${sig})` : -1), out: out.slice(-2500) }));
    p.on('error', (e) => done({ code: -1, out: e.message }));
  });
}

const BAD = /[;&|><`]|\$\(|-delete|-exec/;
const SAFE = /^(ls|cat|pwd|head|tail|grep|find|wc|echo|which|stat|file|du|df|tree|node --check|git (status|log|diff))(\s|$)/;
export const isReadOnly = (cmd) =>
  cmd.trim().split('\n').every(l => SAFE.test(l.trim()) && !BAD.test(l));
