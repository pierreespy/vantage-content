# CCR routine playbook — notification du matin (tourne DANS `vantage-content`)

Fichier de routine lu par la session **Claude Code Remote** « Push 7h30 ». Elle envoie
**UNE** notification par jour, sur **la une** du jour, à tous les appareils inscrits.

C'est un job **entièrement déterministe** : pas de recherche web, pas de rédaction. Le texte
a déjà été écrit la nuit par la routine « Journal » dans `edition.json` (champ `pushTeaser`).
Cette routine ne fait que **lire les tokens et envoyer**. Elle ne publie rien par git.

## Quand la programmer

**Tous les jours à 07 h 30 (Europe/Paris)** — c'est-à-dire APRÈS la routine « Journal » de la
nuit (~2 h), pour que `edition.json` du jour soit déjà publié avec son `pushTeaser`.

## Prérequis (secret)

| Nom | Rôle |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | clé service-account Firebase en **chaîne JSON** (le contenu du fichier, pas un chemin). Sert à lire la collection `pushTokens`. |

Même secret que la routine Favoris. S'il manque, dis-le clairement et ARRÊTE-toi.

## Étapes

```bash
cd backend/routine
npm ci                 # installe firebase-admin (déjà listé)
node ccr-push.mjs      # lit ../../edition.json + les tokens, envoie via Expo Push
```

`ccr-push.mjs` :
1. lit `edition.json` à la racine du dépôt ; **si pas de `pushTeaser`, il n'envoie rien et
   s'arrête proprement** (aucune notification ce jour-là) ;
2. lit tous les tokens Expo dans Firestore `pushTokens/<uid>` (Admin SDK) ;
3. envoie UNE notification `{title, body}` = le `pushTeaser` du jour (par lots de 100) ;
4. purge les tokens morts (`DeviceNotRegistered` — app désinstallée / notifs coupées).

Tout passe sur **stderr** (logs) ; il n'y a pas de sortie machine à capturer, et **rien à
committer** : cette routine ne modifie aucun fichier du dépôt.

## Récap en une passe

```bash
cd backend/routine && npm ci && node ccr-push.mjs
```

Termine par un récap court : nombre de tokens, notifications acceptées par Expo, tokens purgés
(ou la raison si rien n'a été envoyé — p. ex. « pas de pushTeaser dans edition.json »).
