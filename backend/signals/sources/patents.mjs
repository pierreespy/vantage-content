// Vantage — patent connector (EPO OPS / Espacenet).
//
// A filed patent is the second half of the high-priority join: a researcher who
// publishes AND files is a researcher who thinks there is a product. EPO Open
// Patent Services is the right source for a Europe-first fund — it is free
// (registration required), it covers EP + national offices via DOCDB, and its
// biblio search returns applicants and INVENTORS, which is what we join on.
//
// Two things make this connector the fiddliest of the six, both handled here:
//
//   1. OAuth2 client-credentials. Tokens last ~20 min; `createEpoAuth` caches one
//      in memory and renews it slightly early rather than re-authenticating per call.
//   2. OPS serves XML rendered as JSON. Any repeated element collapses to a bare
//      object when there is exactly one of it, and every leaf value hides under a
//      `$` key. `asArray` / `textOf` below exist solely to absorb that, because a
//      naive `payload.x.map()` breaks the day a search returns a single hit.
//
// Google Patents is NOT used as a fallback: it has no official public API, and
// scraping it would breach its terms — the same reason LinkedIn is excluded in
// docs/signals-plan.md.

import { makeRecord } from '../lib/record.mjs';
import { isoDay, isoDaysAgo } from '../lib/dates.mjs';
import { normalizeCompany } from '../lib/normalize.mjs';

export const HOST = 'ops.epo.org';
const BASE = `https://${HOST}/3.2`;

/** OPS meters aggressively by the minute on the free tier; 1s is the safe pace. */
export const MIN_INTERVAL_MS = 1000;

/** OPS refuses ranges wider than 100, and stops paging past 2000 results. */
const PAGE_SIZE = 100;
const MAX_RESULT_INDEX = 2000;

/** Renew the token this early, so a request never fires with a just-expired one. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

/**
 * IPC/CPC classes that define "MedTech" for this pipeline:
 *   A61B diagnosis & surgery · A61F prostheses · A61M devices delivering media
 *   A61N electrotherapy · G16H health informatics · C12Q in-vitro diagnostics
 */
export const DEFAULT_IPC_CLASSES = ['A61B', 'A61F', 'A61M', 'A61N', 'G16H', 'C12Q'];

/** OPS CQL. Dates are compact `AAAAMMJJ`; `within` is inclusive on both ends. */
export function buildQuery({ since, until, ipcClasses = DEFAULT_IPC_CLASSES }) {
  const classes = ipcClasses.map((c) => `ipc=${c}`).join(' or ');
  const window = `pd within "${since.replace(/-/g, '')} ${until.replace(/-/g, '')}"`;
  return classes ? `${window} and (${classes})` : window;
}

export function buildSearchUrl(query) {
  const url = new URL(`${BASE}/rest-services/published-data/search/biblio`);
  url.searchParams.set('q', query);
  return url.toString();
}

/**
 * Token provider with in-memory caching.
 *
 * @param {object} opts
 * @param {{ json: Function }} opts.http
 * @param {string} opts.key     EPO_OPS_KEY (consumer key)
 * @param {string} opts.secret  EPO_OPS_SECRET
 * @returns {() => Promise<string>} resolves to a currently-valid access token
 */
export function createEpoAuth(opts) {
  const { http, key, secret, now = () => Date.now() } = opts ?? {};
  let token = '';
  let expiresAt = 0;

  return async function getToken() {
    if (token && now() < expiresAt - TOKEN_SAFETY_MARGIN_MS) return token;

    const basic = Buffer.from(`${key}:${secret}`).toString('base64');
    const payload = await http.json(`${BASE}/auth/accesstoken`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      useCache: false, // never cache a credential
    });

    token = payload?.access_token ?? '';
    if (!token) throw new Error('EPO OPS: no access_token in the auth response');
    // `expires_in` comes back as a STRING of seconds in OPS responses.
    expiresAt = now() + (Number(payload.expires_in) || 1200) * 1000;
    return token;
  };
}

/** OPS collapses single-element lists into a bare object — always read through this. */
const asArray = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

/** OPS puts leaf text under `$`. Accepts a string, a `{$}`, or a list of either. */
function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') return typeof node.$ === 'string' ? node.$ : '';
  return String(node);
}

/**
 * Party names, de-duplicated across OPS's parallel `docdb` / `epodoc` renderings
 * of the same person or company (each party is listed once per format).
 */
function partyNames(container, listKey, itemKey) {
  const items = asArray(container?.[listKey]?.[itemKey]);
  const byKey = new Map();
  for (const item of items) {
    const name = textOf(item?.[`${itemKey}-name`]?.name);
    if (!name) continue;
    const dedupeKey = normalizeCompany(name);
    const format = item?.['@data-format'] ?? '';
    // Prefer the `epodoc` rendering: it is the normalized, human-facing spelling.
    if (!byKey.has(dedupeKey) || format === 'epodoc') byKey.set(dedupeKey, name);
  }
  return [...byKey.values()];
}

/** The `docdb` publication id — country + number + kind + date. */
function publicationId(biblio) {
  const ids = asArray(biblio?.['publication-reference']?.['document-id']);
  const preferred = ids.find((id) => id?.['@document-id-type'] === 'docdb') ?? ids[0] ?? {};
  return {
    country: textOf(preferred.country),
    docNumber: textOf(preferred['doc-number']),
    kind: textOf(preferred.kind),
    date: textOf(preferred.date),
  };
}

/**
 * IPC classes as clean `A61B5/00` strings.
 *
 * OPS serves them padded to fixed columns with a version block appended:
 * `"A61B  5/00        20060101AFI20260715BHEP"`. Cutting at the first run of
 * spaces would drop the subgroup and leave a useless bare `A61B`, so the version
 * block (a run of whitespace followed by 8 digits) is stripped first.
 */
function ipcClasses(biblio) {
  return asArray(biblio?.['classifications-ipcr']?.['classification-ipcr'])
    .map((c) =>
      textOf(c?.text)
        .replace(/\s+\d{8}.*$/, '')
        .replace(/\s+/g, '')
    )
    .filter(Boolean);
}

/** One OPS biblio-search payload -> `SourceRecord[]`. Pure. */
export function parseSearchResult(payload) {
  const search = payload?.['ops:world-patent-data']?.['ops:biblio-search'];
  const documents = asArray(search?.['ops:search-result']?.['exchange-documents']).flatMap((entry) =>
    asArray(entry?.['exchange-document'] ?? entry)
  );

  return documents
    .map((doc) => {
      const biblio = doc?.['bibliographic-data'];
      if (!biblio) return null;

      const { country, docNumber, kind, date } = publicationId(biblio);
      const publicationNumber = `${country}${docNumber}${kind}`;
      if (!country || !docNumber) return null;

      // Titles come as a list of {@lang, $}; English first, else whatever exists.
      const titles = asArray(biblio['invention-title']);
      const title =
        textOf(titles.find((t) => t?.['@lang'] === 'en')) || textOf(titles[0]);

      const parties = biblio.parties ?? {};
      const inventors = partyNames(parties, 'inventors', 'inventor');
      const applicants = partyNames(parties, 'applicants', 'applicant');

      return makeRecord({
        source: 'epo',
        sourceId: publicationNumber,
        kind: 'patent',
        title,
        date,
        url: `https://worldwide.espacenet.com/patent/search?q=pn%3D${encodeURIComponent(publicationNumber)}`,
        country,
        people: inventors.map((name) => ({ name, role: 'inventor' })),
        organizations: applicants.map((name) => ({ name, role: 'applicant' })),
        keywords: ipcClasses(biblio),
        // A publication number is immutable once issued.
        fingerprint: `pn:${publicationNumber}`,
        extra: {
          publicationNumber,
          kindCode: kind,
          familyId: doc['@family-id'] ?? '',
          applicants,
          inventors,
        },
      });
    })
    .filter(Boolean);
}

/** Total hits advertised by OPS, used to stop paging. */
export function totalResultCount(payload) {
  const raw = payload?.['ops:world-patent-data']?.['ops:biblio-search']?.['@total-result-count'];
  const total = Number(raw);
  return Number.isFinite(total) ? total : 0;
}

/**
 * Fetch recently published MedTech patents.
 *
 * Returns `[]` (with a warning) when credentials are missing, rather than
 * throwing: one unconfigured source must never abort a whole pipeline run.
 *
 * @param {object} opts
 * @param {{ json: Function }} opts.http
 * @param {string} [opts.key] / @param {string} [opts.secret]  EPO OPS credentials
 * @param {number} [opts.lookbackDays=30]
 * @returns {Promise<object[]>} `SourceRecord[]`
 */
export async function fetchPatents(opts) {
  const {
    http,
    key,
    secret,
    lookbackDays = 30,
    now = Date.now(),
    ipcClasses: classes = DEFAULT_IPC_CLASSES,
    maxPages = 5,
    getToken = key && secret ? createEpoAuth({ http, key, secret }) : null,
    logger = console,
  } = opts ?? {};

  if (!getToken) {
    logger.warn?.('epo: EPO_OPS_KEY / EPO_OPS_SECRET not set — skipping the patent source.');
    return [];
  }

  const query = buildQuery({
    since: isoDaysAgo(lookbackDays, now),
    until: isoDay(now),
    ipcClasses: classes,
  });
  const url = buildSearchUrl(query);
  const token = await getToken();

  const records = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * PAGE_SIZE + 1;
    if (from > MAX_RESULT_INDEX) break;
    const to = Math.min(from + PAGE_SIZE - 1, MAX_RESULT_INDEX);

    const payload = await http.json(url, {
      headers: { authorization: `Bearer ${token}`, range: `${from}-${to}` },
      // The URL is identical across pages — only the Range header moves.
      cacheSalt: `${from}-${to}`,
    });

    const pageRecords = parseSearchResult(payload);
    records.push(...pageRecords);
    if (!pageRecords.length || to >= Math.min(totalResultCount(payload), MAX_RESULT_INDEX)) break;
  }
  return records;
}
