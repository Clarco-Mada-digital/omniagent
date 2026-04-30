# Sprint 12 : Expansion & Outils (Plugins)

**Objectif** : Transformer OmniAgent d'un simple chat en un assistant capable d'agir sur le monde via un système de plugins (Function Calling / Tools).

## Tâches
- [x] **Task 12.1** : Définir l'architecture des plugins (Manifeste `plugin.json` et dossier `plugins/`).
- [x] **Task 12.2** : Implémenter une commande Tauri `execute_plugin_tool` sécurisée en Rust.
- [x] **Task 12.3** : Système de détection automatique des outils par les agents (Function Calling / ReAct loop).
- [x] **Task 12.4** : Implémenter deux plugins de démonstration : 
    - [x] 🧮 **Plugin Calculatrice** (Interprétation d'expressions mathématiques).
    - [x] 🌐 **Plugin Web Search** (Recherche via Brave Search ou DuckDuckGo API - Version démo).
- [ ] **Task 12.5** : UI de gestion des plugins (Activer/Désactiver).

## Statut
- **Terminé** : Le système de plugins est opérationnel ! 🚀
- **Note** : Les agents peuvent désormais appeler des outils externes en utilisant la syntaxe `[[tool:id/name?{args}]]`.
