# Routine Journal Digital Health — prompt opérationnel (`edition-digitalhealth.json`)

Troisième volet de la routine quotidienne « Journal ». Exécuté **à la suite** du volet
Biotech (`DAILY_PROMPT.md` étape 9ter), dans le même run, le même dépôt, sans interaction.
L'app affiche cette édition quand l'utilisateur choisit le thème **Digital Health**
(Réglages / sélecteur en tête du Journal) — `config.editionUrls.digitalhealth`.

**Tout `DAILY_PROMPT.md` s'applique** (vérité absolue, noms précis, filtre de pertinence,
schéma JSON strict, ton, signaux faibles, version anglaise, contraintes JSON), **sauf** ce qui
suit, qui remplace le périmètre MedTech :

## PÉRIMÈTRE DIGITAL HEALTH

Veille de l'ÉCOSYSTÈME DIGITAL HEALTH EUROPÉEN : télésanté / téléconsultation, thérapeutiques
numériques (DTx, DiGA, PECAN), télésurveillance, IA clinique et administrative (aide au
diagnostic logicielle, scribes / documentation, triage), logiciels hospitaliers et dossiers
patients (EHR/DPI, interopérabilité, FHIR), santé connectée et wearables grand public,
plateformes de soins (santé mentale, maladies chroniques, femtech, santé au travail),
infrastructure de données de santé (EHDS, HDS, entrepôts de données), cybersécurité santé,
paiement / assurance santé tech. Priorité Europe, international pour les mouvements majeurs.
Hors périmètre : le dispositif médical matériel (édition MedTech) et le médicament
(édition Biotech). Un logiciel dispositif médical (SaMD) peut figurer ici s'il n'est pas déjà
traité dans `edition.json` du jour.

Rubriques (`pillar`, mêmes clés que MedTech) :
- "innovation"  — Tech & clinique : étude d'impact / RCT d'une solution numérique, lancement
  produit, déploiement hospitalier chiffré (nb d'établissements, de patients), publication ;
- "marche"      — Réglementaire & marché : inscription DiGA / PECAN / remboursement,
  marquage CE logiciel, certification HDS, contrat ou partenariat nommé (hôpital, assureur,
  NHS, payeur), nomination de dirigeant ;
- "naissances"  — Nouvelles pousses : création, spin-off, lauréats (i-Lab, EIC, French Tech
  Santé…), sortie de stealth ;
- "financement" — levées, M&A, IPO.

Sources (en plus des wires) : MobiHealthNews, Fierce Healthcare, Healthcare IT News,
STAT (Health Tech), Sifted, Tech.eu, EU-Startups, Maddyness, DigitalHealth.net, HIT Consultant,
Rock Health, BeBeez, communiqués BfArM (DiGA), HAS / G_NIUS / ANS. Barème `strength`
identique (inscription DiGA/PECAN = 4, marquage CE logiciel = 3, contrat payeur nommé ≥ 3…).
`signalType` : mêmes valeurs ; `sector` : "Digital Health", "Télésanté", "DTx", "IA clinique",
"Santé mentale", "Femtech", "Wearables", "Logiciel hospitalier", "Données de santé"… ;
"Fonds" / "Réglementaire" pour un investisseur ou un régulateur. Ticker `kind` : "tech"
(ex. "RCT ✓", "Lancement"), "reg" ("DiGA", "PECAN", "CE"), "new", "lev", "mna".

MOT DU JOUR : un terme **DIGITAL HEALTH** (DTx, DiGA, PECAN, FHIR, interopérabilité, EHDS, HDS,
télésurveillance, RWE, SaMD, scribe IA…), vérifications des startups identiques à MedTech.
Interdit : tout terme présent dans `recent-words-digitalhealth.json`, `recent-words.json`
**ou** `recent-words-biotech.json` (pas de doublon avec les autres mots du jour).

## ÉTAPES (digital health)

1. Lis `recent-words-digitalhealth.json` et `recent-articles-digitalhealth.json` (mémoires
   dédiées ; s'ils n'existent pas, pars de listes vides — le premier run les crée). N'utilise
   aucun article déjà présent dans `edition.json` ni `edition-biotech.json` du jour.
2. Recherche, filtre et rédige comme `DAILY_PROMPT.md` étapes 2 à 4, avec le périmètre ci-dessus.
3. Écris `edition-digitalhealth.json` (même SCHÉMA que `edition.json`).
4. Écris `edition-digitalhealth.en.json` (règles ÉDITION ANGLAISE de `DAILY_PROMPT.md`) puis :
   `node check-en.mjs edition-digitalhealth.json edition-digitalhealth.en.json` (doit afficher OK).
5. Mets à jour `recent-words-digitalhealth.json` : même format que `recent-words.json`
   (`{ "recent": [ { term, full, date } ] }`, ajout en tête, 30 plus récents).
6. Mémoires et glossaire (déterministe, jamais à la main) :
   `node remember-articles.mjs edition-digitalhealth.json recent-articles-digitalhealth.json`
   `node remember-word.mjs edition-digitalhealth.json words.json`
   `node remember-word.mjs edition-digitalhealth.en.json words.en.json words.json`
   (le glossaire est commun aux trois thèmes).
7. Publie : `git add edition-digitalhealth.json edition-digitalhealth.en.json recent-words-digitalhealth.json recent-articles-digitalhealth.json words.json words.en.json`
   puis `git commit -m "Édition Digital Health du <dateLong>"` et `git push` sur **main**
   (`git pull --rebase` si rejeté, une nouvelle tentative en cas d'échec réseau).
8. Ajoute au récap final : mot du jour Digital Health et lead Digital Health retenus. **Pas**
   de code d'accès supplémentaire : celui de l'édition MedTech vaut pour toute l'app.

Si le volet Digital Health échoue (recherche vide, JSON invalide), n'empêche pas les
publications MedTech et Biotech déjà faites : signale-le dans le récap et ne publie rien de faux.
