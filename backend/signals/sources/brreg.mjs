// Vantage — Norwegian company register (Brønnøysundregistrene, Enhetsregisteret).
//
// The only registry in this pipeline that needs NO credentials at all: it is
// fully open data and answers anonymously. Verified live against
// `data.brreg.no/enhetsregisteret/api/enheter`.
//
// Two calls per company, because Brønnøysund splits the data:
//   1. `/enheter`                  — the companies, filterable by NACE code and
//                                    registration date;
//   2. `/enheter/{orgnr}/roller`   — the OFFICERS, which the first call omits.
// The second call is what makes this connector worth having at all: without
// named directors there is nobody to join to authors and inventors, and the
// high-priority rule can never fire. It is bounded by `maxRoleLookups` so a
// broad window cannot turn into hundreds of requests.
//
// Norway is a small market, but the connector costs nothing to run and nothing
// to maintain, and Oslo/Trondheim medtech is real.

import { makeRecord } from '../lib/record.mjs';
import { isoDaysAgo, isoDay, toIsoDay } from '../lib/dates.mjs';
import { MEDTECH_NACE_NO } from './nace.mjs';

export const HOST = 'data.brreg.no';
const BASE = `https://${HOST}/enhetsregisteret/api`;

/** Open data on public infrastructure — stay polite. */
export const MIN_INTERVAL_MS = 300;

export const DEFAULT_NACE_CODES = MEDTECH_NACE_NO;

/**
 * Organisation forms that are actual trading companies. The register also
 * returns bankruptcy estates (`KBO`), sole proprietorships and public bodies;
 * a "Konkursbo" is the END of a company, the exact opposite of the signal.
 */
const COMPANY_FORMS = new Set(['AS', 'ASA', 'ANS', 'DA', 'BA', 'SA', 'SE']);

/**
 * `NUF` is deliberately NOT in that set. It is a Norwegian branch of a FOREIGN
 * company — registering one is not an incorporation, and the live run surfaced
 * exactly that failure: "NOVO NORDISK - NUF" (Danish) and "TEMA SINERGIE
 * S.P.A." (Italian) came back as if they were new Norwegian medtech companies.
 * A second guard follows in `parseUnits`: the business address must be in Norway.
 */
const NORWEGIAN_COUNTRY_CODES = new Set(['NO', '']);

/** Roles worth reporting as directors. Brønnøysund codes them. */
const DIRECTOR_ROLES = new Set([
  'DAGL', // daglig leder — CEO
  'LEDE', // styrets leder — chair
  'NEST', // nestleder — deputy chair
  'MEDL', // styremedlem — board member
  'INNH', // innehaver — owner
]);

/** Search URL for one NACE code and one page. */
export function buildSearchUrl(opts = {}) {
  const { naceCode, since, until, page = 0, pageSize = 100 } = opts;
  const url = new URL(`${BASE}/enheter`);
  // `naeringskode` matches on prefix, so "32.50" also returns "32.500".
  url.searchParams.set('naeringskode', naceCode);
  if (since) url.searchParams.set('fraRegistreringsdatoEnhetsregisteret', since);
  if (until) url.searchParams.set('tilRegistreringsdatoEnhetsregisteret', until);
  url.searchParams.set('page', String(page));
  url.searchParams.set('size', String(pageSize));
  return url.toString();
}

export function buildRolesUrl(orgNumber) {
  return `${BASE}/enheter/${orgNumber}/roller`;
}

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/** Companies out of one `/enheter` page, before officers are attached. */
export function parseUnits(payload) {
  return asArray(payload?._embedded?.enheter)
    .map((unit) => {
      const orgNumber = unit?.organisasjonsnummer;
      const name = unit?.navn;
      const registeredAt = toIsoDay(unit?.registreringsdatoEnhetsregisteret);
      if (!orgNumber || !name || !registeredAt) return null;

      const form = unit?.organisasjonsform?.kode ?? '';
      // Skip anything that is not a trading company — notably `KBO`, a
      // bankruptcy estate, which is the end of a company rather than a start,
      // and `NUF`, a branch of a foreign company.
      if (form && !COMPANY_FORMS.has(form)) return null;

      // …and skip anything whose business address is abroad: a foreign group
      // registering in Norway is not a Norwegian incorporation.
      const addressCountry = unit?.forretningsadresse?.landkode ?? unit?.postadresse?.landkode ?? '';
      if (!NORWEGIAN_COUNTRY_CODES.has(addressCountry)) return null;

      return {
        orgNumber: String(orgNumber),
        name: String(name),
        registeredAt,
        form,
        naceCode: unit?.naeringskode1?.kode ?? '',
        naceLabel: unit?.naeringskode1?.beskrivelse ?? '',
        city: unit?.forretningsadresse?.poststed ?? unit?.postadresse?.poststed ?? '',
      };
    })
    .filter(Boolean);
}

/** Total pages advertised by the Spring-HATEOAS envelope. */
export function totalPages(payload) {
  const total = Number(payload?.page?.totalPages);
  return Number.isFinite(total) && total > 0 ? total : 1;
}

/**
 * Officers out of a `/roller` payload.
 *
 * The shape is `rollegrupper[].roller[]`, and a role holder is either a
 * `person` (someone we can join on) or an `enhet` (a company acting as an
 * officer, which is not a contactable human).
 */
export function parseRoles(payload, companyName = '') {
  const people = [];
  for (const group of asArray(payload?.rollegrupper)) {
    for (const role of asArray(group?.roller)) {
      const code = role?.type?.kode ?? '';
      if (!DIRECTOR_ROLES.has(code)) continue;
      if (role?.avregistrert || role?.fratraadt) continue; // resigned / deregistered

      const person = role?.person;
      const given = person?.navn?.fornavn ?? '';
      const middle = person?.navn?.mellomnavn ?? '';
      const family = person?.navn?.etternavn ?? '';
      const name = [given, middle, family].filter(Boolean).join(' ').trim();
      if (!name) continue;

      const label = role?.type?.beskrivelse || code;
      people.push({
        name,
        role: 'director',
        ...(companyName ? { affiliation: `${label} — ${companyName}` } : {}),
      });
    }
  }
  // One person can hold several roles in the same company.
  const seen = new Set();
  return people.filter((p) => (seen.has(p.name) ? false : seen.add(p.name)));
}

/** Turn a parsed unit (+ its officers) into a `SourceRecord`. */
export function toRecord(unit, people = []) {
  return makeRecord({
    source: 'brreg',
    sourceId: unit.orgNumber,
    kind: 'company_creation',
    title: `Création de ${unit.name}`,
    date: unit.registeredAt,
    url: `https://virksomhet.brreg.no/nb/oppslag/enheter/${unit.orgNumber}`,
    country: 'NO',
    people,
    organizations: [{ name: unit.name, role: 'company', kind: 'INDUSTRY' }],
    keywords: [unit.naceCode, unit.naceLabel].filter(Boolean),
    fingerprint: `orgnr:${unit.orgNumber}`,
    extra: {
      orgNumber: unit.orgNumber,
      companyName: unit.name,
      nafCode: unit.naceCode,
      nafLabel: unit.naceLabel,
      incorporatedAt: unit.registeredAt,
      legalForm: unit.form,
      city: unit.city,
    },
  });
}

/**
 * Fetch Norwegian MedTech companies registered within the window.
 *
 * No credentials: this source always runs.
 *
 * @param {object} opts
 * @param {{ json: Function }} opts.http
 * @param {number} [opts.maxRoleLookups=60] cap on the officer calls
 * @returns {Promise<object[]>} `SourceRecord[]`
 */
export async function fetchCompanyCreations(opts) {
  const {
    http,
    lookbackDays = 183,
    now = Date.now(),
    naceCodes = DEFAULT_NACE_CODES,
    pageSize = 100,
    maxPages = 5,
    maxRoleLookups = 60,
    logger = console,
  } = opts ?? {};

  const since = isoDaysAgo(lookbackDays, now);
  const until = isoDay(now);

  const units = new Map(); // orgNumber -> unit, deduped across NACE codes
  for (const naceCode of naceCodes) {
    for (let page = 0; page < maxPages; page++) {
      const payload = await http.json(buildSearchUrl({ naceCode, since, until, page, pageSize }));
      const pageUnits = parseUnits(payload);
      for (const unit of pageUnits) units.set(unit.orgNumber, unit);
      if (!pageUnits.length || page + 1 >= totalPages(payload)) break;
    }
  }

  // Officers, one call per company, bounded. Newest first so the cap keeps the
  // freshest incorporations — those are the ones the 6-month rule is about.
  const ordered = [...units.values()].sort((a, b) => (a.registeredAt < b.registeredAt ? 1 : -1));
  const records = [];
  for (const [index, unit] of ordered.entries()) {
    let people = [];
    if (index < maxRoleLookups) {
      try {
        people = parseRoles(await http.json(buildRolesUrl(unit.orgNumber)), unit.name);
      } catch (err) {
        // A company without a public role list is still a valid incorporation
        // signal — it just cannot be joined to a researcher.
        logger.warn?.(`brreg: roles unavailable for ${unit.orgNumber} (${err.message})`);
      }
    }
    const record = toRecord(unit, people);
    if (record) records.push(record);
  }
  return records;
}
