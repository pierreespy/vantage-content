// Vantage — legal-registry connector (INPI, Registre National des Entreprises).
//
// The FREE replacement for Pappers, and the third leg of the high-priority rule:
// a publication says a team exists, a patent says it thinks there is a product,
// an INCORPORATION says it has decided to go.
//
// Pappers was the original choice because its API is far friendlier. It turned
// out to be paid, which collides with the plan's "0 €, aucune source payante"
// decision, so this connector took over as the default. Pappers remains in the
// tree and is still selectable through `SIGNALS_SOURCES` for anyone holding a
// key — but the two must NOT run together: they would each emit a
// `company_creation` record for the same SIREN under different source ids.
//
// Written against the published OpenAPI spec (INPI RNE 3.1.3,
// https://registre-national-entreprises.inpi.fr/api/doc.json). Two things that
// spec does NOT pin down, and which this parser therefore handles defensively:
//
//   1. the KEY holding the result array in the paginated response — `SearchResponse`
//      only types `totalSize/page/maxPage/pageSize`, so `findResults` tries the
//      usual names and then falls back to "the first array of objects with a
//      siren";
//   2. the token field name on the login response.
//
// The RNE document is deeply nested; the paths this connector reads are:
//
//   siren
//   content.personneMorale.identite.entreprise   -> denomination, codeApe, dateImmat
//   content.personneMorale.composition.pouvoirs[]-> the officers
//     .individu.descriptionPersonne              -> nom, prenoms[]
//     .roleEntreprise / .libelleRoleEntreprise   -> "Président", "Gérant"…
//
// Sole traders (`personnePhysique`) carry the same sub-structure, so both
// branches are read.

import { makeRecord } from '../lib/record.mjs';
import { isoDaysAgo, isoDay, toIsoDay } from '../lib/dates.mjs';

export const HOST = 'registre-national-entreprises.inpi.fr';
const BASE = `https://${HOST}/api`;

/** INPI is a public service on modest infrastructure — stay gentle. */
export const MIN_INTERVAL_MS = 700;

/** Re-login this long after a token was issued. The spec does not publish the
 *  lifetime, so this is deliberately short; a 401 also forces a refresh. */
const TOKEN_TTL_MS = 25 * 60_000;

/**
 * APE/NAF codes defining a MedTech/biotech incorporation. Same list as the
 * Pappers connector — INPI uses the same nomenclature.
 *   2120Z pharmaceutical preparations · 2660Z electromedical equipment
 *   3250A medical & dental instruments · 3250B dental prosthetics
 *   7211Z biotechnology R&D           · 7219Z other natural-science R&D
 */
export const DEFAULT_APE_CODES = ['2120Z', '2660Z', '3250A', '3250B', '7211Z', '7219Z'];

/**
 * Token provider with in-memory caching.
 *
 * @param {object} opts
 * @param {{ json: Function }} opts.http
 * @param {string} opts.username  INPI account e-mail
 * @param {string} opts.password
 * @returns {(force?: boolean) => Promise<string>} resolves to a bearer token
 */
export function createInpiAuth(opts) {
  const { http, username, password, now = () => Date.now() } = opts ?? {};
  let token = '';
  let issuedAt = 0;

  return async function getToken(force = false) {
    if (!force && token && now() - issuedAt < TOKEN_TTL_MS) return token;

    const payload = await http.json(`${BASE}/sso/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
      useCache: false, // never cache a credential exchange
    });

    // The spec types the REQUEST but not the response; accept the plausible names.
    token = payload?.token || payload?.access_token || payload?.jwt || '';
    if (!token) throw new Error('INPI: no token in the login response');
    issuedAt = now();
    return token;
  };
}

/** Search URL for one page of formalities. */
export function buildSearchUrl(opts = {}) {
  const { since, until, apeCodes = DEFAULT_APE_CODES, page = 1, pageSize = 100 } = opts;

  const url = new URL(`${BASE}/formalities/paginated`);
  // `codesApe[]` and the date bounds are the two filters that make this query
  // cheap enough to run daily. `depotDateTo` is EXCLUSIVE per the spec.
  for (const code of apeCodes) url.searchParams.append('codesApe[]', code);
  if (since) url.searchParams.set('depotDateFrom', since);
  if (until) url.searchParams.set('depotDateTo', until);
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('sortBy', 'depotDate');
  url.searchParams.set('sortDirection', 'DESC');
  return url.toString();
}

/**
 * Find the result array in a paginated response.
 *
 * `SearchResponse` in the spec only describes the pagination counters, so the
 * key holding the rows is not contractual. Guessing one name and hard-failing on
 * the others would make this connector brittle for no reason.
 */
export function findResults(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['results', 'items', 'data', 'content', 'formalities', 'hits', 'records']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  for (const value of Object.values(payload ?? {})) {
    if (Array.isArray(value) && value.some((row) => row && typeof row === 'object' && 'siren' in row)) {
      return value;
    }
  }
  return [];
}

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/** Full name from a `BlocDescriptionPersonne`: `prenoms[]` + `nom`. */
function personName(description) {
  if (!description || typeof description !== 'object') return '';
  const given = asArray(description.prenoms).filter((p) => typeof p === 'string' && p.trim());
  const family = description.nomUsage || description.nom || '';
  return [...given, family].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/** Officers of one formality, from either the legal-person or sole-trader branch. */
function officersOf(content, companyName) {
  const branches = [content?.personneMorale, content?.personnePhysique, content?.exploitation];

  const people = [];
  for (const branch of branches) {
    for (const pouvoir of asArray(branch?.composition?.pouvoirs)) {
      // `individu` holds a natural person; `entreprise` holds a legal-person
      // officer (a holding company managing another) — only the former is a
      // person we can join to authors and inventors.
      const name = personName(pouvoir?.individu?.descriptionPersonne);
      if (!name) continue;
      const role = pouvoir.libelleRoleEntreprise || pouvoir.roleEntreprise || '';
      people.push({
        name,
        role: 'director',
        ...(role ? { affiliation: `${role} — ${companyName}` } : {}),
      });
    }
  }
  return people;
}

/** Company identity block, from whichever branch this formality used. */
function identityOf(content) {
  const branches = [content?.personneMorale, content?.personnePhysique, content?.exploitation];
  for (const branch of branches) {
    const entreprise = branch?.identite?.entreprise;
    if (entreprise && typeof entreprise === 'object') return entreprise;
  }
  return {};
}

/** One `/formalities/paginated` page -> `SourceRecord[]`. Pure. */
export function parseFormalities(payload) {
  return findResults(payload)
    .map((formality) => {
      const siren = formality?.siren;
      const content = formality?.content;
      if (!siren || !content) return null;

      const entreprise = identityOf(content);
      const name =
        entreprise.denomination || entreprise.nomCommercial || entreprise.nomExploitation || '';
      if (!name) return null;

      // `dateImmat` is the incorporation date — the fact the high-priority rule
      // measures "moins de 6 mois" against. Fall back to the RNE integration
      // date only when the document has no immatriculation date at all.
      const incorporatedAt =
        toIsoDay(entreprise.dateImmat) ||
        toIsoDay(entreprise.dateDebutActiv) ||
        toIsoDay(formality.created);
      if (!incorporatedAt) return null;

      const apeCode = entreprise.codeApe || entreprise.codeApeNaf2025 || '';

      return makeRecord({
        source: 'inpi',
        sourceId: String(siren),
        kind: 'company_creation',
        title: `Création de ${name}`,
        date: incorporatedAt,
        // The RNE has no public per-company permalink; Annuaire des Entreprises
        // is the official government front-end over the same registry.
        url: `https://annuaire-entreprises.data.gouv.fr/entreprise/${String(siren)}`,
        country: 'FR',
        people: officersOf(content, name),
        organizations: [{ name, role: 'company', kind: 'INDUSTRY' }],
        keywords: [apeCode, entreprise.objet].filter(Boolean),
        // A SIREN is immutable, and so is an incorporation date.
        fingerprint: `siren:${siren}`,
        extra: {
          siren: String(siren),
          companyName: name,
          nafCode: apeCode,
          incorporatedAt,
          legalForm: entreprise.formeJuridique || formality.formeJuridique || '',
        },
      });
    })
    .filter(Boolean);
}

/** Total pages advertised by the response, used to stop paging. */
export function maxPageOf(payload) {
  const max = Number(payload?.maxPage);
  return Number.isFinite(max) && max > 0 ? max : 1;
}

/**
 * Fetch companies incorporated within the window.
 *
 * The lookback is 183 days, not 30: the high-priority rule asks for a company
 * created LESS THAN 6 MONTHS ago, so the connector has to see the whole six
 * months for the rule to ever fire. See `config.test.mjs`.
 *
 * Returns `[]` with a warning when no credentials are configured — one
 * unconfigured source never aborts the run.
 *
 * @param {object} opts
 * @param {{ json: Function }} opts.http
 * @param {string} [opts.username] / @param {string} [opts.password]
 * @returns {Promise<object[]>} `SourceRecord[]`
 */
export async function fetchCompanyCreations(opts) {
  const {
    http,
    username,
    password,
    lookbackDays = 183,
    now = Date.now(),
    apeCodes = DEFAULT_APE_CODES,
    pageSize = 100,
    maxPages = 5,
    getToken = username && password ? createInpiAuth({ http, username, password }) : null,
    logger = console,
  } = opts ?? {};

  if (!getToken) {
    logger.warn?.('inpi: INPI_USERNAME / INPI_PASSWORD not set — skipping the legal-registry source.');
    return [];
  }

  const since = isoDaysAgo(lookbackDays, now);
  // `depotDateTo` is exclusive, so tomorrow keeps today's filings in range.
  const until = isoDaysAgo(-1, now);

  let token = await getToken();
  const records = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = buildSearchUrl({ since, until, apeCodes, page, pageSize });

    let payload;
    try {
      payload = await http.json(url, { headers: { authorization: `Bearer ${token}` } });
    } catch (err) {
      // A token can expire mid-run; retry once with a fresh one before giving up.
      if (err?.status !== 401 || page > maxPages) throw err;
      token = await getToken(true);
      payload = await http.json(url, { headers: { authorization: `Bearer ${token}` } });
    }

    const pageRecords = parseFormalities(payload);
    records.push(...pageRecords);
    if (!pageRecords.length || page >= maxPageOf(payload)) break;
  }

  // The date filter is on the FILING date; keep only companies whose
  // incorporation itself falls inside the window the rule cares about.
  return records.filter((record) => record.date >= since && record.date <= isoDay(now));
}
