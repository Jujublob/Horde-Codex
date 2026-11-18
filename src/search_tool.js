export async function searchWeb(query) {
  const apiKey = process.env.SEARCH_API_KEY;
  if (!apiKey) return "Erreur : SEARCH_API_KEY non définie.";
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ api_key: apiKey, query, max_results: 4 })
    });
    if (!res.ok) return `Erreur API Tavily (${res.status})`;
    const data = await res.json();
    return (data.results || [])
      .map(r => `- ${r.title} (${r.url}): ${r.content?.slice(0, 300)}`)
      .join('\n') || "Aucun résultat.";
  } catch (e) {
    return `Erreur recherche : ${e.message}`;
  }
}

if (process.argv[2]) {
  console.log(await searchWeb(process.argv.slice(2).join(' ')));
}
