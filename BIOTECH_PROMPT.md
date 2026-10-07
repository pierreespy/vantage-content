# Routine Journal Biotech — prompt opérationnel (`edition-biotech.json`)

Second volet de la routine quotidienne « Journal ». Exécuté **à la suite** de
`DAILY_PROMPT.md` (étape 9bis), dans le même run, le même dépôt, sans interaction.
L'app affiche cette édition quand l'utilisateur choisit le thème **Biotech** (Réglages /
sélecteur en tête du Journal) — `config.editionUrls.biotech`.

**Tout `DAILY_PROMPT.md` s'applique** (vérité absolue, noms précis, filtre de pertinence,
schéma JSON strict, ton, signaux faibles, version anglaise, contraintes JSON), **sauf** ce qui
suit, qui remplace le périmètre MedTech :

## PÉRIMÈTRE BIOTECH

Veille de l'ÉCOSYSTÈME BIOTECH EUROPÉEN : thérapeutiques (petites molécules, biologiques,
anticorps, ADC, ARN/oligos, thérapies cellulaires et géniques, vaccins, radiopharmaceutiques),
plateformes de découverte (IA drug discovery, chimie, protéomique), outils de recherche,
synthetic biology santé. Priorité Europe, international pour les mouvements majeurs.
Le dispositif médical pur est HORS périmètre (il est couvert par l'édition MedTech).

Rubriques (`pillar`, mêmes clés que MedTech) :
- "innovation"  — Science & clinique : données d'essai (Phase I/II/III, endpoint primaire),
  premier patient dosé, publication marquante, preuve de concept préclinique, brevet clé ;
- "marche"      — Réglementaire & marché : IND/CTA, désignations FDA/EMA (Breakthrough,
  PRIME, Orphan, Fast Track), AMM/approbation, avis CHMP, accès précoce, licensing/partenariat
  pharma, nomination de dirigeant ;
- "naissances"  — Nouvelles pousses : création, spin-off de labo (Institut Pasteur, Curie,
  Inserm, Max Planck, Oxford, Cambridge, KU Leuven…), lauréats i-Lab / EIC, sortie de stealth ;
- "financement" — levées, M&A, IPO, gros deals de licensing (upfront chiffré).

Sources (en plus des wires) : Fierce Biotech, Endpoints News, BioPharma Dive, STAT,
Labiotech.eu, BioSpace, Evaluate Vantage, Sifted, EU-Startups, Maddyness, BeBeez,
communiqués des instituts. Barème `strength` identique (désignation Breakthrough/PRIME = 4,
IND/CTA = 3, licensing avec upfront chiffré ≥ 4…). `signalType` : mêmes valeurs ;
`sector` : "Biotech", "Oncologie", "Thérapie génique", "Thérapie cellulaire", "ARN",
"Immunologie", "Neurosciences", "IA drug discovery", "Vaccins"… ; "Fonds" / "Réglementaire"
pour un investisseur ou un régulateur. Ticker `kind` : "tech" (ex. "Ph2 ✓", "1er patient"),
"reg" ("IND", "PRIME", "AMM"), "new", "lev", "mna".

MOT DU JOUR : un terme **BIOTECH** (modalité, mécanisme, étape de développement,
réglementaire : ADC, PROTAC, CAR-T, siRNA, AAV, bispécifique, PRIME, IND…), vérifications
des startups identiques à MedTech. Interdit : tout terme présent dans
`recent-words-biotech.json` **ou** dans `recent-words.json` (pas de doublon avec le mot
MedTech du jour).

## ÉTAPES (biotech)

1. Lis `recent-words-biotech.json` et `recent-articles-biotech.json` (mémoires dédiées ;
   s'ils n'existent pas, pars de listes vides — le premier run les crée). N'utilise aucun
   article déjà présent dans `edition.json` du jour (pas de doublon avec l'édition MedTech).
2. Recherche, filtre et rédige comme `DAILY_PROMPT.md` étapes 2 à 4, avec le périmètre ci-dessus.
3. Écris `edition-biotech.json` (même SCHÉMA que `edition.json`).
4. Écris `edition-biotech.en.json` (règles ÉDITION ANGLAISE de `DAILY_PROMPT.md`) puis :
   `node check-en.mjs edition-biotech.json edition-biotech.en.json` (doit afficher OK).
5. Mets à jour `recent-words-biotech.json` : même format que `recent-words.json`
   (`{ "recent": [ { term, full, date } ] }`, ajout en tête, 30 plus récents).
6. Mémoires et glossaire (déterministe, jamais à la main) :
   `node remember-articles.mjs edition-biotech.json recent-articles-biotech.json`
   `node remember-word.mjs edition-biotech.json words.json`
   `node remember-word.mjs edition-biotech.en.json words.en.json words.json`
   (le glossaire est commun aux deux thèmes).
7. Publie : `git add edition-biotech.json edition-biotech.en.json recent-words-biotech.json recent-articles-biotech.json words.json words.en.json`
   puis `git commit -m "Édition Biotech du <dateLong>"` et `git push` sur **main**
   (`git pull --rebase` si rejeté, une nouvelle tentative en cas d'échec réseau).
8. Ajoute au récap final : mot du jour Biotech et lead Biotech retenus. **Pas** de second
   code d'accès : celui de l'édition MedTech vaut pour toute l'app.

Si le volet Biotech échoue (recherche vide, JSON invalide), n'empêche pas la publication
MedTech déjà faite : signale-le dans le récap et ne publie rien de faux.
