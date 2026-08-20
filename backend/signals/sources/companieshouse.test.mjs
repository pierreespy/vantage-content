// node --test backend/signals/sources/companieshouse.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeader,
  buildOfficersUrl,
  buildSearchUrl,
  fetchCompanyCreations,
  parseCompanies,
  parseOfficers,
  toRecord,
  totalHits,
} from './companieshouse.mjs';
import { personsMatch } from '../resolve/match.mjs';
import { parsePerson } from '../lib/normalize.mjs';

const SEARCH_FIXTURE = {
  hits: 2,
  items: [
    {
      company_number: '15234567',
      company_name: 'NEUROSCAN MEDICAL LTD',
      date_of_creation: '2026-05-14',
      company_status: 'active',
      company_type: 'ltd',
      sic_codes: ['32500', '72110'],
      registered_office_address: { locality: 'Cambridge', region: 'Cambridgeshire', postal_code: 'CB2 1TN' },
    },
    {
      company_number: '15999999',
      company_name: 'GLUCOSENSE DIAGNOSTICS LTD',
      date_of_creation: '2026-07-02',
      company_status: 'active',
      company_type: 'ltd',
      sic_codes: ['26600'],
      registered_office_address: { locality: 'Oxford' },
    },
  ],
};

const OFFICERS_FIXTURE = {
  items: [
    { name: 'DUPONT, Jean-Marc', officer_role: 'director', appointed_on: '2026-05-14' },
    { name: 'LEFEVRE, Marie Claire', officer_role: 'director', appointed_on: '2026-05-14' },
    // Resigned: no longer someone to contact.
    { name: 'OLDMAN, John', officer_role: 'director', appointed_on: '2024-01-01', resigned_on: '2026-04-01' },
    // A secretary is not a decision maker we report.
    { name: 'CLERK, Susan', officer_role: 'secretary', appointed_on: '2026-05-14' },
  ],
};

test('auth is Basic with the key as username and an empty password', () => {
  // A Companies House idiosyncrasy: not a bearer token.
  assert.equal(authHeader('abc123'), `Basic ${Buffer.from('abc123:').toString('base64')}`);
});

test('buildSearchUrl filters on SIC codes, incorporation window and active status', () => {
  const url = new URL(buildSearchUrl({ since: '2026-02-18', until: '2026-08-20', startIndex: 100 }));
  assert.deepEqual(url.searchParams.getAll('sic_codes'), ['21200', '26600', '32500', '72110', '72190']);
  assert.equal(url.searchParams.get('incorporated_from'), '2026-02-18');
  assert.equal(url.searchParams.get('incorporated_to'), '2026-08-20');
  assert.equal(url.searchParams.get('company_status'), 'active');
  assert.equal(url.searchParams.get('start_index'), '100');
  assert.match(buildOfficersUrl('15234567'), /\/company\/15234567\/officers$/);
});

test('parseCompanies maps the search results', () => {
  const [company] = parseCompanies(SEARCH_FIXTURE);
  assert.equal(company.number, '15234567');
  assert.equal(company.name, 'NEUROSCAN MEDICAL LTD');
  assert.equal(company.incorporatedAt, '2026-05-14');
  assert.deepEqual(company.sicCodes, ['32500', '72110']);
  assert.equal(company.city, 'Cambridge');
});

test('parseOfficers keeps current directors only', () => {
  const people = parseOfficers(OFFICERS_FIXTURE, 'NEUROSCAN MEDICAL LTD');
  assert.deepEqual(people.map((p) => p.name), ['DUPONT, Jean-Marc', 'LEFEVRE, Marie Claire']);
  assert.ok(people.every((p) => p.role === 'director'));
});

test('the "FAMILY, Given" form Companies House emits joins onto PubMed and EPO', () => {
  // The whole point of the connector: a UK director must resolve to the same
  // entity as the PubMed author and the EPO inventor.
  const [director] = parseOfficers(OFFICERS_FIXTURE);
  assert.equal(parsePerson(director.name).family, 'dupont');
  assert.equal(parsePerson(director.name).given, 'jean marc');
  assert.ok(personsMatch({ name: director.name }, { name: 'DUPONT JEAN-MARC [FR]' }), 'UK <-> EPO');
  assert.ok(
    personsMatch({ name: director.name }, { name: 'Dupont JM', affiliation: 'Institut Pasteur' }),
    'UK <-> PubMed'
  );
});

test('toRecord produces a SourceRecord the resolver can join on', () => {
  const [company] = parseCompanies(SEARCH_FIXTURE);
  const record = toRecord(company, parseOfficers(OFFICERS_FIXTURE, company.name));
  assert.equal(record.source, 'companieshouse');
  assert.equal(record.sourceId, '15234567');
  assert.equal(record.kind, 'company_creation');
  assert.equal(record.date, '2026-05-14');
  assert.equal(record.country, 'GB');
  assert.equal(record.fingerprint, 'crn:15234567');
  assert.equal(record.extra.incorporatedAt, '2026-05-14');
  assert.match(record.url, /find-and-update\.company-information\.service\.gov\.uk/);
  assert.equal(record.people.length, 2);
});

test('malformed payloads yield nothing rather than throwing', () => {
  assert.deepEqual(parseCompanies({}), []);
  assert.deepEqual(parseCompanies(null), []);
  assert.deepEqual(parseCompanies({ items: [{ company_number: '1' }] }), [], 'no name, no date');
  assert.deepEqual(parseOfficers({}), []);
  assert.equal(totalHits({}), 0);
});

test('fetchCompanyCreations skips the source when no key is configured', async () => {
  const warnings = [];
  const records = await fetchCompanyCreations({ http: {}, logger: { warn: (m) => warnings.push(m) } });
  assert.deepEqual(records, []);
  assert.match(warnings[0], /COMPANIES_HOUSE_API_KEY/);
});

test('fetchCompanyCreations sends Basic auth and attaches officers', async () => {
  const calls = [];
  const http = {
    json: async (url, options) => {
      calls.push({ url, options });
      return url.includes('/officers') ? OFFICERS_FIXTURE : SEARCH_FIXTURE;
    },
  };
  const records = await fetchCompanyCreations({
    http,
    apiKey: 'k',
    now: Date.parse('2026-08-20T00:00:00Z'),
  });

  assert.equal(records.length, 2);
  assert.match(calls[0].options.headers.authorization, /^Basic /);
  assert.equal(calls[0].options.cacheSalt, '0', 'paging varies start_index, salt keeps pages apart');
  // Newest incorporation first, so the officer cap keeps the freshest ones.
  assert.deepEqual(records.map((r) => r.date), ['2026-07-02', '2026-05-14']);
});

test('an unavailable officer list degrades instead of failing the run', async () => {
  const warnings = [];
  const http = {
    json: async (url) => {
      if (url.includes('/officers')) throw new Error('429');
      return SEARCH_FIXTURE;
    },
  };
  const records = await fetchCompanyCreations({
    http,
    apiKey: 'k',
    now: Date.parse('2026-08-20T00:00:00Z'),
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.people.length === 0));
  assert.match(warnings[0], /officers unavailable/);
});
