# Analyse Complète du Projet - OmniAgent (Mise à jour le 02/06/2026)

## 1. Objectifs Stratégiques
OmniAgent se positionne comme un assistant IA "Privacy-First" et "Multi-Source".
- **Accessibilité locale** : Utilisation prioritaire d'Ollama pour garantir la confidentialité des données.
- **Polyvalence Cloud** : Accès aux meilleurs modèles du marché (GPT-4o, Claude 3.5, Gemini 1.5) via une interface unifiée.
- **Productivité augmentée** : Agents spécialisés, RAG local, analyse d'images et génération d'art.
- **Extensibilité** : Système de plugins permettant d'ajouter des capacités de recherche web, calcul, etc.

## 2. Périmètre du Projet
### Périmètre Fonctionnel
- Chat intelligent avec streaming.
- Gestion d'agents (prompts système isolés).
- Recherche augmentée par récupération (RAG) sur fichiers locaux.
- Analyse d'images (Vision) et génération d'images (DALL-E).
- Dictée vocale et raccourcis clavier.
- Système de plugins (WebSearch, Calculator).
- Historique persistant par agent.

### Périmètre Technique
- **Frontend** : Vanilla JS, HTML, CSS (Glassmorphism).
- **Backend** : Rust (Tauri v2).
- **IA** : Ollama (Local), OpenAI, Anthropic, Gemini, OpenRouter.
- **Stockage** : JSON local (config, historique, agents).

## 3. Parties Prenantes
- **Product Manager (Moi)** : Vision, backlog, priorisation.
- **Développeur (Moi/IA)** : Implémentation Rust/JS.
- **Utilisateurs Finaux** : Développeurs, rédacteurs, analystes cherchant une interface IA unifiée.

## 4. Analyse des Risques
| Risque | Impact | Mitigations |
|---|---|---|
| **Sécurité des clés API** | Critique | Migration prévue vers OS Keychain (US-03). |
| **Bugs de Concurrence** | Majeur | Stabilisation des streams et blocage des actions concurrentes (US-01). |
| **Obsolescence API Cloud** | Moyen | Abstraction via Rust `reqwest` et support multi-fournisseurs. |
| **Performance RAG** | Moyen | Migration vers une base vectorielle (US-05) pour de gros volumes. |

## 5. Délais et Planification
- **Phase Actuelle** : Sprint 1 (Stabilité & Correctifs).
- **Échéance Sprint 1** : 16 Juin 2026.
- **Objectif Prochain** : Sécurité (Keychain) et Intégration Plugins.

## 6. Points en Suspens & Améliorations
- [ ] Finaliser l'intégration réelle du plugin WebSearch (actuellement mocké).
- [ ] Améliorer la gestion des erreurs réseau (US-06).
- [ ] Implémenter le multi-threading (plusieurs conversations par agent).
- [ ] Chiffrement des données sensibles.
