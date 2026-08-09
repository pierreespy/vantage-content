// node --test backend/signals/sources/europepmc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl, fetchPublications, nextCursor, parseSearchPage } from './europepmc.mjs';

/** Shape of a real `resultType=core` search page. */
const PAGE_FIXTURE = {
  hitCount: 2,
  nextCursorMark: 'AoIIP4AAAC',
  resultList: {
    result: [
      {
        id: '40112233',
        source: 'MED',
        pmid: '40112233',
        doi: '10.1038/s41551-026-01234-5',
        title: 'A miniaturised implantable sensor for continuous cardiac monitoring',
        firstPublicationDate: '2026-07-02',
        authorList: {
          author: [
            {
              fullName: 'Dupont Jean-Marc',
              firstName: 'Jean-Marc',
              lastName: 'Dupont',
              authorId: { type: 'ORCID', value: '0000-0002-1825-0097' },
              authorAffiliationDetailsList: {
                authorAffiliation: [{ affiliation: 'Institut Pasteur, Paris, France' }],
              },
            },
            { fullName: 'Leroy Anne' },
          ],
        },
        journalInfo: { journal: { title: 'Nature Biomedical Engineering' } },
        keywordList: { keyword: ['implantable sensor', 'cardiology'] },
      },
      {
        // Single-element lists arrive as bare objects, not arrays.
        id: 'PPR812345',
        source: 'PPR',
        title: 'Preprint: deep-learning triage of chest radiographs',
        firstPublicationDate: '2026-08-04',
        authorList: { author: { fullName: 'Okafor Chidi', affiliation: 'KCL, London, UK' } },
        keywordList: { keyword: 'radiology' },
      },
    ],
  },
};

test('buildSearchUrl asks for core results inside a date range', () => {
  const url = new URL(buildSearchUrl({ query: 'biosensor', since: '2026-07-10', until: '2026-08-09' }));
  assert.equal(url.searchParams.get('resultType'), 'core', 'core is what carries ORCID + affiliations');
  assert.match(url.searchParams.get('query'), /FIRST_PDATE:\[2026-07-10 TO 2026-08-09\]/);
  assert.equal(url.searchParams.get('cursorMark'), '*');
});

test('parseSearchPage extracts ORCID and affiliation — the resolver’s best evidence', () => {
  const [publication] = parseSearchPage(PAGE_FIXTURE);
  assert.equal(publication.source, 'europepmc');
  assert.equal(publication.sourceId, 'MED:40112233');
  assert.equal(publication.date, '2026-07-02');
  assert.equal(publication.url, 'https://doi.org/10.1038/s41551-026-01234-5');
  assert.deepEqual(publication.people[0], {
    name: 'Dupont Jean-Marc',
    role: 'author',
    orcid: '0000-0002-1825-0097',
    affiliation: 'Institut Pasteur, Paris, France',
  });
  assert.deepEqual(publication.people[1], { name: 'Leroy Anne', role: 'author' });
  assert.deepEqual(publication.keywords, ['implantable sensor', 'cardiology']);
});

test('a single-element author list arriving as a bare object is still parsed', () => {
  // Europe PMC collapses one-element lists; a naive .map() would throw here.
  const [, preprint] = parseSearchPage(PAGE_FIXTURE);
  assert.equal(preprint.people.length, 1);
  assert.equal(preprint.people[0].name, 'Okafor Chidi');
  assert.deepEqual(preprint.keywords, ['radiology']);
});

test('preprints are flagged and get an europepmc article url when there is no DOI', () => {
  const [, preprint] = parseSearchPage(PAGE_FIXTURE);
  assert.equal(preprint.extra.preprint, true);
  assert.equal(preprint.url, 'https://europepmc.org/article/PPR/PPR812345');
});

test('parseSearchPage tolerates an empty or malformed page', () => {
  assert.deepEqual(parseSearchPage({ resultList: { result: [] } }), []);
  assert.deepEqual(parseSearchPage({}), []);
  assert.deepEqual(parseSearchPage(null), []);
});

test('nextCursor stops when the cursor stops moving', () => {
  assert.equal(nextCursor({ nextCursorMark: 'B' }, 'A'), 'B');
  assert.equal(nextCursor({ nextCursorMark: 'A' }, 'A'), '', 'echoed cursor means last page');
  assert.equal(nextCursor({}, 'A'), '');
});

test('fetchPublications pages with the cursor and stops on an empty page', async () => {
  const urls = [];
  const http = {
    json: async (url) => {
      urls.push(url);
      return urls.length === 1 ? PAGE_FIXTURE : { resultList: { result: [] } };
    },
  };
  const records = await fetchPublications({ http, now: Date.parse('2026-08-09T00:00:00Z') });
  assert.equal(records.length, 2);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /cursorMark=AoIIP4AAAC/);
});
