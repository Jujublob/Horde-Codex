import chalk from 'chalk';
import { API_URL, MODELS_URL, TIMEOUT_MS, TEMP_CODE, TEMP_CHAT } from './config.js';
import { getHordeKey, getProvider } from './settings.js';
import { parseRef } from './models.js';

// AI Horde : petits contextes (choix volontaire, pour que toutes les IA fonctionnent).
// Fournisseurs cloud (Gemini, ChatGPT, Claude...) : budgets plus larges.
const HORDE_LIMITS = { prompt: 2200, reply: 650 };
const CLOUD_LIMITS = { prompt: 16000, reply: 4096 };
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

function fitToTokenBudget(messages, maxPrompt) {
  if (!messages || !messages.length) return [];
  const sys = { ...messages[0] };
  const maxSys = Math.floor(maxPrompt * 0.6 * 3.2);
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
    const left = maxPrompt - used;
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

// Extrait un message lisible d'une réponse d'erreur (JSON ou texte)
function errText(text) {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message || j?.error || j?.message;
    if (m) return typeof m === 'string' ? m : JSON.stringify(m);
  } catch {}
  return text.slice(0, 300);
}

// Requête HTTP avec délai maximum et interruption (/stop)
async function http(url, { method = 'GET', headers = {}, body, signal, timeoutMs = TIMEOUT_MS, timeoutMsg } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const r = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) {
      const e = new Error(errText(text));
      e.status = r.status;
      throw e;
    }
    try { return JSON.parse(text); }
    catch { throw new Error('Réponse non JSON : ' + text.slice(0, 100)); }
  } catch (e) {
    if (e.name === 'AbortError') {
      // (e.message est en lecture seule sur une DOMException : on crée une nouvelle erreur)
      const err = new Error(signal?.aborted ? 'Interrompu' : (timeoutMsg || `Timeout (${timeoutMs / 1000}s)`));
      err.interrupted = !!signal?.aborted;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// POST avec adaptation automatique : certains modèles (OpenAI récents) refusent max_tokens ou temperature
async function postRetry(url, headers, body, signal) {
  for (let i = 0; ; i++) {
    try {
      return await http(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (e.status === 400 && i < 2) {
        if (/max_completion_tokens/i.test(e.message) && 'max_tokens' in body) {
          body.max_completion_tokens = body.max_tokens;
          delete body.max_tokens;
          continue;
        }
        if (/temperature/i.test(e.message) && 'temperature' in body) {
          delete body.temperature;
          continue;
        }
      }
      throw e;
    }
  }
}

async function openaiChat({ url, key, model, messages, limits, signal }) {
  const body = {
    model,
    messages: fitToTokenBudget(messages, limits.prompt),
    temperature: pickTemp(messages),
    max_tokens: limits.reply
  };
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const d = await postRetry(url, headers, body, signal);
  if (d.error) {
    throw new Error(`Erreur renvoyée par l'API : ${typeof d.error === 'string' ? d.error : d.error.message || JSON.stringify(d.error)}`);
  }
  if (!d.choices?.length) throw new Error("Réponse inattendue de l'API (aucun 'choices').");
  lastFinish = d.choices[0].finish_reason || null;
  return d.choices[0].message?.content || '';
}

// Claude exige : premier message "user", rôles qui alternent
function anthropicMessages(msgs) {
  const out = [];
  for (const m of msgs) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (!out.length && role !== 'user') continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n\n' + m.content;
    else out.push({ role, content: m.content });
  }
  return out;
}

async function anthropicChat({ base, key, model, messages, limits, signal }) {
  const fitted = fitToTokenBudget(messages, limits.prompt);
  const system = fitted[0]?.role === 'system' ? fitted[0].content : '';
  const body = {
    model,
    max_tokens: limits.reply,
    temperature: pickTemp(messages),
    messages: anthropicMessages(fitted.filter(m => m.role !== 'system'))
  };
  if (system) body.system = system;
  const headers = { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const d = await postRetry(base + '/messages', headers, body, signal);
  if (!Array.isArray(d.content)) throw new Error("Réponse inattendue de l'API (aucun 'content').");
  lastFinish = d.stop_reason === 'max_tokens' ? 'length' : (d.stop_reason || null);
  return d.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

const baseOf = (p) => p.baseUrl.replace(/\/+$/, '');
const unknownProvider = (id) => new Error(`Fournisseur inconnu : « ${id} ». /api pour la liste.`);

// ref : "nom" (AI Horde) ou "@fournisseur:nom" ; signal (optionnel) : permet à /stop d'interrompre
export async function chat(ref, messages, signal) {
  const { provider, model } = parseRef(ref);
  lastFinish = null;
  if (provider === 'horde') {
    return openaiChat({ url: API_URL, key: getHordeKey(), model, messages, limits: HORDE_LIMITS, signal });
  }
  const p = getProvider(provider);
  if (!p) throw unknownProvider(provider);
  return p.type === 'anthropic'
    ? anthropicChat({ base: baseOf(p), key: p.key, model, messages, limits: CLOUD_LIMITS, signal })
    : openaiChat({ url: baseOf(p) + '/chat/completions', key: p.key, model, messages, limits: CLOUD_LIMITS, signal });
}

// Liste les modèles d'un fournisseur (sert aussi de test de connexion)
export async function listModels(provider = 'horde') {
  const opts = { timeoutMs: MODELS_TIMEOUT_MS, timeoutMsg: `L'API ne répond pas (${MODELS_TIMEOUT_MS / 1000}s)` };
  if (provider === 'horde') {
    const d = await http(MODELS_URL, opts);
    return (d.data || []).map(m => m.id);
  }
  const p = getProvider(provider);
  if (!p) throw unknownProvider(provider);
  const anth = p.type === 'anthropic';
  const headers = anth
    ? { 'x-api-key': p.key, 'anthropic-version': '2023-06-01' }
    : (p.key ? { Authorization: `Bearer ${p.key}` } : {});
  const d = await http(baseOf(p) + '/models' + (anth ? '?limit=1000' : ''), { ...opts, headers });
  const arr = Array.isArray(d) ? d : (d.data || d.models || []);
  return arr
    .map(m => (typeof m === 'string' ? m : (m.id || m.name || '')))
    .filter(Boolean)
    .map(id => id.replace(/^models\//, ''))
    .sort();
}

export const liveModels = () => listModels('horde');
