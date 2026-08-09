// Vantage — PubMed connector (NCBI E-utilities).
//
// Publications are the earliest signal there is: a team publishes years before it
// incorporates. What we actually want from PubMed is the AUTHOR LIST — it is one
// half of the high-priority join ("chercheur/auteur + brevet + société créée
// < 6 mois", see score.mjs).
//
// Two calls, as the E-utilities are designed: `esearch` returns PMIDs for a query
// restricted to a publication-date window, `esummary` turns a batch of PMIDs into
// metadata. We deliberately do NOT call `efetch`: the full XML is far heavier and
// its affiliation data is better obtained from Europe PMC (see europepmc.mjs),
// which also carries ORCIDs.
//
// Rate limit: 3 req/s anonymously, 10 req/s with an API key (NCBI_API_KEY). NCBI
// also asks every caller to identify itself via `tool` + `email`; both are sent.
// Exceeding the rate gets an IP banned, not throttled — hence lib/ratelimit.mjs.

import { makeRecord } from '../lib/record.mjs';
import { isoDay, isoDaysAgo } from '../lib/dates.mjs';

export const HOST = 'eutils.ncbi.nlm.nih.gov';
const BASE = `https://${HOST}/entrez/eutils`;

/** 3 req/s anonymous, 10 req/s with a key — the pacing lib/http.mjs applies. */
export const MIN_INTERVAL_MS = { anonymous: 334, withKey: 100 };

/** How many PMIDs `esummary` is asked for at once. NCBI's documented ceiling. */
const SUMMARY_BATCH = 200;

/**
 * Default MedTech-leaning query. The point of the pipeline is to rebalance
 * towards MedTech (docs/signals-plan.md), so the term mixes device/diagnostics/
 * digital-health MeSH headings with free-text hits, rather than the biotech
 * vocabulary that would otherwise dominate.
 */
export const DEFAULT_QUERY = [
  '("Equipment and Supplies"[MeSH Terms]',
  'OR "Biomedical Engineering"[MeSH Terms]',
  'OR "Medical Informatics"[MeSH Terms]',
  'OR "Biosensing Techniques"[MeSH Terms]',
  'OR "medical device"[Title/Abstract]',
  'OR "point-of-care"[Title/Abstract]',
  'OR "digital health"[Title/Abstract]',
  'OR "wearable"[Title/Abstract]',
  'OR "implantable"[Title/Abstract])',
].join(' ');

/** E-utilities want dates as `AAAA/MM/JJ`. */
function toEntrezDate(iso) {
  return iso.replace(/-/g, '/');
}

/** Shared identification + key params NCBI asks every client to send. */
function identityParams({ apiKey, tool, email }) {
  const params = { tool: tool || 'vantage-signals', email: email || '' };
  if (apiKey) params.api_key = apiKey;
  return params;
}

function buildUrl(path, params) {
  const url = new URL(`${BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** `esearch` URL for a publication-date window. */
export function buildSearchUrl(opts = {}) {
  const { query = DEFAULT_QUERY, since, until, retmax = 200, ...identity } = opts;
  return buildUrl('esearch.fcgi', {
    db: 'pubmed',
    term: query,
    retmode: 'json',
    retmax,
    sort: 'date',
    datetype: 'pdat',
    mindate: since ? toEntrezDate(since) : undefined,
    maxdate: until ? toEntrezDate(until) : undefined,
    ...identityParams(identity),
  });
}

/** `esummary` URL for a batch of PMIDs. */
export function buildSummaryUrl(pmids, opts = {}) {
  return buildUrl('esummary.fcgi', {
    db: 'pubmed',
    id: pmids.join(','),
    retmode: 'json',
    ...identityParams(opts),
  });
}

/** PMIDs out of an `esearch` payload. Pure — the unit tests feed it a fixture. */
export function parseSearch(payload) {
  const ids = payload?.esearchresult?.idlist;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [];
}

/**
 * `esummary` payload -> `SourceRecord[]`.
 *
 * E-utilities give author names in "Dupont JM" form; lib/normalize.mjs turns that
 * into the same key Europe PMC's "Jean-Marc Dupont" and EPO's "DUPONT JEAN-MARC"
 * produce, which is what lets the three sources join on a person.
 */
export function parseSummaries(payload) {
  const result = payload?.result;
  if (!result || typeof result !== 'object') return [];

  const uids = Array.isArray(result.uids) ? result.uids : [];
  return uids
    .map((uid) => {
      const entry = result[uid];
      if (!entry || typeof entry !== 'object') return null;

      const doi = (Array.isArray(entry.articleids) ? entry.articleids : []).find(
        (a) => a?.idtype === 'doi'
      )?.value;

      const people = (Array.isArray(entry.authors) ? entry.authors : [])
        .filter((a) => a?.authtype === 'Author' && a?.name)
        .map((a) => ({ name: a.name, role: 'author' }));

      return makeRecord({
        source: 'pubmed',
        sourceId: String(uid),
        kind: 'publication',
        title: entry.title,
        // `epubdate` (electronic publication) is the earlier of the two when
        // present — and earlier is the whole point of a weak signal.
        date: entry.epubdate || entry.pubdate,
        url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
        people,
        organizations: entry.fulljournalname
          ? [{ name: entry.fulljournalname, role: 'affiliation' }]
          : [],
        // A publication never changes once indexed: the PMID alone is the fingerprint.
        fingerprint: `pmid:${uid}`,
        extra: {
          journal: entry.fulljournalname || entry.source || '',
          ...(doi ? { doi: String(doi).replace(/^doi:\s*/i, '') } : {}),
        },
      });
    })
    .filter(Boolean);
}

/**
 * Fetch recent MedTech publications.
 *
 * @param {object} opts
 * @param {{ json: Function }} opts.http  the shared HTTP handle (injected — tests stub it)
 * @param {string} [opts.query]
 * @param {number} [opts.lookbackDays=30]
 * @param {string} [opts.now]             reference "today", ISO day
 * @param {string} [opts.apiKey]          NCBI_API_KEY
 * @returns {Promise<object[]>} `SourceRecord[]`
 */
export async function fetchPublications(opts) {
  const {
    http,
    query = DEFAULT_QUERY,
    lookbackDays = 30,
    now = Date.now(),
    retmax = 200,
    apiKey,
    tool,
    email,
  } = opts ?? {};

  const identity = { apiKey, tool, email };
  const searchPayload = await http.json(
    buildSearchUrl({ query, since: isoDaysAgo(lookbackDays, now), until: isoDay(now), retmax, ...identity })
  );

  const pmids = parseSearch(searchPayload);
  if (!pmids.length) return [];

  const records = [];
  for (let i = 0; i < pmids.length; i += SUMMARY_BATCH) {
    const batch = pmids.slice(i, i + SUMMARY_BATCH);
    const payload = await http.json(buildSummaryUrl(batch, identity));
    records.push(...parseSummaries(payload));
  }
  return records;
}
