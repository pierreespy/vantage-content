// node --test backend/signals/api/query.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryError, matchesFilters, parseQueryParams, queryLeads } from './query.mjs';

/** Minimal lead, in the shape leads.mjs publishes. */
function lead(overrides) {
  return {
    id: 'person:a',
    kind: 'person',
    name: 'Jean-Marc Dupont',
    aliases: ['Dupont JM'],
    company: 'Neuroscan Medical',
    companies: ['Neuroscan Medical'],
    country: 'FR',
    countries: ['FR'],
    score: 85,
    priority: 'high',
    rules: ['researcher_patent_newco'],
    reasons: [],
    signals: [{ signalType: 'patent_filing', title: 'Implantable cardiac sensor', source: 'epo', date: '2026-05-15' }],
    keywords: ['implantable sensor'],
    latestEvidence: '2026-06-14',
    updatedAt: '2026-08-09',
    ...overrides,
  };
}

const LEADS = [
  lead({ id: 'a', score: 85, country: 'FR', countries: ['FR'], latestEvidence: '2026-06-14' }),
  lead({
    id: 'b',
    name: 'Marie Lefevre',
    aliases: [],
    company: 'GlucoSense',
    companies: ['GlucoSense'],
    score: 60,
    priority: 'medium',
    country: 'DE',
    countries: ['DE'],
    keywords: ['glucose'],
    signals: [{ signalType: 'clinical_update', title: 'Wearable glucose sensor', source: 'clinicaltrials', date: '2026-08-05' }],
    latestEvidence: '2026-08-05',
  }),
  lead({
    id: 'c',
    name: 'Chidi Okafor',
    aliases: [],
    company: '',
    companies: [],
    score: 30,
    priority: 'low',
    country: 'GB',
    countries: ['GB', 'FR'],
    keywords: ['radiology'],
    signals: [{ signalType: 'publication_preprint', title: 'Chest radiograph triage', source: 'pubmed', date: '2026-08-04' }],
    latestEvidence: '2026-08-04',
  }),
];

test('defaults: everything, newest-scoring first, page 1 of 25', () => {
  const result = queryLeads(LEADS, {});
  assert.equal(result.total, 3);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 25);
  assert.equal(result.totalPages, 1);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.items.map((l) => l.id), ['a', 'b', 'c']);
});

test('min_score filters, in French and English spellings alike', () => {
  assert.equal(queryLeads(LEADS, { min_score: '80' }).total, 1);
  assert.equal(queryLeads(LEADS, { minScore: '50' }).total, 2);
  assert.equal(queryLeads(LEADS, new URLSearchParams('min_score=50')).total, 2);
});

test('country filter accepts `pays`, a list, and any of a lead’s countries', () => {
  assert.deepEqual(queryLeads(LEADS, { pays: 'FR' }).items.map((l) => l.id), ['a', 'c']);
  assert.deepEqual(queryLeads(LEADS, { country: 'de,gb' }).items.map((l) => l.id), ['b', 'c']);
  assert.equal(queryLeads(LEADS, { country: 'IT' }).total, 0);
});

test('keywords search names, companies, keywords and signal titles', () => {
  assert.deepEqual(queryLeads(LEADS, { keywords: 'glucose' }).items.map((l) => l.id), ['b']);
  assert.deepEqual(queryLeads(LEADS, { mots_cles: 'neuroscan' }).items.map((l) => l.id), ['a']);
  assert.deepEqual(queryLeads(LEADS, { q: 'radiograph' }).items.map((l) => l.id), ['c']);
  assert.deepEqual(queryLeads(LEADS, { keywords: 'dupont' }).items.map((l) => l.id), ['a'], 'matches an alias');
});

test('multiple keywords narrow by default, and widen with match=any', () => {
  assert.equal(queryLeads(LEADS, { keywords: 'glucose,neuroscan' }).total, 0, 'AND is the default');
  assert.equal(queryLeads(LEADS, { keywords: 'glucose,neuroscan', match: 'any' }).total, 2);
});

test('date range filters on the most recent evidence', () => {
  assert.deepEqual(queryLeads(LEADS, { date_from: '2026-08-01' }).items.map((l) => l.id), ['b', 'c']);
  assert.deepEqual(queryLeads(LEADS, { date_to: '2026-07-01' }).items.map((l) => l.id), ['a']);
  assert.equal(queryLeads(LEADS, { date_from: '2026-08-01', date_to: '2026-08-04' }).total, 1);
  assert.equal(queryLeads(LEADS, { date_debut: '2026-08-05' }).total, 1, 'French spelling');
});

test('priority and sort are supported', () => {
  assert.deepEqual(queryLeads(LEADS, { priority: 'high' }).items.map((l) => l.id), ['a']);
  assert.deepEqual(queryLeads(LEADS, { sort: 'date' }).items.map((l) => l.id), ['b', 'c', 'a']);
  assert.deepEqual(queryLeads(LEADS, { sort: 'name' }).items.map((l) => l.id), ['c', 'a', 'b']);
});

test('pagination reports total, totalPages and hasMore correctly', () => {
  const first = queryLeads(LEADS, { page_size: '2' });
  assert.deepEqual(first.items.map((l) => l.id), ['a', 'b']);
  assert.equal(first.total, 3);
  assert.equal(first.totalPages, 2);
  assert.equal(first.hasMore, true);

  const second = queryLeads(LEADS, { page: '2', page_size: '2' });
  assert.deepEqual(second.items.map((l) => l.id), ['c']);
  assert.equal(second.hasMore, false);

  const past = queryLeads(LEADS, { page: '9', page_size: '2' });
  assert.deepEqual(past.items, [], 'a page past the end is empty, not an error');
});

test('the response echoes the filters back, so a cached page is self-describing', () => {
  const result = queryLeads(LEADS, { min_score: '50', pays: 'fr', keywords: 'sensor' }, { generatedAt: '2026-08-09' });
  assert.equal(result.generatedAt, '2026-08-09');
  assert.deepEqual(result.filters.country, ['FR']);
  assert.deepEqual(result.filters.keywords, ['sensor']);
  assert.equal(result.filters.min_score, 50);
});

test('invalid parameters raise QueryError rather than being silently ignored', () => {
  // A typo in min_score must fail loudly, not quietly return everything.
  const bad = [
    { min_score: 'beaucoup' },
    { min_score: '101' },
    { min_score: '-1' },
    { page: '0' },
    { page_size: '500' },
    { date_from: '09/08/2026' },
    { date_from: '2026-08-09', date_to: '2026-08-01' },
    { priority: 'urgent' },
    { sort: 'random' },
    { match: 'maybe' },
  ];
  for (const params of bad) {
    assert.throws(() => parseQueryParams(params), QueryError, JSON.stringify(params));
  }
});

test('QueryError carries the HTTP status the endpoint should answer with', () => {
  try {
    parseQueryParams({ min_score: 'x' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.status, 400);
    assert.match(err.message, /min_score/);
  }
});

test('queryLeads accepts an already-parsed filter set without re-parsing', () => {
  const filters = parseQueryParams({ min_score: '50' });
  assert.equal(queryLeads(LEADS, filters).total, 2);
});

test('matchesFilters is exported so each rule can be pinned on its own', () => {
  const filters = parseQueryParams({ min_score: '80' });
  assert.equal(matchesFilters(LEADS[0], filters), true);
  assert.equal(matchesFilters(LEADS[1], filters), false);
});

test('an empty lead list is a valid, empty response', () => {
  const result = queryLeads([], { min_score: '10' });
  assert.equal(result.total, 0);
  assert.equal(result.totalPages, 1);
  assert.deepEqual(result.items, []);
});
