# Product Backlog - OmniAgent

**Rôle : Product Manager**

## User Stories & Tâches Techniques

| ID | Type | Description | Priorité | Est. (SP) | Statut |
|---|---|---|---|---|---|
| US-01 | Bug | Correction de la duplication des messages lors du changement d'agent pendant un stream | Bloquant | 3 | Terminé |
| US-02 | Feature | Système de conversations multiples par agent (Threads) | Haute | 8 | À faire |
| US-03 | Sécurité | Chiffrement des clés API via le trousseau d'accès système (Keychain) | Haute | 5 | À faire |
| US-04 | Feature | Recherche Web (Plugin search) - Intégration complète (Réelle API) | Haute | 5 | À faire |
| US-05 | Perf | Migration vers une base vectorielle locale simple (ex: LanceDB ou faiss-rs) pour le RAG | Moyenne | 13 | À faire |
| US-06 | Bug | Gestion robuste des erreurs réseau et fallback automatique vers Ollama | Majeure | 3 | Terminé |
| US-07 | UX | Ajout d'un indicateur visuel de chargement global et état de connexion | Mineure | 2 | Terminé |
| US-08 | Feature | Support de modèles de vision locaux (Llava) via Ollama | Majeure | 5 | À faire |
| US-09 | Feature | Exportation PDF/Markdown enrichie de l'historique complet | Moyenne | 3 | À faire |

## Roadmap Stratégique 2026

### Sprint 1 : Stabilité & Fiabilité (En cours - Échéance : 16/06)
- **Objectif** : Zéro bug de duplication et gestion d'erreur exemplaire.
- **Livrables** : Version 1.5.1 stable.

### Sprint 2 : Sécurité & Web (Échéance : 30/06)
- **Objectif** : Sécuriser les secrets utilisateurs et ouvrir l'IA sur le web.
- **Livrables** : Intégration Keychain (Rust) + Plugin WebSearch fonctionnel (Brave Search ou Google).

### Sprint 3 : Intelligence Contextuelle (Échéance : 15/07)
- **Objectif** : Multi-conversations et RAG haute performance.
- **Livrables** : UI Multi-threads + Backend Vector DB.
