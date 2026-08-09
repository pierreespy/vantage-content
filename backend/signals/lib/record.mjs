// Vantage — the one record shape every connector produces.
//
// Six sources, six wildly different payload formats (E-utilities JSON, Europe PMC
// JSON, EPO OPS's nested XML-as-JSON, ClinicalTrials.gov v2, grant CSVs, Pappers).
// They all flatten into ONE `SourceRecord` here, and everything downstream —
// diffing, entity resolution, scoring, the API — only ever sees this shape. Adding
// a seventh source means writing a parser to this contract and nothing else.
//
//   {
//     source: 'clinicaltrials', sourceId: 'NCT06123456',
//     kind: 'trial', title: '…', date: '2026-07-08', url: 'https://…',
//     country: 'FR',
//     people: [{ name, role, orcid?, affiliation? }],
//     organizations: [{ name, role, kind? }],
//     keywords: ['oncology', 'catheter'],
//     fingerprint: 'RECRUITING|2026-07-08',   // what "changed" means for this source
//     extra: { … }                            // source-specific, read by scoring
//   }

import { toIsoDay } from './dates.mjs';
import { normalizeCountry } from './normalize.mjs';

/** What a record IS. Drives scoring weights and the SignalType mapping. */
export const RECORD_KINDS = /** @type {const} */ ([
  'publication',
  'patent',
  'trial',
  'grant',
  'company_creation',
]);

// Roles a connector may set, for reference (they are plain strings on the record):
//   people        author · inventor · investigator · director · laureate
//                 — `author`, `inventor` and `director` are the three the
//                   high-priority rule joins on;
//   organizations affiliation · applicant · sponsor · collaborator · funder · company
//                 — `affiliation` is the odd one out: PubMed puts the JOURNAL
//                   there, so resolve/ deliberately excludes it from becoming a
//                   company entity.

const KIND_SET = new Set(RECORD_KINDS);

/** Trim, collapse whitespace, cap length — source titles can be enormous. */
function cleanText(value, maxLength = 400) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Build a validated `SourceRecord`, or `null` when it lacks what makes it usable.
 *
 * Returning `null` rather than throwing is deliberate: a single malformed row in
 * a 500-row API page must not sink the run. Connectors map then `.filter(Boolean)`.
 *
 * A record is unusable without a `source`, a stable `sourceId`, a known `kind`,
 * a title and a parseable date — a signal with no date cannot be scored, ordered
 * or windowed, and we never invent one.
 */
export function makeRecord(input) {
  if (!input || typeof input !== 'object') return null;

  const source = cleanText(input.source, 40);
  const sourceId = cleanText(input.sourceId, 120);
  const kind = cleanText(input.kind, 40);
  const title = cleanText(input.title);
  const date = toIsoDay(input.date);

  if (!source || !sourceId || !KIND_SET.has(kind) || !title || !date) return null;

  const people = (Array.isArray(input.people) ? input.people : [])
    .map((p) => {
      const name = cleanText(p?.name, 160);
      if (!name) return null;
      return {
        name,
        role: cleanText(p?.role, 40) || 'author',
        ...(p?.orcid ? { orcid: normalizeOrcid(p.orcid) } : {}),
        ...(p?.affiliation ? { affiliation: cleanText(p.affiliation, 240) } : {}),
      };
    })
    .filter(Boolean);

  const organizations = (Array.isArray(input.organizations) ? input.organizations : [])
    .map((o) => {
      const name = cleanText(o?.name, 200);
      if (!name) return null;
      return {
        name,
        role: cleanText(o?.role, 40) || 'affiliation',
        // `kind` distinguishes an INDUSTRY sponsor from an academic one — the
        // medium-priority rule ("essai sans structure commerciale") reads it.
        ...(o?.kind ? { kind: cleanText(o.kind, 40) } : {}),
      };
    })
    .filter(Boolean);

  const keywords = [
    ...new Set(
      (Array.isArray(input.keywords) ? input.keywords : [])
        .map((k) => cleanText(k, 80).toLowerCase())
        .filter(Boolean)
    ),
  ].slice(0, 40);

  return {
    source,
    sourceId,
    kind,
    title,
    date,
    url: typeof input.url === 'string' && /^https?:\/\//.test(input.url) ? input.url : '',
    country: normalizeCountry(input.country),
    people,
    organizations,
    keywords,
    // Default fingerprint = the date. Sources whose CHANGE is the signal (a trial
    // moving to "Recruiting") override this with the fields that must trigger a
    // re-emit; see lib/state.mjs.
    fingerprint: cleanText(input.fingerprint, 200) || date,
    extra: input.extra && typeof input.extra === 'object' ? input.extra : {},
  };
}

/** ORCID as bare `0000-0002-1825-0097`, or `''` when it is not one. */
export function normalizeOrcid(value) {
  const match = String(value ?? '').match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i);
  return match ? match[1].toUpperCase() : '';
}
