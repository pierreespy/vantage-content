# Génération du contenu quotidien — la « règle du jeu »

Ce dossier décrit **comment est fabriquée l'édition du jour** que l'app télécharge.
Chaque matin, une tâche Claude produit deux fichiers, déposés à l'URL de contenu
(`config.contentUrl` côté app) :

- **`edition.json`** — le contenu affiché par l'app (voir `example-edition.json` pour le
  gabarit exact ; le format est défini par le type `Edition` dans `src/content/types.ts`).
- **`recent-words.json`** — la **mémoire** des mots du jour récents, pour ne pas se répéter.

> Tant que l'automatisation n'est pas branchée, ces fichiers se remplacent à la main.
> La tâche du matin, elle, suit la procédure ci-dessous à la lettre.

---

## Le « Mot du jour » — critères de choix

Le mot du jour doit être **un terme HealthTech / MedTech / Biotech que Pierre peut
réellement croiser** en travaillant dans le VC santé (pitch de startup, mémo
d'investissement, due diligence, actu de deal). Règles, dans l'ordre :

1. **Domaine** — strictement HealthTech / MedTech / Biotech : un terme **scientifique,
   technologique, clinique, réglementaire ou business** propre au secteur. Pas de jargon
   VC généraliste hors-santé (le « term sheet » ou la « dilution » ne comptent pas ici).
2. **Pertinence VC santé** — privilégier ce qui aide à **comprendre pourquoi une boîte
   lève des fonds ou se fait racheter** : une technologie en vogue, une modalité
   thérapeutique, un concept-clé de thèse d'investissement, ou un terme réglementaire
   structurant.
3. **Bon niveau** — ni trop basique (déjà connu de tous, ex. « vaccin »), ni trop pointu
   ou anecdotique. Vise le terme « utile à maîtriser » pour un futur analyste.
4. **PAS DE RÉPÉTITION** — ne jamais choisir un terme présent dans `recent-words.json`
   (fenêtre des ~30 derniers jours). C'est la règle non négociable.
5. **Variété** — faire tourner les familles d'un jour à l'autre, ne pas enchaîner deux
   fois la même catégorie :
   - **Modalités thérapeutiques** — ADC, CAR-T, ARNm, siRNA, PROTAC, thérapie génique
     AAV, bispécifiques, cellules NK allogéniques…
   - **Plateformes / technos** — CRISPR & base editing, organoïdes, biologie de synthèse,
     IA de découverte de médicaments, protein design…
   - **Diagnostic / data** — biopsie liquide, diagnostic compagnon, biomarqueur,
     real-world evidence, imagerie augmentée par IA…
   - **Réglementaire / accès au marché** — marquage CE-MDR, 510(k) / PMA (FDA),
     désignation orpheline, DTx / SaMD (logiciel dispositif médical), remboursement (HAS)…
   - **Business santé** — désignation Breakthrough, exclusivité des données, deals à
     milestones & royalties, licensing…

   > Ces exemples ne sont qu'une amorce, pas une liste fermée — tout terme respectant
   > les règles 1–4 convient.

---

## La procédure du matin (pas à pas)

1. **Lire `recent-words.json`** → récupérer la liste des termes déjà utilisés récemment.
2. **Choisir un nouveau terme** respectant les règles 1–5 ci-dessus, **absent** de cette
   liste.
3. **Rédiger le bloc `word`** (mêmes champs que le gabarit) :
   `term`, `full`, `fr`, `field`, `definition` (vulgarisée, une phrase claire),
   `parts` (3 briques : label + rôle), `how` (3 étapes du mécanisme),
   `why` (pourquoi c'est en vogue, angle VC), `deals` (M&A/levées de référence, avec
   `year`).
4. **Générer le reste de l'édition** (`dateLong`, `ticker`, `lead`, `deal`,
   `brefsEurope`, `brefsIntl`) — **règle éditoriale permanente : noms précis** (société,
   montant, investisseur en lead), jamais de descriptions vagues.
   - **Champ `stage`** (optionnel) sur `lead` et chaque brève : le round de l'opération
     (`"Pre-seed"`, `"Seed"`, `"Series A"`, `"Series B"`, `"Series C"`, `"Growth"`,
     `"IPO"`…). L'app **mémorise** ce stade par société et l'affiche sur la carte Favoris.
     Ainsi le stade reste **dynamique et exact** (mis à jour à chaque nouvelle levée),
     plutôt que gravé en dur. À remplir dès que le round est connu.
   - **Quota quotidien de brèves** (décision permanente de Pierre, 9 juillet 2026,
     précisée le même jour) : viser **5 items dans `brefsEurope` et 3 dans
     `brefsIntl`, tous les jours**, en plus de `lead` et `deal`. **Fenêtre de
     fraîcheur non négociable : 24–72h.** Le quota est une cible, pas une excuse pour
     publier du remplissage — **interdiction absolue d'élargir la fenêtre temporelle
     pour combler un manque** (pas de vieux deals de plusieurs semaines/mois pour
     faire du nombre).
     Avant de conclure qu'il manque d'actu : **creuser beaucoup plus large et beaucoup
     plus fort**. Il y a presque toujours assez d'actualité fraîche healthtech VC dans
     le monde — le problème vient d'une recherche trop étroite, pas d'un manque de
     news. Multiplier les sources et les angles de recherche : au minimum EU-Startups,
     Sifted, Tech.eu, MedCity News, MobiHealthNews, MedTech Dive, Fierce Biotech/
     Fierce Healthcare, BioPharma Dive, Labiotech, BeBeez, HTWorld, Endpoints News,
     StatNews, ainsi que la presse française spécialisée (Maddyness, French Tech
     Journal, La Tribune, Les Echos). Interroger chaque source pour la date du jour et
     la veille, pas seulement des requêtes génériques par mois. **Sources en anglais
     et en français toutes les deux acceptées sans restriction** (Pierre lit les
     deux) — ne pas se limiter à la presse francophone ni exclure les sources
     anglophones, la priorité reste la fraîcheur et la pertinence du deal, pas la
     langue de l'article.
     Si, malgré une recherche réellement approfondie sur toutes ces sources, le quota
     n'est vraiment pas atteignable un jour donné avec des news fraîches, **publier
     moins d'items plutôt que de tricher sur la fraîcheur** — et le signaler dans le
     commit.
5. **Écrire les deux fichiers** :
   - `edition.json` (l'édition du jour) ;
   - `recent-words.json` **mis à jour** : ajouter `{ "term", "full", "date" }` (date du
     jour au format `AAAA-MM-JJ`) **en tête** de `recent`, puis **tronquer aux ~30 plus
     récents**.

---

## Publication (git)

Décision permanente de Pierre (8 juillet 2026) : **automatiser complètement**. Chaque
exécution de la tâche du matin doit :

1. Commiter `edition.json`, `recent-words.json` **et `access.json`** (voir « Le code
   d'accès quotidien » ci-dessous) avec un message clair (ex. « Edition du [date] »).
2. **Pousser directement sur `main`** — pas de branche intermédiaire, pas de pull
   request, pas de validation manuelle à attendre. Ce dépôt n'a ni CI ni collaborateurs ;
   le risque est faible et la volonté explicite de Pierre est de ne plus avoir à cliquer
   « merge » chaque jour.

Cette règle s'applique quelle que soit la session qui exécute la tâche (nouvelle session
ou session reprise), tant qu'elle n'est pas explicitement révoquée par Pierre.

---

## Le code d'accès quotidien — `access.json`

L'onglet Favoris a deux paliers : *restreint* (**1** startup) et *étendu* (**6**). Le
palier étendu se débloque avec le **code du jour**, que Pierre distribue à la demande
(LinkedIn). Chaque matin, la tâche produit **aussi** `access.json`, à côté de `edition.json`.

**On ne publie que le hash salé, jamais le code en clair.** C'est de la friction (rotation
quotidienne), pas de la sécurité forte. L'app vérifie le code **hors-ligne** contre ce hash.

Procédure (en plus des fichiers d'édition) :

1. **Choisir la passphrase du jour** — lisible, NOUVELLE chaque jour : 2-3 mots ASCII
   minuscules + un nombre, tirets, sans caractères ambigus (pas de `o/0`, `l/1/I`), ex.
   `quorum-heron-73`.
2. **Sel** : `node -e 'console.log(require("crypto").randomBytes(9).toString("hex"))'`.
3. **Hash** (canonicalisation identique à l'app : trim + minuscules + espaces compactés) :
   ```bash
   node -e 'const{createHash}=require("crypto");const c=s=>s.trim().toLowerCase().replace(/\s+/g," ");console.log(createHash("sha256").update(process.argv[1]+":"+c(process.argv[2])).digest("hex"))' "<sel>" "<passphrase>"
   ```
4. **Écrire `access.json`** = `{ "date":"AAAA-MM-JJ", "algo":"sha256", "salt":"<sel>", "hash":"<hash>", "hint":"…" }`.
   Le `hint` ne révèle **jamais** le code.
5. **Transmettre le code en clair à Pierre hors dépôt** (résumé de fin), pour distribution.
   Ne jamais écrire le code en clair dans un fichier committé.

> Le palier étendu = **6** favoris. Ce cap doit rester en phase avec `EXTENDED_LIMIT` (app)
> et les règles Firestore (`size() <= 6`). Contrat complet : `docs/perso-favoris.md`.

---

## Pourquoi une mémoire séparée ?

L'app n'a pas besoin de connaître l'historique des mots (elle n'affiche que celui du
jour). C'est **la génération** qui en a besoin, pour ne pas se répéter. On garde donc
cette mémoire dans son propre fichier, à côté de `edition.json`, plutôt que de la mêler
au contenu affiché.
