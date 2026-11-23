// Fournisseurs IA et références de modèles.
// Une "référence" désigne un modèle : "nom" seul = AI Horde ; "@fournisseur:nom" = autre fournisseur.
export const HORDE = 'horde';

// Fournisseurs prêts à l'emploi (type "openai" = API compatible OpenAI ; "anthropic" = API Claude)
export const PRESETS = {
  gemini:     { name: 'Gemini (Google)',    type: 'openai',    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  openai:     { name: 'ChatGPT (OpenAI)',   type: 'openai',    baseUrl: 'https://api.openai.com/v1' },
  claude:     { name: 'Claude (Anthropic)', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  openrouter: { name: 'OpenRouter',         type: 'openai',    baseUrl: 'https://openrouter.ai/api/v1' },
  groq:       { name: 'Groq',               type: 'openai',    baseUrl: 'https://api.groq.com/openai/v1' },
  mistral:    { name: 'Mistral',            type: 'openai',    baseUrl: 'https://api.mistral.ai/v1' },
  deepseek:   { name: 'DeepSeek',           type: 'openai',    baseUrl: 'https://api.deepseek.com/v1' },
  together:   { name: 'Together AI',        type: 'openai',    baseUrl: 'https://api.together.xyz/v1' }
};
export const PRESET_ALIASES = { chatgpt: 'openai', gpt: 'openai', anthropic: 'claude', google: 'gemini' };

export const makeRef = (provider, model) => (provider === HORDE ? model : `@${provider}:${model}`);

export function parseRef(ref) {
  const m = /^@([a-z0-9_-]+):(.+)$/.exec(ref || '');
  return m ? { provider: m[1], model: m[2] } : { provider: HORDE, model: ref || '' };
}

export const shortName = (ref) => parseRef(ref).model.split('/').pop();

// Budgets par défaut des fournisseurs "cloud" (gros contextes), utilisés notamment pour la
// taille des parties envoyées par /file. AI Horde reste volontairement petit (voir api.js).
export const DEFAULT_CLOUD_LIMITS = { prompt: 16000, reply: 4096 };

// Icône et couleur affichées devant un modèle selon son fournisseur (bandeau, listes, favoris).
export function iconFor(ref) {
  const { provider, model } = parseRef(ref);
  if (provider !== HORDE) {
    if (provider === 'gemini') return { sym: '✦', color: '#38bdf8' };
    if (provider === 'openai') return { sym: '❋', color: '#34d399' };
    if (provider === 'claude') return { sym: '✳', color: '#f59e0b' };
    return { sym: '◆', color: '#a78bfa' }; // autres fournisseurs configurés
  }
  const m = (model || '').toLowerCase();
  if (m.includes('qwen')) return { sym: '❖', color: '#34d399' };
  if (m.includes('mistral')) return { sym: '™', color: '#fb923c' };
  if (m.includes('llama')) return { sym: 'λ', color: '#60a5fa' };
  if (m.includes('gemma')) return { sym: '◉', color: '#fbbf24' };
  return { sym: '⬡', color: '#94a3b8' }; // AI Horde, modèle non reconnu
}
