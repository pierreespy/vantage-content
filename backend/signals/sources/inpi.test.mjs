// node --test backend/signals/sources/inpi.test.mjs
//
// Fixtures follow the published INPI RNE OpenAPI spec (3.1.3): a `Formality`
// carries `siren` + `content.personneMorale.{identite.entreprise, composition.pouvoirs}`,
// and officer names live in `pouvoirs[].individu.descriptionPersonne`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchUrl,
  createInpiAuth,
  fetchCompanyCreations,
  findResults,
  maxPageOf,
  parseFormalities,
} from './inpi.mjs';
import { personsMatch } from '../resolve/match.mjs';
import { parsePerson } from '../lib/normalize.mjs';

const PAGE_FIXTURE = {
  totalSize: 2,
  page: 1,
  maxPage: 1,
  pageSize: 100,
  results: [
    {
      siren: '987654321',
      formeJuridique: '5710',
      created: '2026-05-20T09:12:00.000Z',
      typePersonne: 'M',
      content: {
        natureCreation: { dateCreation: '2026-05-14', formeJuridique: '5710' },
        personneMorale: {
          identite: {
            entreprise: {
              siren: '987654321',
              denomination: 'NEUROSCAN MEDICAL',
              codeApe: '2660Z',
              dateImmat: '2026-05-14',
              formeJuridique: '5710',
              objet: 'Conception de capteurs cardiaques implantables',
            },
          },
          composition: {
            pouvoirs: [
              {
                roleEntreprise: '5300',
                libelleRoleEntreprise: 'Président',
                individu: {
                  descriptionPersonne: { nom: 'DUPONT', prenoms: ['Jean-Marc'] },
                },
              },
              {
                libelleRoleEntreprise: 'Directrice générale',
                individu: {
                  descriptionPersonne: { nom: 'LEFEVRE', nomUsage: 'LEFEVRE', prenoms: ['Marie'] },
                },
              },
              {
                // A legal-person officer: not a person we can join on.
                libelleRoleEntreprise: 'Administrateur',
                entreprise: { denomination: 'HOLDING SANTE SAS', siren: '111222333' },
              },
            ],
          },
        },
      },
    },
    {
      siren: '123456789',
      created: '2026-07-02T10:00:00.000Z',
      content: {
        // Sole trader: same sub-structure under `personnePhysique`.
        personnePhysique: {
          identite: {
            entreprise: { denomination: 'GLUCOSENSE', codeApe: '7211Z', dateImmat: '2026-07-02' },
          },
          composition: {
            pouvoirs: [
              { libelleRoleEntreprise: 'Gérant', individu: { descriptionPersonne: { nom: 'Okafor', prenoms: ['Chidi'] } } },
            ],
          },
        },
      },
    },
  ],
};

test('buildSearchUrl filters on APE codes and the filing-date window', () => {
  const url = new URL(buildSearchUrl({ since: '2026-02-18', until: '2026-08-21', apeCodes: ['2660Z', '7211Z'] }));
  assert.deepEqual(url.searchParams.getAll('codesApe[]'), ['2660Z', '7211Z']);
  assert.equal(url.searchParams.get('depotDateFrom'), '2026-02-18');
  assert.equal(url.searchParams.get('depotDateTo'), '2026-08-21');
  assert.equal(url.searchParams.get('sortDirection'), 'DESC');
  assert.match(url.pathname, /\/formalities\/paginated$/);
});

test('parseFormalities maps an incorporation with its directors', () => {
  const [company] = parseFormalities(PAGE_FIXTURE);
  assert.equal(company.source, 'inpi');
  assert.equal(company.sourceId, '987654321');
  assert.equal(company.kind, 'company_creation');
  assert.equal(company.title, 'Création de NEUROSCAN MEDICAL');
  assert.equal(company.date, '2026-05-14', 'dateImmat is the incorporation date');
  assert.equal(company.country, 'FR');
  assert.equal(company.url, 'https://annuaire-entreprises.data.gouv.fr/entreprise/987654321');
  assert.equal(company.fingerprint, 'siren:987654321');
  assert.equal(company.extra.nafCode, '2660Z');
  assert.equal(company.extra.incorporatedAt, '2026-05-14');
});

test('officers become `director` people — the join target for the high-priority rule', () => {
  const [company] = parseFormalities(PAGE_FIXTURE);
  // The registry shouts family names; we keep the source spelling rather than
  // invent a casing, exactly as with EPO.
  assert.deepEqual(company.people, [
    { name: 'Jean-Marc DUPONT', role: 'director', affiliation: 'Président — NEUROSCAN MEDICAL' },
    { name: 'Marie LEFEVRE', role: 'director', affiliation: 'Directrice générale — NEUROSCAN MEDICAL' },
  ]);
});

test('the "Prénom NOM" form INPI emits joins onto PubMed and EPO spellings', () => {
  // This is the whole point of the connector: the director must resolve to the
  // same person as the PubMed author and the EPO inventor.
  const [company] = parseFormalities(PAGE_FIXTURE);
  const director = { name: company.people[0].name };

  assert.equal(parsePerson(director.name).family, 'dupont');
  assert.ok(personsMatch(director, { name: 'DUPONT JEAN-MARC [FR]' }), 'INPI <-> EPO');
  assert.ok(
    personsMatch(director, { name: 'Dupont JM', affiliation: 'Institut Pasteur, Paris' }),
    'INPI <-> PubMed'
  );
});

test('a legal-person officer is not emitted as a person', () => {
  // "HOLDING SANTE SAS" manages the company but is not someone to contact.
  const [company] = parseFormalities(PAGE_FIXTURE);
  assert.ok(!company.people.some((p) => /HOLDING/i.test(p.name)));
});

test('the sole-trader branch (personnePhysique) is parsed too', () => {
  const [, sole] = parseFormalities(PAGE_FIXTURE);
  assert.equal(sole.extra.companyName, 'GLUCOSENSE');
  assert.equal(sole.date, '2026-07-02');
  assert.deepEqual(sole.people.map((p) => p.name), ['Chidi Okafor']);
});

test('the company is recorded as an INDUSTRY organization', () => {
  const [company] = parseFormalities(PAGE_FIXTURE);
  assert.deepEqual(company.organizations, [
    { name: 'NEUROSCAN MEDICAL', role: 'company', kind: 'INDUSTRY' },
  ]);
});

test('rows without a siren, content, name or date are dropped', () => {
  assert.deepEqual(parseFormalities({ results: [{ siren: '1' }, { content: {} }, null] }), []);
  assert.deepEqual(parseFormalities({}), []);
  assert.deepEqual(parseFormalities(null), []);
});

test('findResults copes with the response key the spec does not pin down', () => {
  // `SearchResponse` only types the pagination counters, so the rows key is not
  // contractual — the parser must not hard-fail on a different name.
  const rows = [{ siren: '1' }];
  for (const payload of [{ results: rows }, { items: rows }, { data: rows }, { content: rows }, rows]) {
    assert.deepEqual(findResults(payload), rows, JSON.stringify(payload).slice(0, 40));
  }
  assert.deepEqual(findResults({ unexpectedKey: rows }), rows, 'falls back to the first array of siren objects');
  assert.deepEqual(findResults({ totalSize: 0 }), []);
});

test('maxPageOf defaults to a single page when absent', () => {
  assert.equal(maxPageOf({ maxPage: 4 }), 4);
  assert.equal(maxPageOf({}), 1);
});

test('createInpiAuth posts credentials and caches the token', () => {
  const calls = [];
  let time = 0;
  const http = {
    json: async (url, options) => {
      calls.push({ url, options });
      return { token: `tok${calls.length}` };
    },
  };
  const getToken = createInpiAuth({ http, username: 'a@b.c', password: 'pw', now: () => time });

  return getToken().then(async (first) => {
    assert.equal(first, 'tok1');
    assert.equal(await getToken(), 'tok1', 'cached');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/sso\/login$/);
    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].options.body), { username: 'a@b.c', password: 'pw' });
    assert.equal(calls[0].options.useCache, false, 'a credential exchange is never cached');

    // `force` bypasses the cache — used when a token expires mid-run.
    assert.equal(await getToken(true), 'tok2');
  });
});

test('createInpiAuth fails loudly when the login response has no token', async () => {
  const getToken = createInpiAuth({ http: { json: async () => ({}) }, username: 'a', password: 'b' });
  await assert.rejects(getToken(), /no token/);
});

test('fetchCompanyCreations skips the source when no credentials are configured', async () => {
  const warnings = [];
  const records = await fetchCompanyCreations({ http: {}, logger: { warn: (m) => warnings.push(m) } });
  assert.deepEqual(records, []);
  assert.match(warnings[0], /INPI_USERNAME/);
});

test('fetchCompanyCreations sends the bearer token and stops at maxPage', async () => {
  const calls = [];
  const http = {
    json: async (url, options) => {
      calls.push(options);
      return PAGE_FIXTURE;
    },
  };
  const records = await fetchCompanyCreations({
    http,
    getToken: async () => 'tok',
    now: Date.parse('2026-08-20T00:00:00Z'),
  });

  assert.equal(records.length, 2);
  assert.equal(calls[0].headers.authorization, 'Bearer tok');
  assert.equal(calls.length, 1, 'maxPage is 1 in the fixture');
});

test('an expired token is refreshed once, then the page is retried', async () => {
  let tokens = 0;
  let attempts = 0;
  const http = {
    json: async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('HTTP 401');
        err.status = 401;
        throw err;
      }
      return PAGE_FIXTURE;
    },
  };
  const records = await fetchCompanyCreations({
    http,
    getToken: async () => `tok${++tokens}`,
    now: Date.parse('2026-08-20T00:00:00Z'),
  });
  assert.equal(records.length, 2);
  assert.equal(tokens, 2, 'a fresh token was requested');
});

test('companies incorporated outside the window are dropped', async () => {
  // The API filters on the FILING date; an old company filing a document today
  // must not be reported as a recent incorporation.
  const stale = JSON.parse(JSON.stringify(PAGE_FIXTURE));
  stale.results[0].content.personneMorale.identite.entreprise.dateImmat = '2019-01-01';
  stale.results[1].content.personnePhysique.identite.entreprise.dateImmat = '2019-01-01';

  const records = await fetchCompanyCreations({
    http: { json: async () => stale },
    getToken: async () => 'tok',
    now: Date.parse('2026-08-20T00:00:00Z'),
  });
  assert.deepEqual(records, []);
});
