# 🚀 OmniAgent

**OmniAgent** est un assistant IA de bureau (Desktop) ultra-performant, polyvalent et personnalisable, construit avec **Tauri, Rust et Vanilla JavaScript**. Il combine la puissance de l'IA locale (via Ollama) et des services Cloud (OpenAI, Gemini, Anthropic, OpenRouter) dans une interface élégante et intuitive.

![OmniAgent Banner](https://img.shields.io/badge/OmniAgent-Expert_AI_Assistant-8b5cf6?style=for-the-badge&logo=ai)
![Version](https://img.shields.io/badge/version-1.5.0-blue?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)

---

## ✨ Fonctionnalités Clés

### 🧠 Intelligence Hybride
- **Local First** : Intégration native avec **Ollama** pour une confidentialité totale.
- **Cloud Ready** : Support de **GPT-4o**, **Claude 3.5**, **Gemini 1.5 Pro** et bien d'autres via des clés API.
- **Routage Intelligent** : Basculez entre les modèles en un clic selon vos besoins.

### 📚 Recherche Locale (RAG)
- **Base de Connaissance** : Indexez vos dossiers locaux. L'IA peut lire et analyser vos fichiers (`.txt`, `.md`, `.js`, `.py`, etc.) pour répondre à vos questions complexes.
- **Contexte Intelligent** : Filtrage automatique des fichiers les plus pertinents pour économiser les tokens.

### 🎨 Art & Vision
- **Artiste Digital** : Génération d'images via **DALL-E 3** avec gestion des formats (Paysage, Portrait) et styles.
- **Galerie Intégrée** : Sauvegarde automatique de vos créations en local avec un navigateur de galerie fluide.
- **Analyse d'Images** : Support des modèles de vision (Llava, GPT-4o Vision) pour analyser vos captures d'écran et photos.

### ⚡ UX Premium
- **10+ Agents Spécialisés** : Codeur, Traducteur, Analyste, Chef Cuisinier, Assistant Juridique...
- **Productivité** : Dictée vocale, raccourcis clavier (Ctrl+Enter, Ctrl+K), exportation Markdown/TXT.
- **Design Système** : Interface moderne avec Glassmorphism, mode sombre natif et animations fluides.

---

## 🛠️ Installation

### Prérequis
- [Node.js](https://nodejs.org/) (v18+)
- [Rust & Cargo](https://rustup.rs/)
- [Ollama](https://ollama.com/) (optionnel, pour l'IA locale)

### Configuration
1. Clonez le dépôt :
   ```bash
   git clone https://github.com/votre-username/OmniAgent.git
   cd OmniAgent
   ```
2. Installez les dépendances :
   ```bash
   npm install
   ```
3. Lancez l'application en mode développement :
   ```bash
   npm run tauri dev
   ```

---

## 📂 Structure du Projet

- `src/` : Interface utilisateur (HTML/JS/CSS).
- `src-tauri/` : Backend performant en Rust (Gestion des API, Système de fichiers, Streaming).
- `docs/` : Documentation de gestion de projet (Backlog, Sprints).

---

## 📜 Licence

Distribué sous la licence MIT. Voir `LICENSE` pour plus d'informations.

---

## 🤝 Contribution

Les contributions sont les bienvenues ! 
1. Forkez le projet.
2. Créez votre branche (`git checkout -b feature/AmazingFeature`).
3. Commitillez vos changements (`git commit -m 'Add some AmazingFeature'`).
4. Pushez sur la branche (`git push origin feature/AmazingFeature`).
5. Ouvrez une Pull Request.

---

*Développé avec ❤️ par l'équipe OmniAgent.*
