// Vantage — legal-registry connector (Pappers, French RNE/RCS data).
//
// This is the third leg of the high-priority join. A publication says a team
// exists; a patent says it thinks there is a product; a COMPANY INCORPORATION
// says it has decided to go. When the same person carries all three within a few
// months, that is the lead a seed fund wants before anyone announces a round.
//
// Pappers' `/v2/recherche` is used because it returns, in one call and without
// scraping: the SIREN, the incorporation date, the NAF activity code and — the
// part that matters — `representants`, i.e. the DIRECTORS by name. Those names are
// what resolve/match.mjs joins back to authors and inventors.
//
// Alternative, if Pappers' quota is ever a problem: INPI's RNE API
// (registre-national-entreprises.inpi.fr) serves the same registry data for free,
// but requires an account, returns a heavier document, and is rate-limited more
// tightly. The record shape produced here would be identical, so swapping is a
// parser change confined to this file.

import { makeRecord } from '../lib/record.mjs';
import { isoDaysAgo } from '../lib/dates.mjs';

export const HOST = 'api.pappers.fr';
const BASE = `https://${HOST}/v2/recherche`;

/** Pappers meters by call on paid plans — pace conservatively. */
export const MIN_INTERVAL_MS = 500;

/**
 * NAF/APE codes that define a MedTech/biotech incorporation:
 *   2120Z pharmaceutical preparations · 2660Z electromedical & irradiation equipment
 *   3250A medical & dental instruments · 3250B dental prosthetics
 *   7211Z biotechnology R&D           · 7219Z other natural-science R&D
 *
 * `6201Z` (software) is deliberately NOT in the default set: it would flood the
 * pipeline with every SaaS incorporation in France. Add it via env only alongside
 * a keyword filter.
 */
export const DEFAULT_NAF_CODES = ['2120Z', '2660Z', '3250A', '3250B', '7211Z', '7219Z'];

/** Search URL for one page of recently incorporated companies. */
export function buildSearchUrl(opts = {}) {
  const { apiToken, since, nafCodes = DEFAULT_NAF_CODES, page = 1, perPage = 100 } = opts;

  const url = new URL(BASE);
  url.searchParams.set('api_token', apiToken ?? '');
  url.searchParams.set('date_creation_min', since);
  url.searchParams.set('code_naf', nafCodes.join(','));
  url.searchParams.set('par_page', String(perPage));
  url.searchParams.set('page', String(page));
  // Newest first, so an early `maxPages` stop still keeps the freshest signals.
  url.searchParams.set('tri', 'date_creation');
  url.searchParams.set('ordre', 'desc');
  return url.toString();
}

/** Pappers names a company either `nom_entreprise` or `denomination`. */
function companyName(entry) {
  return entry?.nom_entreprise || entry?.denomination || entry?.nom_complet || '';
}

/** One `/recherche` page -> `SourceRecord[]`. Pure. */
export function parseSearchPage(payload) {
  const results = Array.isArray(payload?.resultats) ? payload.resultats : [];

  return results
    .map((entry) => {
      const siren = entry?.siren;
      const name = companyName(entry);
      if (!siren || !name) return null;

      // Directors: the join target. `qualite` is the French role label
      // ("Président", "Directeur général", "Gérant").
      const people = (Array.isArray(entry.representants) ? entry.representants : [])
        .map((rep) => {
          const personName =
            rep?.nom_complet || [rep?.prenom, rep?.nom].filter(Boolean).join(' ') || rep?.nom;
          if (!personName) return null;
          return {
            name: personName,
            role: 'director',
            ...(rep?.qualite ? { affiliation: `${rep.qualite} — ${name}` } : {}),
          };
        })
        .filter(Boolean);

      return makeRecord({
        source: 'pappers',
        sourceId: String(siren),
        kind: 'company_creation',
        title: `Création de ${name}`,
        date: entry.date_creation,
        url: `https://www.pappers.fr/entreprise/${String(siren)}`,
        // Pappers is a French registry: every hit is FR unless it says otherwise.
        country: entry?.siege?.pays_code || 'FR',
        people,
        organizations: [{ name, role: 'company', kind: 'INDUSTRY' }],
        keywords: [entry.libelle_code_naf, entry.objet_social].filter(Boolean),
        // An incorporation date never moves; the SIREN is the identity.
        fingerprint: `siren:${siren}`,
        extra: {
          siren: String(siren),
          companyName: name,
          nafCode: entry.code_naf ?? '',
          nafLabel: entry.libelle_code_naf ?? '',
          incorporatedAt: entry.date_creation ?? '',
          city: entry?.siege?.ville ?? '',
          postalCode: entry?.siege?.code_postal ?? '',
        },
      });
    })
    .filter(Boolean);
}

/**
 * Fetch companies incorporated within the window.
 *
 * The default lookback is 183 days, not 30: the high-priority rule asks for a
 * company created LESS THAN 6 MONTHS ago, so the connector has to see the whole
 * six months for the rule to ever fire. It must stay >= `RECENT_COMPANY_DAYS`
 * in score.mjs — a shorter window would silently hide companies aged just under
 * six months, exactly the ones the rule is about. `config.test.mjs` pins that.
 *
 * Returns `[]` with a warning when no token is configured — one unconfigured
 * source never aborts the run.
 *
 * @param {object} opts
 * @param {{ json: Function }} opts.http
 * @param {string} [opts.apiToken] PAPPERS_API_KEY
 * @returns {Promise<object[]>} `SourceRecord[]`
 */
export async function fetchCompanyCreations(opts) {
  const {
    http,
    apiToken,
    lookbackDays = 183,
    now = Date.now(),
    nafCodes = DEFAULT_NAF_CODES,
    perPage = 100,
    maxPages = 5,
    logger = console,
  } = opts ?? {};

  if (!apiToken) {
    logger.warn?.('pappers: PAPPERS_API_KEY not set — skipping the legal-registry source.');
    return [];
  }

  const since = isoDaysAgo(lookbackDays, now);
  const records = [];

  for (let page = 1; page <= maxPages; page++) {
    const payload = await http.json(buildSearchUrl({ apiToken, since, nafCodes, page, perPage }));
    const pageRecords = parseSearchPage(payload);
    records.push(...pageRecords);

    const total = Number(payload?.total);
    if (!pageRecords.length || (Number.isFinite(total) && page * perPage >= total)) break;
  }
  return records;
}
