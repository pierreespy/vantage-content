# CCR routine playbook — Vantage favorites news (tourne DANS `vantage-content`)

Fichier de routine lu par la session **Claude Code Remote** « Favoris ». Elle tourne
**dans ce dépôt (`vantage-content`)**, fait la recherche web avec sa **propre recherche
native** (pas de clé API Anthropic), et publie `startup-news.json` par **git** (pas d'outil
GitHub, pas de PAT — le fichier est déjà dans le checkout).

Deux bornes Node déterministes font le travail hors-recherche :
`ccr-union.mjs` (lire qui suivre, depuis Firestore) et `ccr-merge.mjs` (fusion + rétention).

> Contrat de rétention (inchangé, garanti par `merge.mjs`) :
> **≤ 3 articles par startup, chacun ≤ 30 jours, une affaire = un article.**

## Prérequis (secret)

| Nom | Rôle |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | clé service-account Firebase en **chaîne JSON** (tout le contenu du fichier, pas un chemin). Sert uniquement à lire l'union. |

C'est le **seul** secret. La publication passe par git dans ce dépôt — **pas** de token GitHub.
Si `FIREBASE_SERVICE_ACCOUNT` manque, dis-le clairement et ARRÊTE-toi — ne fabrique rien, ne publie rien.

## Étape 0 — installer les dépendances

```bash
cd backend/routine
npm ci
```

## Étape 1 — lire l'union (qui rechercher)

```bash
node ccr-union.mjs > union.json    # logs sur stderr ; seul le JSON va sur stdout
```

`union.json` = `{"startups":["Abivax","Owkin",...]}` : les startups **réellement suivies**
(dédupliquées, non expirées). `ccr-union.mjs` purge aussi les docs expirés côté serveur
(best-effort). Si la liste est vide, il n'y a rien à faire — arrête-toi ici.

## Étape 2 — le fichier publié actuel (déjà dans le checkout)

Le fichier courant est **déjà là**, à la racine du dépôt : `startup-news.json`.
Pas de fetch GitHub, pas de SHA. S'il n'existe pas encore, traite-le comme
`{"generatedAt":"","news":{}}`.

`startup-news.json` = `{ "generatedAt": "...", "news": { "<Startup>": NewsItem[] } }`.
Pour chaque startup, ses items déjà stockés sont dans `.news["<Startup>"]` — traite leurs
`title` + `url` comme **déjà couverts**.

## Étape 3 — rechercher chaque startup (recherche web native)

Pour **chaque** nom de `union.json.startups` :

1. Recherche web native → développements **nouveaux et distincts** : levées, résultats
   cliniques, jalons réglementaires, partenariats majeurs, recrutements clés, M&A.
2. **RÈGLE DURE — fenêtre 30 j :** ne garde un item que si son `publishedAt` est dans les
   **30 derniers jours** (`publishedAt >= aujourd'hui − 30 j`). Jette tout ce qui est plus
   ancien (la fusion le retirerait de toute façon).
3. **Exclure le déjà-couvert** par les items stockés de cette startup (match sur l'événement,
   pas juste l'URL).
4. **Une affaire = un article :** plusieurs sources sur le même événement → **un** item.
5. **Noms précis, jamais vague :** chaque titre porte société + montant chiffré + lead
   investor / partenaire / régulateur / molécule. « lève un gros tour » → « Owkin lève 30 M€
   menée par Fidelity ».
6. N'invente jamais d'URL, de source ou de date. En cas de doute, jette l'item.

Item :

```jsonc
{
  "title": "Owkin étend son partenariat oncologie avec Sanofi (+30 M€)",
  "source": "Tech.eu",
  "url": "https://tech.eu/2026/07/owkin-sanofi",
  "publishedAt": "2026-07-08",   // ISO AAAA-MM-JJ (fenêtre 30 j + tri)
  "date": "8 juil. 2026"         // libellé FR absolu dérivé de publishedAt
}
```

Accumule tout dans **`candidates.json`** (startup → liste des NOUVEAUX items). Une startup
sans rien de neuf : **omets-la** (ou `[]`). Jamais de remplissage inventé.

## Étape 4 — fusion (rétention) puis publication git

**Fusion** déterministe (écrit le résultat à la racine du dépôt) :

```bash
node ccr-merge.mjs candidates.json ../../startup-news.json merged.json
mv merged.json ../../startup-news.json
```

`ccr-merge.mjs` applique `mergeStartupNews` par startup sur (existant ∪ candidats) : dédup par
URL, retire > 30 j, garde les 3 plus récents. Les startups vides sont retirées (pas de tableau
vide). Il fixe `generatedAt` à aujourd'hui.

**Publication** — git ordinaire, depuis la racine du dépôt :

```bash
cd ../..
git add startup-news.json
git commit -m "chore(news): refresh startup-news.json (<aujourd'hui>)"
git push
```

Vérifie que le push a réussi (réessaie une fois en cas d'échec réseau). L'app récupère le
nouveau fichier au prochain fetch.

## Récap en une passe

```bash
cd backend/routine && npm ci
node ccr-union.mjs > union.json
# ... recherche web native par startup -> candidates.json ...
node ccr-merge.mjs candidates.json ../../startup-news.json merged.json
mv merged.json ../../startup-news.json
cd ../.. && git add startup-news.json && git commit -m "chore(news): refresh startup-news.json (<date>)" && git push
```

Termine par un récap court : startups traitées, items ajoutés, commit publié (ou la raison si rien).
