// node --test backend/signals/sources/patents.test.mjs
//
// EPO OPS serves XML rendered as JSON: single elements collapse to bare objects
// and every leaf hides under `$`. These tests pin that the parser absorbs both,
// because the day a search returns exactly one hit is the day a naive parser breaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuery,
  createEpoAuth,
  fetchPatents,
  parseSearchResult,
  totalResultCount,
} from './patents.mjs';

const SEARCH_FIXTURE = {
  'ops:world-patent-data': {
    'ops:biblio-search': {
      '@total-result-count': '2',
      'ops:search-result': {
        'exchange-documents': [
          {
            'exchange-document': {
              '@family-id': '75123456',
              'bibliographic-data': {
                'publication-reference': {
                  'document-id': [
                    {
                      '@document-id-type': 'docdb',
                      country: { $: 'EP' },
                      'doc-number': { $: '4123456' },
                      kind: { $: 'A1' },
                      date: { $: '20260715' },
                    },
                  ],
                },
                'invention-title': [
                  { '@lang': 'de', $: 'Implantierbarer Herzsensor' },
                  { '@lang': 'en', $: 'Implantable cardiac sensor' },
                ],
                parties: {
                  applicants: {
                    applicant: [
                      { '@data-format': 'docdb', 'applicant-name': { name: { $: 'NEUROSCAN MEDICAL SAS' } } },
                      { '@data-format': 'epodoc', 'applicant-name': { name: { $: 'Neuroscan Medical' } } },
                    ],
                  },
                  inventors: {
                    // Single inventor: OPS emits a bare object, not an array.
                    inventor: { '@data-format': 'epodoc', 'inventor-name': { name: { $: 'DUPONT JEAN-MARC [FR]' } } },
                  },
                },
                'classifications-ipcr': {
                  'classification-ipcr': { text: { $: 'A61B  5/00        20060101AFI20260715BHEP' } },
                },
              },
            },
          },
          {
            'exchange-document': {
              'bibliographic-data': {
                'publication-reference': {
                  'document-id': {
                    '@document-id-type': 'docdb',
                    country: { $: 'FR' },
                    'doc-number': { $: '3098765' },
                    kind: { $: 'A1' },
                    date: { $: '20260722' },
                  },
                },
                'invention-title': { '@lang': 'fr', $: 'Dispositif de mesure glycémique' },
                parties: {
                  applicants: { applicant: { 'applicant-name': { name: { $: 'GlucoSense' } } } },
                  inventors: { inventor: { 'inventor-name': { name: { $: 'LEFEVRE MARIE' } } } },
                },
              },
            },
          },
        ],
      },
    },
  },
};

test('buildQuery windows on publication date with compact dates', () => {
  const query = buildQuery({ since: '2026-07-10', until: '2026-08-09', ipcClasses: ['A61B', 'G16H'] });
  assert.match(query, /pd within "20260710 20260809"/);
  assert.match(query, /\(ipc=A61B or ipc=G16H\)/);
});

test('parseSearchResult reads the docdb publication id and the English title', () => {
  const [patent] = parseSearchResult(SEARCH_FIXTURE);
  assert.equal(patent.source, 'epo');
  assert.equal(patent.sourceId, 'EP4123456A1');
  assert.equal(patent.kind, 'patent');
  assert.equal(patent.title, 'Implantable cardiac sensor', 'English preferred over German');
  assert.equal(patent.date, '2026-07-15', 'compact 20260715 parsed');
  assert.equal(patent.country, 'EP');
  assert.equal(patent.extra.familyId, '75123456');
});

test('duplicate docdb/epodoc renderings of one applicant collapse to a single name', () => {
  const [patent] = parseSearchResult(SEARCH_FIXTURE);
  assert.deepEqual(patent.organizations, [{ name: 'Neuroscan Medical', role: 'applicant' }]);
});

test('a lone inventor arriving as a bare object is parsed, with its country tag kept', () => {
  const [patent] = parseSearchResult(SEARCH_FIXTURE);
  assert.deepEqual(patent.people, [{ name: 'DUPONT JEAN-MARC [FR]', role: 'inventor' }]);
});

test('the second document — bare document-id and bare title — parses too', () => {
  const [, patent] = parseSearchResult(SEARCH_FIXTURE);
  assert.equal(patent.sourceId, 'FR3098765A1');
  assert.equal(patent.title, 'Dispositif de mesure glycémique');
  assert.deepEqual(patent.people, [{ name: 'LEFEVRE MARIE', role: 'inventor' }]);
});

test('IPC classes are cleaned of OPS layout padding', () => {
  const [patent] = parseSearchResult(SEARCH_FIXTURE);
  assert.deepEqual(patent.keywords, ['a61b5/00']);
});

test('parseSearchResult and totalResultCount survive an empty or broken envelope', () => {
  assert.deepEqual(parseSearchResult({}), []);
  assert.deepEqual(parseSearchResult(null), []);
  assert.equal(totalResultCount({}), 0);
  assert.equal(totalResultCount(SEARCH_FIXTURE), 2);
});

test('createEpoAuth caches the token and renews it only when it nears expiry', async () => {
  let calls = 0;
  let time = 0;
  const http = {
    json: async () => {
      calls += 1;
      return { access_token: `tok${calls}`, expires_in: '1200' }; // OPS returns a STRING
    },
  };
  const getToken = createEpoAuth({ http, key: 'k', secret: 's', now: () => time });

  assert.equal(await getToken(), 'tok1');
  assert.equal(await getToken(), 'tok1', 'still cached');
  assert.equal(calls, 1);

  time = 1_200_000; // past expiry
  assert.equal(await getToken(), 'tok2');
  assert.equal(calls, 2);
});

test('createEpoAuth fails loudly when the auth response has no token', async () => {
  const getToken = createEpoAuth({ http: { json: async () => ({}) }, key: 'k', secret: 's' });
  await assert.rejects(getToken(), /no access_token/);
});

test('fetchPatents skips the source (does not throw) when credentials are missing', async () => {
  const warnings = [];
  const records = await fetchPatents({ http: {}, logger: { warn: (m) => warnings.push(m) } });
  assert.deepEqual(records, []);
  assert.match(warnings[0], /EPO_OPS_KEY/);
});

test('fetchPatents pages via the Range header and salts the cache key', async () => {
  const calls = [];
  const http = {
    json: async (url, options) => {
      calls.push(options);
      return calls.length === 1 ? SEARCH_FIXTURE : { 'ops:world-patent-data': {} };
    },
  };
  const records = await fetchPatents({
    http,
    getToken: async () => 'tok',
    now: Date.parse('2026-08-09T00:00:00Z'),
  });

  assert.equal(records.length, 2);
  assert.equal(calls[0].headers.range, '1-100');
  assert.equal(calls[0].headers.authorization, 'Bearer tok');
  assert.equal(calls[0].cacheSalt, '1-100', 'without this, page 2 would reuse page 1’s cached body');
});
