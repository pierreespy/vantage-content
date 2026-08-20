// Vantage — UK company register (Companies House Public Data API).
//
// The highest-value registry after France: London–Oxford–Cambridge is the other
// major European healthtech cluster, and Companies House is the most capable of
// the free European registers — it filters by SIC code AND incorporation date in
// one query, and exposes officers.
//
// Free, but an API key is required (Companies House developer account).
//
// Two calls per company, like Brønnøysund:
//   1. `/advanced-search/companies` — companies by SIC code + incorporation date;
//   2. `/company/{number}/officers`  — the DIRECTORS, absent from the first call.
// The second is what makes the connector useful: without named directors there
// is nobody to join to authors and inventors, so the high-priority rule cannot
// fire. Bounded by `maxOfficerLookups`.
//
// Auth is HTTP Basic with the key as the USERNAME and an empty password — a
// Companies House idiosyncrasy, not a bearer token.

import { makeRecord } from '../lib/record.mjs';
import { isoDaysAgo, isoDay, toIsoDay } from '../lib/dates.mjs';
import { MEDTECH_SIC } from './nace.mjs';

export const HOST = 'api.company-information.service.gov.uk';
const BASE = `https://${HOST}`;

/** Companies House allows 600 requests per 5 minutes; 500 ms stays well inside. */
export const MIN_INTERVAL_MS = 500;

export const DEFAULT_SIC_CODES = MEDTECH_SIC;

/** Officer roles that denote someone worth contacting. */
const DIRECTOR_ROLES = new Set(['director', 'llp-member', 'llp-designated-member', 'member']);

/** Basic credentials: the key is the username, the password is empty. */
export function authHeader(apiKey) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
}

/** Advanced-search URL for one page. */
export function buildSearchUrl(opts = {}) {
  const { sicCodes = DEFAULT_SIC_CODES, since, until, startIndex = 0, size = 100 } = opts;
  const url = new URL(`${BASE}/advanced-search/companies`);
  for (const code of sicCodes) url.searchParams.append('sic_codes', code);
  if (since) url.searchParams.set('incorporated_from', since);
  if (until) url.searchParams.set('incorporated_to', until);
  // Dissolved companies are not sourcing leads.
  url.searchParams.set('company_status', 'active');
  url.searchParams.set('size', String(size));
  url.searchParams.set('start_index', String(startIndex));
  return url.toString();
}

export function buildOfficersUrl(companyNumber) {
  return `${BASE}/company/${encodeURIComponent(companyNumber)}/officers`;
}

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/** Companies out of one advanced-search page, before officers are attached. */
export function parseCompanies(payload) {
  return asArray(payload?.items)
    .map((item) => {
      const number = item?.company_number;
      const name = item?.company_name;
      const incorporatedAt = toIsoDay(item?.date_of_creation);
      if (!number || !name || !incorporatedAt) return null;

      const address = item?.registered_office_address ?? {};
      return {
        number: String(number),
        name: String(name),
        incorporatedAt,
        status: item?.company_status ?? '',
        type: item?.company_type ?? '',
        sicCodes: asArray(item?.sic_codes).map(String),
        city: address.locality || address.region || '',
      };
    })
    .filter(Boolean);
}

/** Total hits advertised by the search, used to stop paging. */
export function totalHits(payload) {
  const hits = Number(payload?.hits);
  return Number.isFinite(hits) ? hits : 0;
}

/**
 * Officers out of a `/officers` payload.
 *
 * Companies House writes names as `"SMITH, John Andrew"` — family name first,
 * comma-separated. `lib/normalize.mjs` parses that form natively, which is what
 * lets a UK director resolve to the same entity as a PubMed author.
 */
export function parseOfficers(payload, companyName = '') {
  const people = [];
  for (const officer of asArray(payload?.items)) {
    const role = String(officer?.officer_role ?? '');
    if (!DIRECTOR_ROLES.has(role)) continue;
    if (officer?.resigned_on) continue; // no longer there
    const name = String(officer?.name ?? '').trim();
    if (!name) continue;

    people.push({
      name,
      role: 'director',
      ...(companyName ? { affiliation: `${role} — ${companyName}` } : {}),
    });
  }
  const seen = new Set();
  return people.filter((p) => (seen.has(p.name) ? false : seen.add(p.name)));
}

/** Turn a parsed company (+ its officers) into a `SourceRecord`. */
export function toRecord(company, people = []) {
  return makeRecord({
    source: 'companieshouse',
    sourceId: company.number,
    kind: 'company_creation',
    title: `Création de ${company.name}`,
    date: company.incorporatedAt,
    url: `https://find-and-update.company-information.service.gov.uk/company/${company.number}`,
    country: 'GB',
    people,
    organizations: [{ name: company.name, role: 'company', kind: 'INDUSTRY' }],
    keywords: company.sicCodes,
    fingerprint: `crn:${company.number}`,
    extra: {
      companyNumber: company.number,
      companyName: company.name,
      nafCode: company.sicCodes[0] ?? '',
      incorporatedAt: company.incorporatedAt,
      legalForm: company.type,
      city: company.city,
    },
  });
}

/**
 * Fetch UK MedTech companies incorporated within the window.
 *
 * Returns `[]` with a warning when no key is configured — one unconfigured
 * source never aborts the run.
 *
 * @param {object} opts
 * @param {{ json: Function }} opts.http
 * @param {string} [opts.apiKey] COMPANIES_HOUSE_API_KEY
 * @param {number} [opts.maxOfficerLookups=60]
 * @returns {Promise<object[]>} `SourceRecord[]`
 */
export async function fetchCompanyCreations(opts) {
  const {
    http,
    apiKey,
    lookbackDays = 183,
    now = Date.now(),
    sicCodes = DEFAULT_SIC_CODES,
    size = 100,
    maxPages = 5,
    maxOfficerLookups = 60,
    logger = console,
  } = opts ?? {};

  if (!apiKey) {
    logger.warn?.('companieshouse: COMPANIES_HOUSE_API_KEY not set — skipping the UK registry.');
    return [];
  }

  const since = isoDaysAgo(lookbackDays, now);
  const until = isoDay(now);
  const headers = { authorization: authHeader(apiKey) };

  const companies = [];
  for (let page = 0; page < maxPages; page++) {
    const startIndex = page * size;
    const payload = await http.json(
      buildSearchUrl({ sicCodes, since, until, startIndex, size }),
      { headers, cacheSalt: `${startIndex}` }
    );
    const pageCompanies = parseCompanies(payload);
    companies.push(...pageCompanies);
    if (!pageCompanies.length || startIndex + size >= totalHits(payload)) break;
  }

  // Officers, newest incorporation first so the cap keeps the freshest ones —
  // those are what the 6-month rule is about.
  companies.sort((a, b) => (a.incorporatedAt < b.incorporatedAt ? 1 : -1));

  const records = [];
  for (const [index, company] of companies.entries()) {
    let people = [];
    if (index < maxOfficerLookups) {
      try {
        people = parseOfficers(await http.json(buildOfficersUrl(company.number), { headers }), company.name);
      } catch (err) {
        // A company whose officer list is unavailable is still a valid
        // incorporation signal — it just cannot be joined to a researcher.
        logger.warn?.(`companieshouse: officers unavailable for ${company.number} (${err.message})`);
      }
    }
    const record = toRecord(company, people);
    if (record) records.push(record);
  }
  return records;
}
