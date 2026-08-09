// node --test backend/signals/sources/grants.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGrants, getPath, loadFeeds, mapRows, parseCsv } from './grants.mjs';

const I_LAB_FEED = {
  id: 'i-lab',
  program: 'i-Lab',
  country: 'FR',
  format: 'csv',
  url: 'file:data/i-lab-laureates.csv',
  mapping: {
    id: 'id',
    title: 'projet',
    company: 'entreprise',
    people: 'laureats',
    date: 'date',
    keywords: 'thematique',
    amount: 'montant',
    url: 'url',
  },
};

test('parseCsv handles quotes, escaped quotes, embedded commas and CRLF', () => {
  const rows = parseCsv(
    'id,name,note\r\n' +
      '1,"Neuroscan, SAS","a ""quoted"" note"\r\n' +
      '2,Simple,plain\r\n'
  );
  assert.deepEqual(rows, [
    { id: '1', name: 'Neuroscan, SAS', note: 'a "quoted" note' },
    { id: '2', name: 'Simple', note: 'plain' },
  ]);
});

test('parseCsv handles a newline inside a quoted field', () => {
  const rows = parseCsv('id,desc\n1,"line one\nline two"\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].desc, 'line one\nline two');
});

test('parseCsv returns [] for an empty file or a header-only file', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('id,name\n'), []);
});

test('getPath reads dotted paths and never throws on a missing branch', () => {
  assert.equal(getPath({ a: { b: { c: 1 } } }, 'a.b.c'), 1);
  assert.equal(getPath({ a: {} }, 'a.b.c'), undefined);
  assert.equal(getPath(null, 'a'), undefined);
  assert.equal(getPath({ a: 1 }, ''), undefined);
});

test('mapRows turns a laureate row into a grant SourceRecord', () => {
  const [record] = mapRows(
    [
      {
        id: '2026-042',
        date: '2026-06-18',
        entreprise: 'Neuroscan Medical',
        projet: 'Capteur cardiaque implantable',
        laureats: 'Jean-Marc Dupont; Marie Lefevre',
        thematique: 'MedTech',
        montant: '600000',
        url: 'https://www.bpifrance.fr/laureats/2026-042',
      },
    ],
    I_LAB_FEED
  );

  assert.equal(record.source, 'grants');
  assert.equal(record.sourceId, 'i-lab:2026-042');
  assert.equal(record.kind, 'grant');
  assert.equal(record.date, '2026-06-18');
  assert.equal(record.country, 'FR', 'inherited from the feed');
  assert.equal(record.extra.program, 'i-Lab');
  assert.equal(record.extra.amount, '600000');
  assert.deepEqual(
    record.people.map((p) => `${p.name}|${p.role}`),
    ['Jean-Marc Dupont|laureate', 'Marie Lefevre|laureate']
  );
  assert.deepEqual(record.organizations, [{ name: 'Neuroscan Medical', role: 'company' }]);
});

test('a row with no title still gets a real headline built from the programme', () => {
  const [record] = mapRows([{ id: '7', date: '2026-06-01', entreprise: 'GlucoSense' }], I_LAB_FEED);
  assert.equal(record.title, 'GlucoSense — lauréat i-Lab');
});

test('rows without a usable date are dropped rather than dated by guesswork', () => {
  const records = mapRows([{ id: '8', entreprise: 'X', date: 'à venir' }], I_LAB_FEED);
  assert.deepEqual(records, []);
});

test('laureate names split on the separators these exports actually use', () => {
  const [record] = mapRows(
    [{ id: '9', date: '2026-06-01', entreprise: 'X', laureats: 'A Martin et B Durand' }],
    I_LAB_FEED
  );
  assert.deepEqual(record.people.map((p) => p.name), ['A Martin', 'B Durand']);
});

test('loadFeeds reads the shipped descriptors and applies URL overrides', async () => {
  const feeds = await loadFeeds({ overrides: { 'eic-accelerator': 'https://example.org/eic.json' } });
  const ids = feeds.map((f) => f.id);
  assert.deepEqual(ids, ['i-lab', 'i-phd', 'eic-accelerator']);
  assert.equal(feeds.find((f) => f.id === 'eic-accelerator').url, 'https://example.org/eic.json');
  assert.equal(feeds.find((f) => f.id === 'i-lab').url, 'file:data/i-lab-laureates.csv');
});

test('loadFeeds returns [] instead of throwing when the config is unreadable', async () => {
  assert.deepEqual(await loadFeeds({ file: '/nope/missing.json' }), []);
});

test('fetchGrants reads an http JSON feed and windows on the lookback', async () => {
  const feed = {
    id: 'eic-accelerator',
    program: 'EIC Accelerator',
    format: 'json',
    url: 'https://example.org/eic.json',
    rowsPath: 'results',
    mapping: { id: 'projectId', title: 'projectTitle', company: 'beneficiaryName', date: 'signatureDate', country: 'country' },
  };
  const http = {
    text: async () =>
      JSON.stringify({
        results: [
          { projectId: 'P1', projectTitle: 'Smart stent', beneficiaryName: 'CardiaFlow', signatureDate: '2026-06-01', country: 'DE' },
          { projectId: 'P0', projectTitle: 'Ancient', beneficiaryName: 'OldCo', signatureDate: '2024-01-01', country: 'DE' },
        ],
      }),
  };

  const records = await fetchGrants({ http, feeds: [feed], now: Date.parse('2026-08-09T00:00:00Z') });
  assert.equal(records.length, 1, 'the 2024 row is outside the 180-day window');
  assert.equal(records[0].sourceId, 'eic-accelerator:P1');
  assert.equal(records[0].country, 'DE');
});

test('a broken feed is skipped with a warning, the others still run', async () => {
  const warnings = [];
  const good = {
    id: 'ok',
    program: 'OK',
    format: 'json',
    url: 'https://example.org/ok.json',
    mapping: { id: 'id', company: 'name', date: 'date' },
  };
  const broken = { id: 'broken', program: 'B', format: 'json', url: 'https://example.org/broken.json', mapping: {} };

  const http = {
    text: async (url) => {
      if (url.includes('broken')) throw new Error('502');
      return JSON.stringify([{ id: '1', name: 'Fresh', date: '2026-08-01' }]);
    },
  };

  const records = await fetchGrants({
    http,
    feeds: [broken, good],
    now: Date.parse('2026-08-09T00:00:00Z'),
    logger: { warn: (m) => warnings.push(m) },
  });

  assert.equal(records.length, 1);
  assert.match(warnings[0], /feed "broken" skipped/);
});

test('the shipped file: feeds load and parse to zero rows out of the box', async () => {
  // They ship empty on purpose — none of the three programmes has a free public
  // JSON API, so the seeds are placeholders until a real export is configured.
  const records = await fetchGrants({ http: {}, now: Date.parse('2026-08-09T00:00:00Z') });
  assert.deepEqual(records, []);
});
