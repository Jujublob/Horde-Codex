import chalk from 'chalk';
import readline from 'readline';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

marked.use(markedTerminal());

export function banner(model, auto) {
  console.clear();
  const w = Math.min(process.stdout.columns || 60, 64);
  const bar = chalk.magenta.bold('━'.repeat(w));
  console.log(bar);
  console.log(chalk.white.bold(' ⌘ HORDE CODEX') + chalk.gray(' ⌬ agent terminal'));
  console.log(chalk.gray(' ⌥ Modèle  : ') + chalk.green(model.split('/').pop()));
  console.log(chalk.gray(' ⎔ Dossier : ') + chalk.blue(process.cwd()));
  console.log(chalk.gray(' ⏣ Auto    : ') + (auto ? chalk.red.bold('ON (sans confirmation)') : chalk.green('OFF (confirmation)')));
  console.log(chalk.gray(' ⟁ Tape /help pour les commandes'));
  console.log(bar);
}

export function spinner(label) {
  const f = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const t0 = Date.now();
  const timer = setInterval(() => {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    const s = Math.round((Date.now() - t0) / 1000);
    process.stdout.write(chalk.yellow(`${f[i++ % f.length]} ${label} ${s}s`));
  }, 100);
  return () => {
    clearInterval(timer);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
  };
}

export function printReply(reply) {
  console.log(chalk.green.bold('\n⚠ Assistant'));
  console.log(marked.parse(reply).trim());
}

export function help() {
  const l = (a, b) => console.log(chalk.yellow(a.padEnd(14)) + chalk.gray(b));
  console.log(chalk.bold('\n⌕ Commandes disponibles :'));
  l('/1 /2 /3 /4', 'Modèles favoris');
  l('/live', 'Modèles en ligne, puis /use <n>');
  l('/file <chemin>', 'Envoyer un fichier à l\'IA');
  l('/paste ... /end', 'Message multi-lignes');
  l('!<commande>', 'Lancer une commande (ex: !ls)');
  l('/cd <dossier>', 'Changer de dossier');
  l('/auto', 'Mode sans confirmation');
  l('/save', 'Sauvegarder la conversation');
  l('/clear /exit', 'Réinitialiser / quitter');
}
