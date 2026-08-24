// Plugin WebSearch pour OmniAgent — recherche réelle via DuckDuckGo
const query = process.argv[2];

if (!query) {
    console.error(JSON.stringify({ error: "Aucune requête fournie." }));
    process.exit(1);
}

// API Instant Answer de DuckDuckGo : gratuite, sans clé, résultats JSON
const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

const timeout = setTimeout(() => {
    console.log(JSON.stringify({ results: [], note: "Timeout de la recherche." }));
    process.exit(0);
}, 10000);

fetch(url)
    .then(res => res.json())
    .then(data => {
        clearTimeout(timeout);
        const results = [];

        // Réponse directe (Abstract) — la plus pertinente
        if (data.AbstractText) {
            results.push({
                title: data.Heading || query,
                snippet: data.AbstractText,
                url: data.AbstractURL || ""
            });
        }

        // Topics connexes
        const addTopics = (topics) => {
            for (const t of topics || []) {
                if (results.length >= 5) return;
                if (t.Topics) { addTopics(t.Topics); continue; }
                if (t.Text) {
                    results.push({ title: t.Text.slice(0, 80), snippet: t.Text, url: t.FirstURL || "" });
                }
            }
        };
        addTopics(data.RelatedTopics);

        if (results.length === 0) {
            results.push({
                title: `Recherche : ${query}`,
                snippet: "Pas de résultat direct trouvé sur DuckDuckGo pour cette requête.",
                url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
            });
        }

        console.log(JSON.stringify({ results }));
    })
    .catch(err => {
        clearTimeout(timeout);
        console.log(JSON.stringify({ results: [], error: `Erreur recherche: ${err.message}` }));
    });
