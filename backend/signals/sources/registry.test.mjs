// node --test backend/signals/sources/registry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl, fetchCompanyCreations, parseSearchPage } from './registry.mjs';

/** Shape of a real Pappers `/v2/recherche` page. */
const PAGE_FIXTURE = {
  total: 2,
  page: 1,
  par_page: 100,
  resultats: [
    {
      siren: '987654321',
      nom_entreprise: 'NEUROSCAN MEDICAL',
      denomination: 'NEUROSCAN MEDICAL',
      date_creation: '2026-05-14',
      code_naf: '2660Z',
      libelle_code_naf: "Fabrication d'équipements d'irradiation médicale",
      objet_social: 'Conception de capteurs cardiaques implantables',
      siege: { ville: 'Bordeaux', code_postal: '33000', pays_code: 'FR' },
      representants: [
        { nom: 'Dupont', prenom: 'Jean-Marc', nom_complet: 'Jean-Marc Dupont', qualite: 'Président' },
        { nom: 'Lefevre', prenom: 'Marie', qualite: 'Directrice générale' },
      ],
    },
    {
      siren: '123456789',
      denomination: 'GLUCOSENSE',
      date_creation: '2026-07-02',
      code_naf: '7211Z',
      libelle_code_naf: 'Recherche-développement en biotechnologie',
      siege: { ville: 'Lyon', code_postal: '69003' },
      representants: [],
    },
  ],
};

test('buildSearchUrl filters on creation date and MedTech NAF codes, newest first', () => {
  const url = new URL(buildSearchUrl({ apiToken: 'T', since: '2026-02-07' }));
  assert.equal(url.searchParams.get('api_token'), 'T');
  assert.equal(url.searchParams.get('date_creation_min'), '2026-02-07');
  assert.match(url.searchParams.get('code_naf'), /2660Z/);
  assert.equal(url.searchParams.get('ordre'), 'desc');
});

test('parseSearchPage maps an incorporation with its directors', () => {
  const [company] = parseSearchPage(PAGE_FIXTURE);
  assert.equal(company.source, 'pappers');
  assert.equal(company.sourceId, '987654321');
  assert.equal(company.kind, 'company_creation');
  assert.equal(company.title, 'Création de NEUROSCAN MEDICAL');
  assert.equal(company.date, '2026-05-14');
  assert.equal(company.country, 'FR');
  assert.equal(company.url, 'https://www.pappers.fr/entreprise/987654321');
  assert.equal(company.fingerprint, 'siren:987654321');
  assert.equal(company.extra.siren, '987654321');
  assert.equal(company.extra.incorporatedAt, '2026-05-14');
  assert.equal(company.extra.city, 'Bordeaux');
});

test('directors become `director` people — the join target for the high-priority rule', () => {
  const [company] = parseSearchPage(PAGE_FIXTURE);
  assert.deepEqual(company.people, [
    { name: 'Jean-Marc Dupont', role: 'director', affiliation: 'Président — NEUROSCAN MEDICAL' },
    { name: 'Marie Lefevre', role: 'director', affiliation: 'Directrice générale — NEUROSCAN MEDICAL' },
  ]);
});

test('a director with no nom_complet is rebuilt from prenom + nom', () => {
  const [company] = parseSearchPage(PAGE_FIXTURE);
  assert.equal(company.people[1].name, 'Marie Lefevre');
});

test('the company is recorded as an INDUSTRY organization', () => {
  const [company] = parseSearchPage(PAGE_FIXTURE);
  assert.deepEqual(company.organizations, [
    { name: 'NEUROSCAN MEDICAL', role: 'company', kind: 'INDUSTRY' },
  ]);
});

test('a company falls back to `denomination` and defaults to FR', () => {
  const [, second] = parseSearchPage(PAGE_FIXTURE);
  assert.equal(second.extra.companyName, 'GLUCOSENSE');
  assert.equal(second.country, 'FR');
  assert.deepEqual(second.people, []);
});

test('parseSearchPage skips rows without a siren or a name', () => {
  assert.deepEqual(parseSearchPage({ resultats: [{ siren: '1' }, { nom_entreprise: 'X' }, null] }), []);
  assert.deepEqual(parseSearchPage({}), []);
});

test('fetchCompanyCreations skips the source when no token is configured', async () => {
  const warnings = [];
  const records = await fetchCompanyCreations({ http: {}, logger: { warn: (m) => warnings.push(m) } });
  assert.deepEqual(records, []);
  assert.match(warnings[0], /PAPPERS_API_KEY/);
});

test('fetchCompanyCreations stops once the advertised total is covered', async () => {
  let calls = 0;
  const http = {
    json: async () => {
      calls += 1;
      return PAGE_FIXTURE;
    },
  };
  const records = await fetchCompanyCreations({
    http,
    apiToken: 'T',
    perPage: 100,
    now: Date.parse('2026-08-09T00:00:00Z'),
  });
  assert.equal(records.length, 2);
  assert.equal(calls, 1, 'total=2 fits in page 1 — no second call');
});

test('the lookback spans six months, or the high-priority rule could never fire', async () => {
  let seenUrl = '';
  const http = {
    json: async (url) => {
      seenUrl = url;
      return { resultats: [], total: 0 };
    },
  };
  await fetchCompanyCreations({ http, apiToken: 'T', now: Date.parse('2026-08-09T00:00:00Z') });
  assert.equal(new URL(seenUrl).searchParams.get('date_creation_min'), '2026-02-07');
});
