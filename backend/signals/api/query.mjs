// Vantage — the leads query: filtering, sorting, pagination.
//
// Deliberately PURE and transport-free. The same function backs all three ways
// the leads are exposed, so the filtering semantics can never drift between them:
//
//   - `api/serve.mjs`   GET /api/medtech/leads?…    (HTTP, node:http, zero deps)
//   - `publish.mjs`     the static medtech-leads.json the app fetches
//   - the test suite, which exercises it directly
//
// Parameter names are accepted in French and English (`pays` / `country`,
// `mots_cles` / `keywords`), because the brief and the project speak French while
// the code and the JSON contract are in English.

/** A bad request — carries the HTTP status the server should answer with. */
export class QueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueryError';
    this.status = 400;
  }
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * Brands the output of `parseQueryParams` so `queryLeads` can tell an
 * already-parsed filter set from raw params. A duck-type check cannot: the
 * English alias `minScore` is ALSO a raw parameter spelling, so `'minScore' in
 * params` matched raw input and skipped validation entirely.
 */
const PARSED = Symbol('vantage.parsedQueryParams');

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITIES = new Set(['high', 'medium', 'low']);
const SORTS = new Set(['score', 'date', 'name']);

/** First non-empty value among several accepted spellings of one parameter. */
function pick(params, ...names) {
  for (const name of names) {
    const value = params.get ? params.get(name) : params[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function toInt(raw, { name, min, max, fallback }) {
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new QueryError(`\`${name}\` doit être un entier (reçu « ${raw} »).`);
  }
  if (value < min || value > max) {
    throw new QueryError(`\`${name}\` doit être compris entre ${min} et ${max} (reçu ${value}).`);
  }
  return value;
}

function toIsoDayParam(raw, name) {
  if (raw === '') return '';
  if (!ISO_DAY.test(raw)) {
    throw new QueryError(`\`${name}\` doit être une date ISO AAAA-MM-JJ (reçu « ${raw} »).`);
  }
  return raw;
}

function toList(raw) {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Validate and normalize raw query parameters.
 *
 * @param {URLSearchParams|Record<string, string>} params
 * @returns {object} the normalized filter set
 * @throws {QueryError} on any invalid value — never silently ignored, so a typo
 *   in `min_score` fails loudly instead of quietly returning everything.
 */
export function parseQueryParams(params = new URLSearchParams()) {
  const minScore = toInt(pick(params, 'min_score', 'minScore', 'score_min'), {
    name: 'min_score',
    min: 0,
    max: 100,
    fallback: 0,
  });

  const page = toInt(pick(params, 'page'), { name: 'page', min: 1, max: 10_000, fallback: 1 });
  const pageSize = toInt(pick(params, 'page_size', 'pageSize', 'par_page'), {
    name: 'page_size',
    min: 1,
    max: MAX_PAGE_SIZE,
    fallback: DEFAULT_PAGE_SIZE,
  });

  const dateFrom = toIsoDayParam(pick(params, 'date_from', 'dateFrom', 'date_debut'), 'date_from');
  const dateTo = toIsoDayParam(pick(params, 'date_to', 'dateTo', 'date_fin'), 'date_to');
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new QueryError('`date_from` doit précéder `date_to`.');
  }

  const priority = pick(params, 'priority', 'priorite');
  if (priority && !PRIORITIES.has(priority)) {
    throw new QueryError(`\`priority\` doit valoir ${[...PRIORITIES].join(', ')} (reçu « ${priority} »).`);
  }

  const sort = pick(params, 'sort') || 'score';
  if (!SORTS.has(sort)) {
    throw new QueryError(`\`sort\` doit valoir ${[...SORTS].join(', ')} (reçu « ${sort} »).`);
  }

  const match = pick(params, 'match') || 'all';
  if (match !== 'all' && match !== 'any') {
    throw new QueryError('`match` doit valoir `all` ou `any`.');
  }

  return {
    [PARSED]: true,
    minScore,
    // Countries are compared upper-cased; callers may pass "fr" or "FR".
    countries: toList(pick(params, 'country', 'pays', 'countries')).map((c) => c.toUpperCase()),
    keywords: toList(pick(params, 'keywords', 'mots_cles', 'mots-cles', 'q')).map((k) => k.toLowerCase()),
    match,
    dateFrom,
    dateTo,
    priority,
    sort,
    page,
    pageSize,
  };
}

/** Everything about a lead a keyword can match, lower-cased once per lead. */
function searchableText(lead) {
  return [
    lead.name,
    lead.company,
    ...(lead.aliases ?? []),
    ...(lead.companies ?? []),
    ...(lead.keywords ?? []),
    ...(lead.signals ?? []).map((signal) => signal.title),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** The date a lead is filtered on: its most recent piece of evidence. */
function leadDate(lead) {
  return lead.latestEvidence || lead.updatedAt || '';
}

/** Does one lead pass the filters? Exported so tests can pin each rule. */
export function matchesFilters(lead, filters) {
  if (lead.score < filters.minScore) return false;
  if (filters.priority && lead.priority !== filters.priority) return false;

  if (filters.countries.length) {
    const leadCountries = (lead.countries?.length ? lead.countries : [lead.country]).filter(Boolean);
    if (!leadCountries.some((country) => filters.countries.includes(String(country).toUpperCase()))) {
      return false;
    }
  }

  if (filters.dateFrom || filters.dateTo) {
    const date = leadDate(lead);
    if (!date) return false;
    if (filters.dateFrom && date < filters.dateFrom) return false;
    if (filters.dateTo && date > filters.dateTo) return false;
  }

  if (filters.keywords.length) {
    const haystack = searchableText(lead);
    const test = (keyword) => haystack.includes(keyword);
    // `all` narrows (the default: adding a word should reduce the result set),
    // `any` widens.
    if (filters.match === 'all' ? !filters.keywords.every(test) : !filters.keywords.some(test)) {
      return false;
    }
  }

  return true;
}

/** Comparator for the requested sort. Ties always break on id, for determinism. */
function comparatorFor(sort) {
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (sort === 'date') {
    return (a, b) => (leadDate(a) < leadDate(b) ? 1 : leadDate(a) > leadDate(b) ? -1 : byId(a, b));
  }
  if (sort === 'name') {
    return (a, b) => String(a.name).localeCompare(String(b.name), 'fr') || byId(a, b);
  }
  return (a, b) =>
    b.score - a.score || (leadDate(a) < leadDate(b) ? 1 : leadDate(a) > leadDate(b) ? -1 : byId(a, b));
}

/**
 * Filter, sort and paginate leads.
 *
 * @param {object[]} leads
 * @param {URLSearchParams|Record<string, string>|object} params raw or already-parsed
 * @param {object} [meta] `{ generatedAt }` echoed into the response
 * @returns {object} the paginated response body
 */
export function queryLeads(leads = [], params = {}, meta = {}) {
  // Accept an already-parsed filter set (the server parses once, then reuses it).
  const filters = params?.[PARSED] ? params : parseQueryParams(params);

  const matched = leads.filter((lead) => matchesFilters(lead, filters));
  matched.sort(comparatorFor(filters.sort));

  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  const start = (filters.page - 1) * filters.pageSize;
  const items = matched.slice(start, start + filters.pageSize);

  return {
    generatedAt: meta.generatedAt ?? '',
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages,
    hasMore: filters.page < totalPages,
    // Echo the filters back: a paginated client needs to know what it asked for,
    // and it makes a cached response self-describing.
    filters: {
      min_score: filters.minScore,
      country: filters.countries,
      keywords: filters.keywords,
      match: filters.match,
      date_from: filters.dateFrom,
      date_to: filters.dateTo,
      priority: filters.priority,
      sort: filters.sort,
    },
    items,
  };
}
