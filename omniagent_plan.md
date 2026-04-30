# OmniAgent : Application Desktop Multi-Agents (Rust + Tauri)

## Vision du Projet
Créer une application desktop puissante, légère et esthétique permettant d'accéder à des agents IA spécialisés par domaine (Code, Rédaction, Community Management, etc.). L'application utilise intelligemment **Ollama** pour le local et des APIs pour le Cloud, en choisissant le meilleur modèle pour chaque tâche.

## Stack Technique
- **Backend** : Rust avec [Tauri](https://tauri.app/) (Performance et Sécurité).
- **Frontend** : Javascript / Vite / Vanilla CSS (Léger et ultra-personnalisable).
- **IA** : Ollama (Local API) + Reqwest (Rust) pour les appels Cloud.
- **Design** : Modern UI, Glassmorphism, Micro-animations.

---

## Plan Agile (Scrum)

### Sprint 1 : Fondations & Connectivité (En cours)
- [ ] Initialisation du projet Tauri dans `~/Bureau/OmniAgent`.
- [ ] Configuration du backend Rust pour communiquer avec Ollama (localhost:11434).
- [ ] Création de la structure de base du frontend (Sidebar, Chat Area).
- [ ] Mise en place du système de design (Variables CSS, Thème Dark Premium).

### Sprint 2 : Cerveau Multi-Agents
- [ ] Définition des profils d'agents (System Prompts spécialisés).
- [ ] Implémentation du sélecteur de domaine/modèle.
- [ ] Gestion des contextes de conversation par agent.
- [ ] Routage intelligent : Local (Ollama) vs Cloud selon le domaine.

### Sprint 3 : Expérience Utilisateur (UX) "Wow"
- [ ] Intégration d'animations fluides pour les transitions d'agents.
- [ ] Rendu Markdown riche pour le code et le texte.
- [ ] Effets de Glassmorphism et flous directionnels.
- [ ] Feedback visuel du statut de génération (Streaming).

### Sprint 4 : Fonctionnalités Avancées & Finalisation
- [ ] Intégration optionnelle d'APIs Cloud (OpenAI/Anthropic).
- [ ] Système d'historique local persistant.
- [ ] Exportation des résultats (Email, Markdown, Code).
- [ ] Optimisation des performances et de la taille du binaire.

---

## Architecture des Agents
Chaque domaine sera géré par un "Agent" défini par :
1. **Identité** : Nom, Icône, Couleur thématique.
2. **Expertise** : System Prompt optimisé.
3. **Modèle suggéré** : ex: `codellama` pour le code, `llama3` pour le texte.
4. **Outils** : Actions spécifiques au domaine.

---

## Prochaines Étapes Immédiates
1. Créer le dossier sur le Bureau.
2. Initialiser Tauri avec Vite.
3. Tester la connexion avec Ollama.
