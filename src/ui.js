import chalk from 'chalk';
import readline from 'readline';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

marked.use(markedTerminal());

export function banner(model, auto) {
  console.clear();
  const w = Math.min(process.stdout.columns || 60, 68);
  const topBar = chalk.hex('#7c3aed')('╭' + '─'.repeat(w - 2) + '╮');
  const midBar = chalk.hex('#7c3aed')('├' + '─'.repeat(w - 2) + '┤');
  const botBar = chalk.hex('#7c3aed')('╰' + '─'.repeat(w - 2) + '╰');
  const vLine  = chalk.hex('#7c3aed')('│');

  console.log(topBar);
  console.log(`${vLine} ${chalk.hex('#c084fc').bold('⚡ HORDE CODEX')} ${chalk.hex('#64748b')('•')} ${chalk.hex('#38bdf8')('Agent Terminal IA')} ${' '.repeat(Math.max(0, w - 34))}${vLine}`);
  console.log(midBar);
  
  const shortModel = model.split('/').pop();
  console.log(`${vLine} ${chalk.hex('#94a3b8')('✦ Modèle  :')} ${chalk.hex('#34d399').bold(shortModel.padEnd(w - 15))}${vLine}`);
  console.log(`${vLine} ${chalk.hex('#94a3b8')('✦ Dossier :')} ${chalk.hex('#60a5fa')(process.cwd().padEnd(w - 15))}${vLine}`);
  
  const autoStatus = auto ? chalk.hex('#f87171').bold('ON (Sans confirmation)') : chalk.hex('#34d399')('OFF (Sécurisé)');
  console.log(`${vLine} ${chalk.hex('#94a3b8')('✦ Auto    :')} ${autoStatus.padEnd(w - 35)}${vLine}`);
  console.log(`${vLine} ${chalk.hex('#94a3b8')('✦ Aide    :')} ${chalk.hex('#fbbf24')('Tape /help pour afficher les commandes').padEnd(w - 16)}${vLine}`);
  
  console.log(botBar);
}

export function spinner(label) {
  const f = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
  let i = 0;
  const t0 = Date.now();
  const timer = setInterval(() => {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(chalk.hex('#fbbf24')(` ${f[i++ % f.length]} ${label} `) + chalk.hex('#64748b')(`[${s}s]`));
  }, 80);
  return () => {
    clearInterval(timer);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
  };
}

export function printReply(reply) {
  const line = chalk.hex('#334155')('─'.repeat(Math.min(process.stdout.columns || 60, 68)));
  console.log(`\n${line}`);
  console.log(chalk.hex('#38bdf8').bold(' ✨ Assistant'));
  console.log(line);
  console.log(marked.parse(reply).trim());
  console.log(`${line}\n`);
}

export function help() {
  const cKey = (txt) => chalk.hex('#a78bfa').bold(txt.padEnd(16));
  const cDesc = (txt) => chalk.hex('#94a3b8')(txt);
  
  console.log(chalk.hex('#c084fc').bold('\n 🛠️  Commandes disponibles :\n'));
  console.log(`  ${cKey('/1 /2 /3 /4')} ${cDesc('Bascule rapide vers les modèles favoris')}`);
  console.log(`  ${cKey('/live')}       ${cDesc('Liste les modèles en ligne, puis /use <n>')}`);
  console.log(`  ${cKey('/file <path>')}  ${cDesc('Envoyer un fichier à l’IA')}`);
  console.log(`  ${cKey('/paste.../end')} ${cDesc('Mode de saisie multi-lignes')}`);
  console.log(`  ${cKey('!<cmd>')}      ${cDesc('Exécuter une commande système (ex: !ls)')}`);
  console.log(`  ${cKey('/cd <dir>')}     ${cDesc('Changer de répertoire de travail')}`);
  console.log(`  ${cKey('/auto')}       ${cDesc('Activer / Désactiver le mode auto')}`);
  console.log(`  ${cKey('/save')}       ${cDesc('Sauvegarder l’historique de discussion')}`);
  console.log(`  ${cKey('/clear')}      ${cDesc('Nettoyer l’écran et réinitialiser')}`);
  console.log(`  ${cKey('/exit')}       ${cDesc('Quitter proprement l’application\n')}`);
}
