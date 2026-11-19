import chalk from 'chalk';
import { API_URL, MODELS_URL, API_KEY, TIMEOUT_MS, TEMP_CODE, TEMP_CHAT } from './config.js';

const MAX_PROMPT_TOKENS = 2200;
const MAX_REPLY_TOKENS = 650;
const MODELS_TIMEOUT_MS = 20000;

let warnedTrunc = false;
let lastFinish = null;
export const getFinishReason = () => lastFinish;

// Température basse quand l'IA travaille sur du code, fichiers ou commandes
const CODE_HINT = /```|\.(js|sh|json|py|md|txt)\b|fichier|code|commande|Commande exécutée|Résultats ci-dessus/i;
function pickTemp(messages) {
  const last = [...messages].reverse().find(m => m.role === 'user');
  return CODE_HINT.test(last?.content || '') ? TEMP_CODE : TEMP_CHAT;
}

function fitToTokenBudget(messages) {
  if (!messages || !messages.length) return [];
  const sys = { ...messages[0] };
  const maxSys = Math.floor(MAX_PROMPT_TOKENS * 0.6 * 3.2);
  if (sys.content?.length > maxSys) {
    sys.content = sys.content.slice(0, maxSys) + '\n...[tronqué]';
    if (!warnedTrunc) {
      warnedTrunc = true;
      console.log(chalk.yellow('⚠ Prompt système tronqué : il dépasse le budget de tokens, la fin est ignorée.'));
    }
  }

  let used = Math.ceil((sys.content || '').length / 3.2);
  const kept = [];
  for (let i = messages.length - 1; i >= 1; i--) {
    const m = { ...messages[i] };
    const left = MAX_PROMPT_TOKENS - used;
    if (left <= 80) break;
    const maxC = Math.floor(left * 3.2);
    if (m.content?.length > maxC) {
      const h = Math.floor(maxC / 2) - 20;
      m.content = m.content.slice(0, h) + '\n...[coupé]...\n' + m.content.slice(-h);
    }
    used += Math.ceil((m.content || '').length / 3.2);
    kept.unshift(m);
  }
  return [sys, ...kept];
}

export async function chat(model, messages) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  lastFinish = null;
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model,
        messages: fitToTokenBudget(messages),
        temperature: pickTemp(messages),
        max_tokens: MAX_REPLY_TOKENS
      })
    });
    if (!r.ok) {
      const e = new Error((await r.text()).slice(0, 300));
      e.status = r.status;
      throw e;
    }
    const d = await r.json();
    if (d.error) {
      throw new Error(`Erreur renvoyée par l'API : ${typeof d.error === 'string' ? d.error : d.error.message || JSON.stringify(d.error)}`);
    }
    if (!d.choices?.length) throw new Error("Réponse inattendue de l'API (aucun 'choices').");
    lastFinish = d.choices[0].finish_reason || null;
    return d.choices[0].message?.content || '';
  } catch (e) {
    if (e.name === 'AbortError') e.message = `Timeout (${TIMEOUT_MS / 1000}s)`;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function liveModels() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODELS_TIMEOUT_MS);
  try {
    const r = await fetch(MODELS_URL, { signal: ctrl.signal });
    if (!r.ok) {
      const e = new Error(`Liste des modèles indisponible (HTTP ${r.status})`);
      e.status = r.status;
      throw e;
    }
    const d = await r.json();
    return (d.data || []).map(m => m.id);
  } catch (e) {
    if (e.name === 'AbortError') e.message = `L'API ne répond pas (${MODELS_TIMEOUT_MS / 1000}s)`;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
