// Vantage — ClinicalTrials.gov v2 connector.
//
// Two distinct signals come out of this source:
//
//   1. a NEW trial registration, and
//   2. a STATUS CHANGE on a trial we already knew about (Not yet recruiting ->
//      Recruiting, or a completion). This is the case that justifies the whole
//      state+diffing design in docs/signals-plan.md: the record exists either way,
//      what carries information is that it MOVED. Hence `fingerprint`
//      = status + last-update date.
//
// It is also where the medium-priority rule reads its evidence. The v2 payload
// exposes `leadSponsor.class` (INDUSTRY / NIH / OTHER_GOV / OTHER / NETWORK), so
// "nouvel essai enregistré sans structure commerciale associée" is a fact from
// the API, not a guess: class !== INDUSTRY.
//
// Free, no key, no registration. Paging is `nextPageToken`.

import { makeRecord } from '../lib/record.mjs';
import { isoDay, isoDaysAgo } from '../lib/dates.mjs';
import { hasLegalForm } from '../lib/normalize.mjs';

export const HOST = 'clinicaltrials.gov';
const BASE = `https://${HOST}/api/v2/studies`;

/** No published limit; 250ms keeps us a well-behaved anonymous client. */
export const MIN_INTERVAL_MS = 250;

/** Sponsor classes that mean "a company is behind this". Everything else is academic/public. */
const COMMERCIAL_SPONSOR_CLASSES = new Set(['INDUSTRY']);

/** Device/diagnostic-leaning default, to serve the MedTech rebalancing. */
export const DEFAULT_QUERY = 'AREA[InterventionType](DEVICE OR DIAGNOSTIC_TEST)';

/**
 * Search URL for one page, filtered on **last update posted** (not first posted):
 * that window catches new registrations AND changes to existing ones in a single
 * query — which is exactly the pair of signals we want.
 */
export function buildSearchUrl(opts = {}) {
  const { query = DEFAULT_QUERY, since, until, pageSize = 100, pageToken = '' } = opts;

  const url = new URL(BASE);
  const filters = [];
  if (since) filters.push(`AREA[LastUpdatePostDate]RANGE[${since},${until || 'MAX'}]`);
  if (query) filters.push(query);
  if (filters.length) url.searchParams.set('filter.advanced', filters.join(' AND '));

  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('countTotal', 'false');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  return url.toString();
}

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/** One `/studies` page -> `SourceRecord[]`. Pure. */
export function parseStudies(payload) {
  return asArray(payload?.studies)
    .map((study) => {
      const protocol = study?.protocolSection;
      if (!protocol) return null;

      const identification = protocol.identificationModule ?? {};
      const status = protocol.statusModule ?? {};
      const sponsors = protocol.sponsorCollaboratorsModule ?? {};
      const design = protocol.designModule ?? {};
      const contacts = protocol.contactsLocationsModule ?? {};
      const conditions = protocol.conditionsModule ?? {};

      const nctId = identification.nctId;
      if (!nctId) return null;

      const leadSponsor = sponsors.leadSponsor ?? {};
      const sponsorClass = leadSponsor.class ?? '';
      // The declared class is the primary signal, but it is not always right:
      // live data has sponsors classed `OTHER` while named "VASCage GmbH". A
      // legal form in the name proves a company exists, and the medium-priority
      // rule is exactly about the ABSENCE of one — so trust the name too.
      const hasCommercialSponsor =
        COMMERCIAL_SPONSOR_CLASSES.has(sponsorClass) || hasLegalForm(leadSponsor.name ?? '');

      const organizations = [];
      if (leadSponsor.name) {
        organizations.push({ name: leadSponsor.name, role: 'sponsor', kind: sponsorClass || 'UNKNOWN' });
      }
      for (const collaborator of asArray(sponsors.collaborators)) {
        if (collaborator?.name) {
          organizations.push({
            name: collaborator.name,
            role: 'collaborator',
            kind: collaborator.class || 'UNKNOWN',
          });
        }
      }

      // Principal investigators are people we can join to publications and patents.
      const people = asArray(contacts.overallOfficials)
        .filter((official) => official?.name)
        .map((official) => ({
          name: official.name,
          role: 'investigator',
          ...(official.affiliation ? { affiliation: official.affiliation } : {}),
        }));

      // First location's country: trials are multi-site, and the first entry is
      // the sponsoring site often enough to be a useful default. `extra.countries`
      // keeps the full list for the API's country filter.
      const countries = [
        ...new Set(asArray(contacts.locations).map((l) => l?.country).filter(Boolean)),
      ];

      const overallStatus = status.overallStatus ?? '';
      const lastUpdate = status.lastUpdatePostDateStruct?.date ?? '';
      const firstPost = status.studyFirstPostDateStruct?.date ?? '';

      return makeRecord({
        source: 'clinicaltrials',
        sourceId: nctId,
        kind: 'trial',
        title: identification.briefTitle || identification.officialTitle,
        // The signal is dated by WHEN IT MOVED, so the lead is ordered by news value.
        date: lastUpdate || firstPost,
        url: `https://clinicaltrials.gov/study/${nctId}`,
        country: countries[0] ?? '',
        people,
        organizations,
        keywords: [...asArray(conditions.conditions), ...asArray(conditions.keywords)],
        // THE diffing key: a trial re-emits only when its status or its
        // last-update date actually moved.
        fingerprint: `${overallStatus}|${lastUpdate}`,
        extra: {
          overallStatus,
          phases: asArray(design.phases),
          sponsorClass,
          // Read by score.mjs for the medium-priority rule.
          hasCommercialSponsor,
          leadSponsor: leadSponsor.name ?? '',
          firstPostedAt: firstPost,
          lastUpdatedAt: lastUpdate,
          countries,
        },
      });
    })
    .filter(Boolean);
}

/**
 * Fetch trials registered or updated in the window.
 *
 * @param {object} opts
 * @param {{ json: Function }} opts.http
 * @param {number} [opts.lookbackDays=30]
 * @param {number} [opts.maxPages=5]
 * @returns {Promise<object[]>} `SourceRecord[]`
 */
export async function fetchTrials(opts) {
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
  let pageToken = '';
  for (let page = 0; page < maxPages; page++) {
    const payload = await http.json(buildSearchUrl({ query, since, until, pageSize, pageToken }));
    records.push(...parseStudies(payload));
    pageToken = typeof payload?.nextPageToken === 'string' ? payload.nextPageToken : '';
    if (!pageToken) break;
  }
  return records;
}
