#!/usr/bin/env node
import { buildSystem } from './context.js';
import fs from 'fs';
import os from 'os';
import chalk from 'chalk';
import { FAVORITES, SYSTEM_PROMPT, MAX_FILE_CHARS } from './config.js';
import { banner, help } from './ui.js';
import { expand, run } from './exec.js';
import { S, rl, askAI, showModels, saveSession, loadSession, pickStrongest } from './agent.js';

let buffer = null;
const show = () => banner(S.model, S.auto);
const prompt = () => {
  const dir = process.cwd().split('/').pop() || '/';
  rl.setPrompt(chalk.cyan.bold(`\n${dir}${S.auto ? " [AUTO]" : ""} ❯ `));
  rl.prompt();
};
async function useModel(m) {
  S.model = m;
  show();
  console.log(chalk.green('✔ Modèle : ' + m));
  if (S.last) await askAI(S.last);
}

async function sendFile(arg) {
  const p = expand(arg.trim());
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    console.log(chalk.red('Fichier introuvable : ' + p));
    return;
  }
  let c = fs.readFileSync(p, 'utf-8');
  if (c.length > MAX_FILE_CHARS) {
    console.log(chalk.yellow(`⚠ Tronqué à ${MAX_FILE_CHARS} caractères.`));
    c = c.slice(0, MAX_FILE_CHARS);
  }
  await askAI(`Contenu de \`${p}\` :\n\n\`\`\`\n${c}\n\`\`\`\nAnalyse-le.`);
}

function save() {
  const f = `${os.homedir()}/horde-cli/historique-${Date.now()}.md`;
  fs.writeFileSync(f, S.messages.slice(1).map(m => `## ${m.role}\n\n${m.content}\n`).join('\n'));
  console.log(chalk.green('✔ Sauvegardé : ' + f));
}

async function command(input) {
  if (input === '/help') help();
  else if (input === '/clear') {
    S.messages = [{ role: 'system', content: buildSystem() }];
    S.pending = []; saveSession();
    S.last = null;
    show();
  }
  else if (input === '/live') await showModels(false);
  else if (/^\/[1-4]$/.test(input)) await useModel(FAVORITES[+input[1] - 1]);
  else if (input === "/5") await useModel(await pickStrongest());
  else if (input.startsWith('/use ')) {
    const m = S.models[parseInt(input.slice(5), 10) - 1];
    if (m) await useModel(m); else console.log(chalk.red('Numéro invalide.'));
  }
  else if (input === '/auto') { S.auto = !S.auto; show(); }
  else if (/^\d+$/.test(input)) {
    const m = S.models[+input - 1];
    if (m) await useModel(m); else console.log(chalk.red('Numéro invalide.'));
  }
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
  else await askAI(input);
}

show();
const restored = loadSession();
if (restored) console.log(chalk.green(`↺ Conversation reprise (${restored} messages). /clear pour repartir de zéro.`));
prompt();
rl.on('close', () => process.exit(0));

rl.on('line', async (raw) => {
  const input = raw.trim();
  if (buffer !== null) {
    if (input === '/end') {
      const t = buffer.join('\n');
      buffer = null;
      if (t) await askAI(t);
      prompt();
    } else buffer.push(raw);
    return;
  }
  if (!input) return prompt();
  if (input === '/exit') process.exit(0);
  if (input === '/paste') {
    buffer = [];
    console.log(chalk.gray('Colle ton texte, puis tape /end sur une ligne seule.'));
    return;
  }
  await command(input);
  prompt();
});
