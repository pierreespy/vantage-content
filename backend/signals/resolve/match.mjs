// Vantage — pairwise matching: "are these two mentions the same person / company?"
//
// docs/signals-plan.md flags name matching as "Risque n°1", and the failure modes
// pull in opposite directions:
//
//   FALSE NEGATIVE  "Dupont JM" (PubMed) and "DUPONT Jean-Marc" (EPO) not linked
//                   -> the high-priority lead never fires. We lose the signal.
//   FALSE POSITIVE  two different "Zhang Y" merged into one entity
//                   -> a fabricated lead. Worse: it costs the reader's trust.
//
// The bias here is deliberately towards precision. A shared family name plus a
// shared initial is NOT enough on its own to reach the merge threshold — it needs
// corroboration (an ORCID, a matching full given name, or overlapping
// affiliations). Common family names are additionally penalised, because
// "Zhang Y" collides constantly while "Vandenbroucke J" essentially never does.
//
// Everything here is pure and returns a SCORE plus the reason it was reached, so
// resolve.mjs can record WHY two mentions were merged.

import {
  basicNormalize,
  companyTokens,
  jaccard,
  jaroWinkler,
  normalizeCompany,
  parsePerson,
} from '../lib/normalize.mjs';

/** Merge above this. Calibrated so family+initial alone (0.62) falls short. */
export const PERSON_MATCH_THRESHOLD = 0.75;
/** Companies are compared on their full normalized name, so the bar is higher. */
export const COMPANY_MATCH_THRESHOLD = 0.88;

/** Shortest normalized name allowed to act as a PREFIX match. Below this, a name
 *  is too generic to identify a company: "B" is not evidence of "B. Braun". */
const MIN_PREFIX_CHARS = 4;

/**
 * Family names common enough that "same family name + same initial" is weak
 * evidence. Not exhaustive by design — it only has to cover the names that
 * actually generate collisions in biomedical author lists.
 */
const COMMON_FAMILY_NAMES = new Set([
  'wang', 'li', 'zhang', 'liu', 'chen', 'yang', 'huang', 'zhao', 'wu', 'zhou',
  'xu', 'sun', 'ma', 'zhu', 'hu', 'guo', 'lin', 'he', 'gao', 'luo',
  'kim', 'lee', 'park', 'choi', 'jung', 'kang',
  'smith', 'jones', 'williams', 'brown', 'taylor', 'davies', 'wilson',
  'martin', 'bernard', 'dubois', 'thomas', 'robert', 'richard', 'petit', 'durand',
  'muller', 'schmidt', 'schneider', 'fischer', 'weber', 'meyer', 'wagner',
  'garcia', 'rodriguez', 'martinez', 'lopez', 'gonzalez', 'perez', 'sanchez',
  'rossi', 'russo', 'ferrari', 'esposito', 'silva', 'santos', 'singh', 'kumar',
]);

/** Words in an affiliation that carry no discriminating power. */
const AFFILIATION_STOPWORDS = new Set([
  'university', 'universite', 'universitat', 'universidad', 'universita',
  'hospital', 'hopital', 'clinic', 'clinique', 'department', 'departement',
  'institute', 'institut', 'center', 'centre', 'school', 'faculty', 'faculte',
  'laboratory', 'laboratoire', 'lab', 'research', 'recherche', 'medical',
  'medicine', 'medecine', 'science', 'sciences', 'health', 'sante', 'de', 'of',
  'and', 'et', 'the', 'inserm', 'cnrs',
]);

/** Discriminating tokens of an affiliation string. */
export function affiliationTokens(value) {
  return new Set(
    basicNormalize(value)
      .split(' ')
      .filter((token) => token.length > 2 && !AFFILIATION_STOPWORDS.has(token))
  );
}

/** Do two initial strings agree? "JM" vs "J" agrees; "JM" vs "PM" does not. */
function initialsAgree(a, b) {
  if (!a || !b) return null; // unknown, not a contradiction
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return long.startsWith(short);
}

/**
 * Score two person mentions, 0..1.
 *
 * A mention is `{ name, orcid?, affiliation?, country? }` — whatever a connector
 * could extract.
 *
 * @returns {{ score: number, reason: string }}
 */
export function matchPersons(a, b) {
  const orcidA = a?.orcid ?? '';
  const orcidB = b?.orcid ?? '';

  // An ORCID is an exact identifier: it both confirms and REFUTES.
  if (orcidA && orcidB) {
    return orcidA === orcidB
      ? { score: 1, reason: 'orcid' }
      : { score: 0, reason: 'orcid-mismatch' };
  }

  const personA = parsePerson(a?.name ?? '');
  const personB = parsePerson(b?.name ?? '');
  if (!personA.family || !personB.family) return { score: 0, reason: 'no-family-name' };
  if (personA.family !== personB.family) return { score: 0, reason: 'family-differs' };

  const agreement = initialsAgree(personA.initials, personB.initials);
  if (agreement === false) return { score: 0, reason: 'initials-differ' };

  // How much of the given name each side actually spelled out. A given name
  // reconstructed from an initials block ("JM" -> "j m") is NOT a spelled-out
  // name and must never be string-compared against one.
  const aSpelled = !personA.initialsOnly && personA.given.length > 1;
  const bSpelled = !personB.initialsOnly && personB.given.length > 1;
  const sharedInitials = Math.min(personA.initials.length, personB.initials.length);

  let score;
  let reason;

  if (aSpelled && bSpelled) {
    if (personA.given === personB.given) {
      score = 0.9;
      reason = 'full-name';
    } else {
      // Both spelled out but different ("Jean-Marc" vs "Jean") — near-miss only.
      const similarity = jaroWinkler(personA.given, personB.given);
      if (similarity < 0.85) return { score: 0, reason: 'given-differs' };
      score = 0.78;
      reason = 'given-similar';
    }
  } else if (aSpelled || bSpelled) {
    // One side spelled out, the other initialled — the PubMed <-> EPO case.
    // Two agreeing initials ("JM" vs "Jean-Marc") is meaningfully rarer than one.
    score = sharedInitials >= 2 ? 0.76 : 0.64;
    reason = `initials-vs-full(${sharedInitials})`;
  } else {
    // Both initialled, or no given name at all. Deliberately below threshold on
    // a single initial: "Bernard A" and "Bernard A" are usually two people.
    score = sharedInitials >= 2 ? 0.72 : 0.62;
    reason = `family+initials(${sharedInitials})`;
  }

  // Corroboration: shared discriminating affiliation tokens. Weighted heavily
  // enough to carry a bare family+initial pair over the line on its own, since
  // agreeing on a specific institution is exactly the evidence we were missing.
  const overlap = jaccard(affiliationTokens(a?.affiliation), affiliationTokens(b?.affiliation));
  if (overlap > 0) {
    score += Math.min(0.25, overlap * 0.6);
    reason += '+affiliation';
  }

  if (a?.country && b?.country && a.country === b.country) score += 0.04;

  // Common family names need the corroboration to have actually happened:
  // "Zhang Y" collides constantly, "Vandenbroucke J" essentially never does.
  if (COMMON_FAMILY_NAMES.has(personA.family) && overlap === 0 && reason.startsWith('family')) {
    score -= 0.2;
    reason += '+common-name-penalty';
  }

  return { score: Math.max(0, Math.min(1, score)), reason };
}

/**
 * Score two company mentions, 0..1.
 *
 * Comparison runs on the canonical form, so legal suffixes and punctuation are
 * already gone: "NEUROSCAN MEDICAL SAS" vs "NeuroScan Medical" is an exact match
 * by the time we get here.
 *
 * @returns {{ score: number, reason: string }}
 */
export function matchCompanies(a, b) {
  const nameA = normalizeCompany(a?.name ?? '');
  const nameB = normalizeCompany(b?.name ?? '');
  if (!nameA || !nameB) return { score: 0, reason: 'empty' };
  if (nameA === nameB) return { score: 1, reason: 'exact' };

  // A single-token name ("Owkin") must match nearly character-for-character:
  // token overlap has nothing to work with and would happily merge "Cardia"
  // with "Cardio".
  const similarity = jaroWinkler(nameA, nameB);
  const tokensA = companyTokens(a?.name ?? '');
  const tokensB = companyTokens(b?.name ?? '');
  if (tokensA.size === 1 && tokensB.size === 1) {
    return similarity >= 0.95
      ? { score: similarity, reason: 'single-token-similar' }
      : { score: 0, reason: 'single-token-differs' };
  }

  const overlap = jaccard(tokensA, tokensB);

  // One name being a strict prefix of the other ("Neuroscan" / "Neuroscan
  // Medical") is a common real-world case and deserves a high score — but ONLY
  // when the prefix is substantial enough to identify anything.
  //
  // Without MIN_PREFIX_CHARS, a source emitting a one-letter organisation name
  // ("B") prefix-matches EVERY company starting with that letter, and because a
  // mention matching two clusters merges them, that single junk name bridged
  // "B S", "B G", "B. Braun Melsungen" and "B. Braun Avitum" into one entity in
  // the first live run with patents. A short name must earn its match through
  // token overlap or string similarity instead.
  const shorter = nameA.length <= nameB.length ? nameA : nameB;
  const isPrefix = nameA.startsWith(`${nameB} `) || nameB.startsWith(`${nameA} `);
  const contained = isPrefix && shorter.length >= MIN_PREFIX_CHARS;

  const score = Math.max(similarity * 0.95, overlap, contained ? 0.9 : 0);
  const reason = contained ? 'prefix' : overlap >= similarity ? 'token-overlap' : 'string-similar';
  return { score: Math.max(0, Math.min(1, score)), reason };
}

/** Convenience predicates used by resolve.mjs. */
export const personsMatch = (a, b) => matchPersons(a, b).score >= PERSON_MATCH_THRESHOLD;
export const companiesMatch = (a, b) => matchCompanies(a, b).score >= COMPANY_MATCH_THRESHOLD;
