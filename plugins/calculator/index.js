// Plugin Calculatrice pour OmniAgent
const expression = process.argv[2];

if (!expression) {
    console.error(JSON.stringify({ error: "Aucune expression fournie." }));
    process.exit(1);
}

try {
    // Sécurité basique : on ne permet que les chiffres et les opérateurs mathématiques
    if (/[^0-9\+\-\*\/\(\)\. ]/.test(expression)) {
        throw new Error("Caractères non autorisés dans l'expression.");
    }

    // Utilisation de Function au lieu de eval pour une isolation légère (encore risqué, mais c'est un exemple)
    const result = new Function(`return ${expression}`)();
    console.log(JSON.stringify({ result }));
} catch (err) {
    console.log(JSON.stringify({ error: err.message }));
}
