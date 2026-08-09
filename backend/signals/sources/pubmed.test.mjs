// node --test backend/signals/sources/pubmed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchUrl,
  buildSummaryUrl,
  fetchPublications,
  parseSearch,
  parseSummaries,
} from './pubmed.mjs';

/** Shape of a real `esummary.fcgi?db=pubmed&retmode=json` payload. */
const SUMMARY_FIXTURE = {
  header: { type: 'esummary', version: '0.3' },
  result: {
    uids: ['40112233', '40112234'],
    40112233: {
      uid: '40112233',
      pubdate: '2026 Jul 8',
      epubdate: '2026 Jul 2',
      source: 'Nat Biomed Eng',
      fulljournalname: 'Nature Biomedical Engineering',
      authors: [
        { name: 'Dupont JM', authtype: 'Author' },
        { name: 'Leroy A', authtype: 'Author' },
        { name: 'CardioNext Consortium', authtype: 'CollectiveName' },
      ],
      title: 'A miniaturised implantable sensor for continuous cardiac monitoring',
      articleids: [
        { idtype: 'pubmed', value: '40112233' },
        { idtype: 'doi', value: '10.1038/s41551-026-01234-5' },
      ],
    },
    40112234: {
      uid: '40112234',
      pubdate: '2026 Aug 1',
      epubdate: '',
      fulljournalname: 'The Lancet Digital Health',
      authors: [{ name: 'Okafor C', authtype: 'Author' }],
      title: 'Point-of-care diagnostics in low-resource settings',
      articleids: [{ idtype: 'pubmed', value: '40112234' }],
    },
  },
};

test('buildSearchUrl windows on publication date and identifies the client', () => {
  const url = new URL(
    buildSearchUrl({ query: 'medical device', since: '2026-07-10', until: '2026-08-09', apiKey: 'K', email: 'a@b.c' })
  );
  assert.equal(url.searchParams.get('db'), 'pubmed');
  assert.equal(url.searchParams.get('datetype'), 'pdat');
  assert.equal(url.searchParams.get('mindate'), '2026/07/10', 'E-utilities want slashes');
  assert.equal(url.searchParams.get('maxdate'), '2026/08/09');
  assert.equal(url.searchParams.get('api_key'), 'K');
  assert.equal(url.searchParams.get('tool'), 'vantage-signals');
});

test('buildSearchUrl omits empty params rather than sending blanks', () => {
  const url = new URL(buildSearchUrl({ query: 'x' }));
  assert.equal(url.searchParams.has('mindate'), false);
  assert.equal(url.searchParams.has('api_key'), false);
});

test('parseSearch extracts the PMID list and survives an empty result', () => {
  assert.deepEqual(parseSearch({ esearchresult: { idlist: ['1', '2'] } }), ['1', '2']);
  assert.deepEqual(parseSearch({ esearchresult: { idlist: [] } }), []);
  assert.deepEqual(parseSearch({}), []);
  assert.deepEqual(parseSearch(null), []);
});

test('parseSummaries maps a real payload into SourceRecords', () => {
  const records = parseSummaries(SUMMARY_FIXTURE);
  assert.equal(records.length, 2);

  const [first] = records;
  assert.equal(first.source, 'pubmed');
  assert.equal(first.sourceId, '40112233');
  assert.equal(first.kind, 'publication');
  assert.equal(first.date, '2026-07-02', 'epubdate wins — earlier is the point of a weak signal');
  assert.equal(first.url, 'https://pubmed.ncbi.nlm.nih.gov/40112233/');
  assert.equal(first.extra.doi, '10.1038/s41551-026-01234-5');
  assert.equal(first.fingerprint, 'pmid:40112233');
});

test('parseSummaries keeps authors only — a collective name is not a person', () => {
  const [first] = parseSummaries(SUMMARY_FIXTURE);
  assert.deepEqual(
    first.people.map((p) => p.name),
    ['Dupont JM', 'Leroy A']
  );
  assert.ok(first.people.every((p) => p.role === 'author'));
});

test('parseSummaries falls back to pubdate when there is no epubdate', () => {
  const [, second] = parseSummaries(SUMMARY_FIXTURE);
  assert.equal(second.date, '2026-08-01');
});

test('parseSummaries drops malformed entries instead of throwing', () => {
  const records = parseSummaries({
    result: { uids: ['1', '2'], 1: { uid: '1' /* no title */ }, 2: null },
  });
  assert.deepEqual(records, []);
});

test('fetchPublications chains esearch then esummary', async () => {
  const urls = [];
  const http = {
    json: async (url) => {
      urls.push(url);
      return urls.length === 1 ? { esearchresult: { idlist: ['40112233', '40112234'] } } : SUMMARY_FIXTURE;
    },
  };

  const records = await fetchPublications({ http, now: Date.parse('2026-08-09T00:00:00Z') });
  assert.equal(records.length, 2);
  assert.match(urls[0], /esearch\.fcgi/);
  assert.match(urls[1], /esummary\.fcgi/);
  assert.match(urls[1], /id=40112233%2C40112234|id=40112233,40112234/);
});

test('fetchPublications short-circuits when the search is empty', async () => {
  let calls = 0;
  const http = {
    json: async () => {
      calls += 1;
      return { esearchresult: { idlist: [] } };
    },
  };
  assert.deepEqual(await fetchPublications({ http }), []);
  assert.equal(calls, 1, 'no esummary call for an empty PMID list');
});

test('buildSummaryUrl batches ids in one comma-separated call', () => {
  const url = new URL(buildSummaryUrl(['1', '2', '3']));
  assert.equal(url.searchParams.get('id'), '1,2,3');
});
