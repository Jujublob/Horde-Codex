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
