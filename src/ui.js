import chalk from 'chalk';
import os from 'os';
import readline from 'readline';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { parseRef } from './models.js';

marked.use(markedTerminal());

const VIOLET = '#7c3aed';
const ANSI = /\x1b\[[0-9;]*m/g;
const vis = (s) => s.replace(ANSI, '').length;                       // longueur visible (sans couleurs)
const padVis = (s, n) => s + ' '.repeat(Math.max(0, n - vis(s)));
const clip = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…');
const clipLeft = (s, n) => (s.length <= n ? s : '…' + s.slice(s.length - Math.max(1, n - 1)));
const dim = (t) => chalk.hex('#64748b')(t);
const fit = (main, extra, width) => (vis(main) + vis(extra) <= width ? main + extra : main);

function gradient(text, from, to) {
  const rgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const a = rgb(from), b = rgb(to);
  const n = Math.max(1, text.length - 1);
  return [...text].map((ch, i) => {
    const t = i / n;
    return chalk.rgb(...a.map((v, k) => Math.round(v + (b[k] - v) * t)))(ch);
  }).join('');
}

export function banner(model, auto, opts = {}) {
  console.clear();
  const W = Math.max(30, Math.min(process.stdout.columns || 60, 64));
  const inner = W - 2;
  const body = inner - 2;
  const vw = body - 10;
  const bd = (s) => chalk.hex(VIOLET)(s);
  const row = (c = '') => bd('│') + ' ' + padVis(c, body) + ' ' + bd('│');
  const kv = (label, value) => row(chalk.hex('#94a3b8')(label.padEnd(10)) + value);

  const home = os.homedir();
  const cwd = process.cwd().startsWith(home) ? '~' + process.cwd().slice(home.length) : process.cwd();
  const title = gradient('◆ HORDE CODEX', '#c084fc', '#38bdf8');

  console.log(bd('╭' + '─'.repeat(inner) + '╮'));
  console.log(row(body >= 37 ? title + dim('  ·  ') + chalk.hex('#38bdf8')('Agent Terminal IA') : title));
  console.log(bd('├' + '─'.repeat(inner) + '┤'));
  const ref = parseRef(model);
  const mname = ref.model.split('/').pop();
  const tag = ref.provider === 'horde' ? '' : dim('  ' + ref.provider);
  console.log(kv('Modèle', fit(chalk.hex('#34d399').bold(clip(mname, vw - (tag ? vis(tag) : 0))), tag, vw)));
  console.log(kv('Dossier', chalk.hex('#60a5fa')(clipLeft(cwd, vw))));
  console.log(kv('Mode', auto
    ? fit(chalk.hex('#f87171').bold('● AUTO'), dim('  sans confirmation'), vw)
    : fit(chalk.hex('#34d399')('● Sécurisé'), dim('  confirmation demandée'), vw)));
  console.log(kv('Recherche', opts.search
    ? chalk.hex('#34d399')('● activée')
    : fit(dim('○ désactivée'), dim('  /apisearch <clé>'), vw)));
  console.log(kv('Aide', fit(chalk.hex('#fbbf24')('/help'), dim('  ·  ') + chalk.hex('#fbbf24')('/stop') + dim(' interrompt l’IA'), vw)));
  console.log(bd('╰' + '─'.repeat(inner) + '╯'));
}

export function spinner(label) {
  const f = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const t0 = Date.now();
  const timer = setInterval(() => {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    const secs = (Date.now() - t0) / 1000;
    const cols = process.stdout.columns || 60;
    const text = clip(secs > 20 ? `${label} · en attente de Horde (la file peut être longue)` : label, Math.max(10, cols - 16));
    process.stdout.write(
      chalk.hex('#c084fc')(` ${f[i++ % f.length]} `) + chalk.hex('#fbbf24')(text) + dim(` ${secs.toFixed(0)}s · /stop`)
    );
  }, 80);
  return () => {
    clearInterval(timer);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
  };
}

export function printReply(reply) {
  const w = Math.min(process.stdout.columns || 60, 72);
  const bar = chalk.hex('#334155')('─'.repeat(w));
  console.log('');
  console.log(chalk.hex('#c084fc')(' ✦ ') + chalk.hex('#38bdf8').bold('Assistant'));
  console.log(bar);
  console.log(marked.parse(reply).trim());
  console.log(bar + '\n');
}

export function help(favs = []) {
  const key = (t) => chalk.hex('#a78bfa').bold(t.padEnd(21));
  const desc = (t) => chalk.hex('#94a3b8')(t);
  const section = (t) => console.log('\n ' + chalk.hex('#c084fc').bold(t));
  const row = (k, d) => console.log(`  ${key(k)} ${desc(d)}`);
  const n = favs.length;

  section('Modèles');
  row(n > 1 ? `/1 … /${n}` : '/1', 'Passer à un modèle favori');
  row('/fav', 'Voir les favoris');
  row('/fav add [n°|nom]', 'Ajouter un favori (modèle actuel par défaut)');
  row('/fav del <n°>', 'Retirer un favori');
  row('/fav reset', 'Revenir aux favoris par défaut');
  row('/live', 'Modèles AI Horde en ligne, puis /use <n°>');
  row('/top', 'Le plus gros modèle en ligne');

  section('Fournisseurs IA (Gemini, ChatGPT, Claude, autres)');
  row('/api', 'Voir les fournisseurs et les clés');
  row('/api add', 'Ajouter un fournisseur (menu guidé)');
  row('/api add <id> <clé>', 'Ex : /api add gemini <clé>');
  row('/api del <id>', 'Retirer un fournisseur');
  row('/api test <id>', 'Tester la connexion');
  row('/live <id> [mots]', 'Chercher un modèle (ex : /live gemini flash)');
  row('/use <id> <modèle>', 'Utiliser un modèle précis');

  section('Contrôle de l’IA');
  row('/stop', 'Interrompre l’IA (même en mode auto)');
  row('/auto', 'Mode auto : activer / désactiver');
  row('Ctrl+C', 'Idem /stop ; 2 fois de suite = quitter');

  section('Fichiers et commandes');
  row('/file <chemin> [n°]', 'Envoyer un fichier (par parties si long)');
  row('/paste … /end', 'Saisie sur plusieurs lignes');
  row('!<cmd>', 'Lancer une commande (ex : !ls)');
  row('/cd <dossier>', 'Changer de dossier');

  section('Clés API (conservées entre les mises à jour)');
  row('/apihorde <clé>', 'Définir la clé AI Horde (off = retirer)');
  row('/apisearch <clé>', 'Définir la clé de recherche (off = retirer)');
  row('/apihorde', 'Voir l’état de la clé (sans argument)');

  section('Session');
  row('/save', 'Sauvegarder la conversation');
  row('/clear', 'Effacer l’écran et la conversation');
  row('/exit', 'Quitter');
  console.log('');
}
