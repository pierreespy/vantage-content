// Vantage — Europe PMC connector.
//
// Europe PMC is queried ALONGSIDE PubMed rather than instead of it, because its
// `resultType=core` payload carries the two fields entity resolution most wants
// and E-utilities' esummary does not:
//
//   - ORCID iDs (`authorId: { type: "ORCID" }`) — an EXACT person identifier.
//     When present, resolve/match.mjs stops guessing entirely;
//   - per-author AFFILIATIONS — the tie-breaker for two researchers who share a
//     family name and an initial, and the link to an academic institution.
//
// It also indexes preprints (bioRxiv/medRxiv), which are earlier still. Overlap
// with PubMed is expected and harmless: both emit a record, and the resolver
// merges them on DOI/PMID.
//
// No API key, no registration. Paging uses `cursorMark`, not offsets.

import { makeRecord, normalizeOrcid } from '../lib/record.mjs';
import { isoDay, isoDaysAgo } from '../lib/dates.mjs';

export const HOST = 'www.ebi.ac.uk';
const BASE = `https://${HOST}/europepmc/webservices/rest/search`;

/** No published hard limit; 200ms is the polite pace for an unauthenticated caller. */
export const MIN_INTERVAL_MS = 200;

/** MedTech-leaning free-text query, mirroring the PubMed one. */
export const DEFAULT_QUERY = [
  '("medical device" OR "point-of-care" OR "digital health" OR biosensor',
  'OR wearable OR implantable OR "surgical robot" OR "in vitro diagnostic")',
].join(' ');

/** Europe PMC's Lucene-ish date filter on first publication date. */
function withDateRange(query, since, until) {
  return `(${query}) AND (FIRST_PDATE:[${since} TO ${until}])`;
}

/** Search URL for one page. `cursorMark` is `*` for the first page. */
export function buildSearchUrl(opts = {}) {
  const {
    query = DEFAULT_QUERY,
    since,
    until,
    pageSize = 100,
    cursorMark = '*',
  } = opts;

  const url = new URL(BASE);
  url.searchParams.set('query', since && until ? withDateRange(query, since, until) : query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('resultType', 'core'); // 'core' is what carries ORCID + affiliations
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('cursorMark', cursorMark);
  return url.toString();
}

/** Europe PMC wraps most repeated fields in a single-key object — unwrap defensively. */
function listOf(container, key) {
  const value = container?.[key];
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

/** One search page -> `SourceRecord[]`. Pure. */
export function parseSearchPage(payload) {
  const results = listOf(payload?.resultList, 'result');

  return results
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;

      const people = listOf(entry.authorList, 'author')
        .map((author) => {
          const name =
            author?.fullName ||
            [author?.firstName, author?.lastName].filter(Boolean).join(' ') ||
            author?.lastName;
          if (!name) return null;

          const orcid =
            author?.authorId?.type === 'ORCID' ? normalizeOrcid(author.authorId.value) : '';
          const affiliation =
            listOf(author?.authorAffiliationDetailsList, 'authorAffiliation')[0]?.affiliation ||
            author?.affiliation ||
            '';

          return {
            name,
            role: 'author',
            ...(orcid ? { orcid } : {}),
            ...(affiliation ? { affiliation } : {}),
          };
        })
        .filter(Boolean);

      // `id` is unique only within a source ("MED", "PPR" for preprints, "PMC"…),
      // so the pair is the stable key.
      const sourceId = `${entry.source ?? 'UNK'}:${entry.id ?? ''}`;
      const isPreprint = entry.source === 'PPR';

      return makeRecord({
        source: 'europepmc',
        sourceId,
        kind: 'publication',
        title: entry.title,
        date: entry.firstPublicationDate || entry.pubYear,
        url:
          entry.doi
            ? `https://doi.org/${entry.doi}`
            : `https://europepmc.org/article/${entry.source ?? 'MED'}/${entry.id ?? ''}`,
        people,
        organizations: entry.journalInfo?.journal?.title
          ? [{ name: entry.journalInfo.journal.title, role: 'affiliation' }]
          : [],
        keywords: listOf(entry.keywordList, 'keyword'),
        fingerprint: `epmc:${sourceId}`,
        extra: {
          ...(entry.pmid ? { pmid: String(entry.pmid) } : {}),
          ...(entry.doi ? { doi: String(entry.doi) } : {}),
          preprint: isPreprint,
        },
      });
    })
    .filter(Boolean);
}

/** Next cursor, or `''` when the page is the last one (Europe PMC echoes the cursor back). */
export function nextCursor(payload, currentCursor) {
  const next = payload?.nextCursorMark;
  return typeof next === 'string' && next && next !== currentCursor ? next : '';
}

/**
 * Fetch recent publications and preprints.
 *
 * @param {object} opts
 * @param {{ json: Function }} opts.http
 * @param {number} [opts.lookbackDays=30]
 * @param {number} [opts.maxPages=5]  hard stop, so a broad query cannot loop forever
 * @returns {Promise<object[]>} `SourceRecord[]`
 */
export async function fetchPublications(opts) {
  const {
    http,
    query = DEFAULT_QUERY,
    lookbackDays = 30,
    now = Date.now(),
    pageSize = 100,
    maxPages = 5,
  } = opts ?? {};

  const since = isoDaysAgo(lookbackDays, now);
  const until = isoDay(now);

  const records = [];
  let cursorMark = '*';
  for (let page = 0; page < maxPages && cursorMark; page++) {
    const payload = await http.json(buildSearchUrl({ query, since, until, pageSize, cursorMark }));
    const pageRecords = parseSearchPage(payload);
    records.push(...pageRecords);
    if (!pageRecords.length) break;
    cursorMark = nextCursor(payload, cursorMark);
  }
  return records;
}
