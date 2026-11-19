import fs from 'fs';
import { fileURLToPath } from 'url';
import { getSearchKey } from './settings.js';

const TIMEOUT_MS = 15000;

export async function searchWeb(query) {
  const apiKey = getSearchKey();
  if (!apiKey) return "(recherche web non configurée : réponds sans, n'en redemande pas)";
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ query, max_results: 4 })
    });
    if (res.status === 401 || res.status === 403) return `Erreur Tavily (${res.status}) : clé invalide ? L'utilisateur peut la changer avec /apisearch.`;
    if (!res.ok) return `Erreur API Tavily (${res.status})`;
    const data = await res.json();
    return (data.results || [])
      .map(r => `- ${r.title} (${r.url}): ${r.content?.slice(0, 300)}`)
      .join('\n') || "Aucun résultat.";
  } catch (e) {
    return `Erreur recherche : ${e.message}`;
  }
}

// Utilisable aussi en terminal : node search_tool.js ma requête (jamais lancé à l'import)
const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain && process.argv[2]) {
  console.log(await searchWeb(process.argv.slice(2).join(' ')));
}
