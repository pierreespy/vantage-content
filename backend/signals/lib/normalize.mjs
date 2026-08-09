// Vantage — name normalization. The foundation of entity resolution.
//
// docs/signals-plan.md calls name matching "Risque n°1", and it is: the SAME
// person and the SAME company are spelled differently in every source we ingest.
//
//   person   PubMed "Dupont JM" · EPO "DUPONT JEAN-MARC [FR]" · Pappers "Jean-Marc DUPONT"
//   company  Pappers "NEUROSCAN MEDICAL SAS" · EPO "Neuroscan Medical S.A.S."
//            · ClinicalTrials.gov "Neuroscan Medical" · press "NeuroScan"
//
// So every comparison in resolve/ runs on the canonical forms produced here,
// never on raw strings. Everything in this module is PURE: same input, same
// output, no I/O, no clock — which is what makes the resolution deterministic
// across runs and unit-testable.

/**
 * True LEGAL forms — the ones that mean "an incorporated company exists".
 * Kept separate from the generic tails below because `hasLegalForm` uses only
 * this set: "Research Group" is not a company, "VASCage GmbH" is.
 */
const LEGAL_FORMS = new Set([
  // FR
  'sa', 'sas', 'sasu', 'sarl', 'eurl', 'sca', 'snc', 'sci', 'scop', 'se',
  // DE / AT / CH
  'gmbh', 'mbh', 'ag', 'ug', 'kg', 'kgaa', 'ohg', 'gbr',
  // UK / US / IE
  'ltd', 'limited', 'llc', 'lp', 'llp', 'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company', 'plc',
  // BENELUX / NORDICS
  'bv', 'nv', 'ab', 'oy', 'oyj', 'as', 'asa', 'aps', 'kft',
  // IT / ES / PT
  'spa', 'srl', 'sl', 'slu', 'sau', 'lda',
  // misc
  'pte', 'pty', 'kk', 'sro', 'doo', 'ooo', 'zoo',
]);

/**
 * Generic corporate tails. Stripped for MATCHING — it is what makes "Adler Ortho
 * Holding" and "Adler Ortho" the same entity — but they are not legal forms and
 * never prove a company exists.
 */
const GENERIC_TAILS = new Set(['holding', 'holdings', 'group', 'groupe', 'gruppo', 'grupo']);

/** Any tail worth stripping when canonicalising a company name. */
const STRIPPABLE_TAILS = new Set([...LEGAL_FORMS, ...GENERIC_TAILS]);

/** Words that carry no discriminating power in a company name. */
const COMPANY_STOPWORDS = new Set(['the', 'and', 'of', 'de', 'du', 'des', 'la', 'le', 'les']);

/** Name particles that belong to the family name, not the given name. */
const PARTICLES = new Set(['de', 'del', 'della', 'der', 'den', 'di', 'da', 'do', 'dos', 'du',
  'la', 'le', 'van', 'von', 'ter', 'ten', 'af', 'al', 'el', 'bin', 'ibn', "d'", 'st']);

/** Strip accents/diacritics: "Jérôme Müller" -> "Jerome Muller". */
export function foldDiacritics(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Lowercase, de-accent, turn every non-alphanumeric run into a single space, trim. */
export function basicNormalize(value) {
  return foldDiacritics(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Collapse dotted acronyms: "S.A.S." -> "SAS".
 *
 * Without this, `basicNormalize` turns the dots into spaces and the legal form
 * becomes three one-letter tokens ("s a s") that the suffix stripper cannot
 * recognise — so "Neuroscan Medical S.A.S." would never match "Neuroscan Medical".
 */
function collapseDottedAcronyms(value) {
  return String(value ?? '').replace(/\b(?:[A-Za-z]\.){2,}/g, (match) => match.replace(/\./g, ''));
}

/**
 * Canonical company key: normalized, legal forms removed, stopwords removed.
 * `"NEUROSCAN MEDICAL S.A.S."` and `"NeuroScan Medical"` both give `"neuroscan medical"`.
 *
 * Suffix stripping is repeated because names really do stack them
 * ("… Holding GmbH & Co KG"), and it always keeps at least one token so a
 * company legitimately named "Corp" does not normalize to the empty string.
 */
export function normalizeCompany(name) {
  let tokens = basicNormalize(collapseDottedAcronyms(name)).split(' ').filter(Boolean);
  if (!tokens.length) return '';

  let stripped = true;
  while (stripped && tokens.length > 1) {
    stripped = false;
    const last = tokens[tokens.length - 1];
    if (STRIPPABLE_TAILS.has(last)) {
      tokens = tokens.slice(0, -1);
      stripped = true;
    }
  }

  const meaningful = tokens.filter((t) => !COMPANY_STOPWORDS.has(t));
  return (meaningful.length ? meaningful : tokens).join(' ');
}

/**
 * Does this name carry a legal form ("… GmbH", "… SAS", "… Ltd")?
 *
 * Used to tell that a company REALLY exists behind an organisation, even when
 * the source says otherwise. ClinicalTrials.gov, for instance, classes some
 * sponsors as `OTHER` while naming them "VASCage GmbH" — and the medium-priority
 * rule is precisely about trials with NO commercial structure, so trusting the
 * declared class alone would fire it on companies.
 *
 * Only true legal forms count here, never the generic tails: "Research Group"
 * is not an incorporation.
 */
export function hasLegalForm(name) {
  const tokens = basicNormalize(collapseDottedAcronyms(name)).split(' ').filter(Boolean);
  return tokens.length > 1 && tokens.some((token) => LEGAL_FORMS.has(token));
}

/** Discriminating token set of a company name — the input to Jaccard overlap. */
export function companyTokens(name) {
  return new Set(normalizeCompany(name).split(' ').filter(Boolean));
}

/**
 * Parse a person name into its parts, whatever order the source used.
 *
 * Heuristics, in order (documented because they are the fuzzy part of the whole
 * pipeline, and every one of them is covered by a test):
 *   1. `"Family, Given"`        — a comma is unambiguous, trust it;
 *   2. `"Dupont JM"`            — PubMed: trailing 1-3 letter initials block;
 *   3. `"DUPONT JEAN-MARC"`     — EPO/registry exports uppercase EVERYTHING, and
 *                                 their convention is family name FIRST;
 *   4. `"DUPONT Jean-Marc"`     — mixed case with the family name shouted;
 *   5. `"Jean-Marc Dupont"`     — Western default: the LAST token is the family
 *                                 name, with particles ("van", "de") pulled in.
 *
 * Rule 3 exists because rule 4 alone silently mis-parsed every EPO inventor:
 * with both tokens uppercase, "is the first token shouted and the last one not?"
 * is false, so it fell through to Western order and read JEAN-MARC as the family
 * name — breaking the PubMed<->EPO join the whole scoring model depends on.
 *
 * @returns {{ family, given, initials, initialsOnly, key, display }}
 *   `initialsOnly` marks a given name reconstructed from an initials block
 *   ("JM" -> "j m"). Matching MUST NOT compare that against a real given name as
 *   if both were spelled out. `key` is `family|firstInitial`.
 */
export function parsePerson(name) {
  const empty = { family: '', given: '', initials: '', initialsOnly: false, key: '', display: '' };
  if (typeof name !== 'string') return empty;

  // Drop EPO's trailing country tag: "DUPONT JEAN-MARC [FR]".
  const cleaned = name.replace(/\[[A-Z]{2}\]\s*$/, '').trim();
  if (!cleaned) return empty;

  let family = '';
  let given = '';
  let initialsOnly = false;

  /** A token written entirely in capitals (hyphens and apostrophes allowed). */
  const isShouted = (token) => /^[A-ZÀ-Þ][A-ZÀ-Þ'’-]*$/.test(token);

  const comma = cleaned.indexOf(',');
  if (comma > 0) {
    // 1. "Family, Given"
    family = cleaned.slice(0, comma);
    given = cleaned.slice(comma + 1);
  } else {
    const rawTokens = cleaned.split(/\s+/).filter(Boolean);
    if (rawTokens.length === 1) {
      family = rawTokens[0];
    } else {
      const last = rawTokens[rawTokens.length - 1];
      if (/^[A-Z]{1,3}$/.test(last)) {
        // 2. PubMed "Dupont JM"
        family = rawTokens.slice(0, -1).join(' ');
        given = last.split('').join(' ');
        initialsOnly = true;
      } else if (rawTokens.every(isShouted)) {
        // 3. "DUPONT JEAN-MARC" — everything shouted, family first (EPO, registries)
        family = rawTokens[0];
        given = rawTokens.slice(1).join(' ');
      } else if (isShouted(rawTokens[0]) && rawTokens[0].length > 1 && !isShouted(last)) {
        // 4. "DUPONT Jean-Marc" — only the family name shouted
        family = rawTokens[0];
        given = rawTokens.slice(1).join(' ');
      } else {
        // 5. Western order, absorbing particles: "Jean de La Fontaine"
        let start = rawTokens.length - 1;
        while (start > 1 && PARTICLES.has(basicNormalize(rawTokens[start - 1]))) start -= 1;
        family = rawTokens.slice(start).join(' ');
        given = rawTokens.slice(0, start).join(' ');
      }
    }
  }

  const familyKey = basicNormalize(family);
  const givenKey = basicNormalize(given);
  const initials = givenKey
    .split(' ')
    .filter(Boolean)
    .map((t) => t[0])
    .join('');

  return {
    family: familyKey,
    given: givenKey,
    initials,
    initialsOnly,
    key: familyKey ? `${familyKey}|${initials.slice(0, 1)}` : '',
    display: cleaned.replace(/\s+/g, ' '),
  };
}

/** Jaccard overlap of two sets, 0..1. `0` when either side is empty. */
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Jaro-Winkler similarity, 0..1. Catches the typo-and-spacing differences that
 * token overlap misses ("Neuroscan" vs "NeuroScann", "Biotech" vs "Bio-tech").
 */
export function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array(a.length).fill(false);
  const bMatched = new Array(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const from = Math.max(0, i - matchWindow);
    const to = Math.min(i + matchWindow + 1, b.length);
    for (let j = from; j < to; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (!matches) return 0;

  // Half the number of matched characters that are out of order.
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  transpositions /= 2;

  const jaro = (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;

  // Winkler bonus: shared prefix up to 4 chars, which is where brand names agree.
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** ISO-3166 alpha-2 country code, upper-cased, or `''`. Sources are inconsistent here. */
export function normalizeCountry(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  return COUNTRY_BY_NAME[basicNormalize(raw)] ?? '';
}

/** Only the countries our sources actually emit as words; extend as needed. */
const COUNTRY_BY_NAME = {
  france: 'FR',
  germany: 'DE', allemagne: 'DE', deutschland: 'DE',
  'united kingdom': 'GB', 'royaume uni': 'GB', england: 'GB', scotland: 'GB', uk: 'GB',
  'united states': 'US', 'united states of america': 'US', usa: 'US', 'etats unis': 'US',
  spain: 'ES', espagne: 'ES', italy: 'IT', italie: 'IT',
  netherlands: 'NL', 'pays bas': 'NL', belgium: 'BE', belgique: 'BE',
  switzerland: 'CH', suisse: 'CH', sweden: 'SE', suede: 'SE',
  denmark: 'DK', danemark: 'DK', ireland: 'IE', irlande: 'IE',
  austria: 'AT', autriche: 'AT', portugal: 'PT', finland: 'FI', finlande: 'FI',
  norway: 'NO', norvege: 'NO', poland: 'PL', pologne: 'PL',
  israel: 'IL', canada: 'CA', china: 'CN', chine: 'CN', japan: 'JP', japon: 'JP',
};
