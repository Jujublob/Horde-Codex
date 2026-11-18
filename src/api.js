import { API_URL, MODELS_URL, API_KEY, TIMEOUT_MS } from './config.js';

const MAX_PROMPT_TOKENS = 2200;
const MAX_REPLY_TOKENS = 650;

function fitToTokenBudget(messages) {
  if (!messages || !messages.length) return [];
  const sys = { ...messages[0] };
  const maxSys = Math.floor(MAX_PROMPT_TOKENS * 0.6 * 3.2);
  if (sys.content?.length > maxSys) sys.content = sys.content.slice(0, maxSys) + '\n...[tronqué]';

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
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model, messages: fitToTokenBudget(messages), temperature: 0.5, max_tokens: MAX_REPLY_TOKENS })
    });
    if (!r.ok) {
      const e = new Error((await r.text()).slice(0, 300));
      e.status = r.status;
      throw e;
    }
    const d = await r.json();
    return d.choices?.[0]?.message?.content || '';
  } catch (e) {
    if (e.name === 'AbortError') e.message = `Timeout (${TIMEOUT_MS / 1000}s)`;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function liveModels() {
  const r = await fetch(MODELS_URL);
  const d = await r.json();
  return (d.data || []).map(m => m.id);
}
