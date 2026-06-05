# Sprint Backlog - Sprint 1 (Stabilité & Correctifs)

**Période** : 02 Juin 2026 - 16 Juin 2026
**Objectif** : Stabiliser l'application en corrigeant les bugs de duplication et en améliorant la gestion des erreurs.

## Tableau de Bord Scrum

| À faire | En cours | En revue | Terminé |
|---|---|---|---|
| | | | US-01 : Bug duplication messages |
| | | | US-07 : Indicateur visuel chargement |
| | | | US-06 : Gestion erreurs réseau |

## Détails des Tâches du Sprint

### [US-01] Bug duplication messages (Priorité : Bloquant)
- Analyse de la racine du problème (Overlapping listeners & Global state)
- Implémentation d'un arrêt de génération lors du changement d'agent
- Isolation de l'élément de message par stream
- Test de validation

### [US-06] Gestion robuste des erreurs (Priorité : Majeure)
- Catch des erreurs de timeout et de clés invalides
- Notification utilisateur via toast ou message AI

### [US-07] Indicateur visuel (Priorité : Mineure)
- Ajout d'une barre de progression ou spinner lors de l'appel initial

## Suivi des Risques & Bloqueurs
- **Risque** : Changement d'API chez les fournisseurs cloud (OpenRouter/Gemini).
- **Bloqueur** : Aucun pour le moment.
