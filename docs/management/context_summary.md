# Résumé de Contexte - OmniAgent

## État Actuel du Projet
- **Framework** : Tauri v2 (Rust) + Vanilla JS/CSS.
- **IA** : Ollama (local, streaming) + OpenAI cloud (fallback automatique, streaming).
- **Modularité** : Agents dans `src/agents.js`, config persistante dans `config.json`.
- **UI** : Sidebar iconique, glassmorphism v2, panneau paramètres animé, badge cloud.
- **Persistance** : Historique par agent (`history.json`), config (`config.json`) via Tauri `app_data_dir`.
- **Localisation** : `~/Bureau/OmniAgent`.

## Architecture
| Fichier | Rôle |
|---|---|
| `src-tauri/src/lib.rs` | `ask_ollama_stream`, `ask_cloud_stream`, `check_ollama`, `save/load_history`, `save/load_config` |
| `src/main.js` | Logique principale : agents, streaming, routage local/cloud, historique, settings |
| `src/agents.js` | Configuration modulaire des agents (writer, coder, social, research) |
| `src/styles.css` | Design système complet — glassmorphism, typing indicator, settings overlay |
| `src/index.html` | Structure UI : sidebar, chat, settings panel |
| `docs/management/` | Gestion Agile (Product Backlog, Sprint Backlog, Context Summary) |

## Sprints Terminés
- ✅ Sprint 1 : Fondations (Tauri + Ollama + UI de base).
- ✅ Sprint 2 : Streaming + Modularisation + Animations.
- ✅ Sprint 3 : Persistance de l'historique (Rust JSON + bouton Effacer).
- ✅ Sprint 4 : Intégration Cloud (OpenAI streaming) + Panneau Paramètres.
- ✅ Sprint 5 : Export des conversations + 10 agents spécialisés.
- ✅ Sprint 6 : Rendu Markdown riche (Code highlighting, tables, listes).
- ✅ Sprint 7 : Support des fichiers (Analyse de documents texte/code).
- ✅ Sprint 8 : UX Avancée (Dictée vocale, Raccourcis clavier Ctrl+K/E/,).
- ✅ Sprint 9 : Analyse d'images (Support des modèles Vision d'Ollama et OpenAI).

## Prochaine Action Immédiate
- **Sprint 11** : Génération d'Images & Galerie. 🔄 En cours.
- **Sprint 10** : Recherche Locale (RAG). ✅ Terminé.

## Nouvelles Sources IA
- **Ollama** : Local, 100% privé.
- **OpenAI** : GPT-4o, DALL-E 3.
- **Gemini** : Google 1.5 Flash.
- **OpenRouter** : Accès multi-modèles.
- **Anthropic** : Claude 3.5 Sonnet.

## Instruction de Reprise pour un Agent IA
> "Lis d'abord `docs/management/context_summary.md`, puis `sprint_backlog.md` et `product_backlog.md`. Agis comme Scrum Master et propose la prochaine tâche du Sprint 10."
