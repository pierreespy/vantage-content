// node --test backend/signals/sources/brreg.test.mjs
//
// Fixtures are trimmed copies of real `data.brreg.no` responses — this is the one
// registry that answers without any credentials, so the shapes below were taken
// from live calls rather than from a spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRolesUrl,
  buildSearchUrl,
  fetchCompanyCreations,
  parseRoles,
  parseUnits,
  toRecord,
  totalPages,
} from './brreg.mjs';

const UNITS_FIXTURE = {
  _embedded: {
    enheter: [
      {
        organisasjonsnummer: '936978975',
        navn: 'EACYG AS',
        organisasjonsform: { kode: 'AS', beskrivelse: 'Aksjeselskap' },
        registreringsdatoEnhetsregisteret: '2026-01-16',
        naeringskode1: { kode: '32.500', beskrivelse: 'Produksjon av medisinske instrumenter' },
        forretningsadresse: { landkode: 'NO', poststed: 'OSLO' },
      },
      {
        // A bankruptcy estate: the END of a company, not a start.
        organisasjonsnummer: '937818254',
        navn: 'APEXIA AS TVANGSAVVIKLINGSBO',
        organisasjonsform: { kode: 'KBO', beskrivelse: 'Konkursbo' },
        registreringsdatoEnhetsregisteret: '2026-06-03',
        naeringskode1: { kode: '32.500' },
        forretningsadresse: { landkode: 'NO', poststed: 'OSLO' },
      },
      {
        // A Norwegian branch of a foreign company — not an incorporation.
        organisasjonsnummer: '936227007',
        navn: 'NOVO NORDISK - NUF',
        organisasjonsform: { kode: 'NUF', beskrivelse: 'Norskregistrert utenlandsk foretak' },
        registreringsdatoEnhetsregisteret: '2025-10-09',
        naeringskode1: { kode: '21.200' },
        forretningsadresse: { landkode: 'DK', poststed: 'BAGSVÆRD' },
      },
    ],
  },
  page: { totalPages: 1, totalElements: 3 },
};

const ROLES_FIXTURE = {
  rollegrupper: [
    {
      type: { kode: 'STYR', beskrivelse: 'Styre' },
      roller: [
        { type: { kode: 'LEDE', beskrivelse: 'Styrets leder' }, person: { navn: { fornavn: 'Endre', etternavn: 'Tveiten' } } },
        { type: { kode: 'MEDL', beskrivelse: 'Styremedlem' }, person: { navn: { fornavn: 'Espen', mellomnavn: 'Bjørge', etternavn: 'Urheim' } } },
        // Resigned: not a current officer.
        { type: { kode: 'MEDL' }, person: { navn: { fornavn: 'Ola', etternavn: 'Nordmann' } }, fratraadt: true },
        // A company acting as an officer is not a contactable human.
        { type: { kode: 'MEDL' }, enhet: { navn: 'HOLDING AS' } },
        // Not a role we report.
        { type: { kode: 'REVI', beskrivelse: 'Revisor' }, person: { navn: { fornavn: 'Kari', etternavn: 'Revisor' } } },
      ],
    },
  ],
};

test('buildSearchUrl filters on NACE code and the registration window', () => {
  const url = new URL(buildSearchUrl({ naceCode: '32.50', since: '2026-02-18', until: '2026-08-20', page: 2 }));
  assert.equal(url.searchParams.get('naeringskode'), '32.50');
  assert.equal(url.searchParams.get('fraRegistreringsdatoEnhetsregisteret'), '2026-02-18');
  assert.equal(url.searchParams.get('tilRegistreringsdatoEnhetsregisteret'), '2026-08-20');
  assert.equal(url.searchParams.get('page'), '2');
  assert.match(buildRolesUrl('936978975'), /enheter\/936978975\/roller$/);
});

test('parseUnits keeps trading companies only', () => {
  const units = parseUnits(UNITS_FIXTURE);
  assert.deepEqual(units.map((u) => u.name), ['EACYG AS']);
});

test('a bankruptcy estate is not a company creation', () => {
  // "Konkursbo" is the end of a company — the opposite of the signal we want.
  const only = { _embedded: { enheter: [UNITS_FIXTURE._embedded.enheter[1]] } };
  assert.deepEqual(parseUnits(only), []);
});

test('a NUF branch of a foreign company is not an incorporation', () => {
  // Regression guard from the first live run: "NOVO NORDISK - NUF" (Danish) and
  // an Italian S.P.A. came back as if they were new Norwegian medtech companies.
  const only = { _embedded: { enheter: [UNITS_FIXTURE._embedded.enheter[2]] } };
  assert.deepEqual(parseUnits(only), []);
});

test('a company whose business address is abroad is skipped', () => {
  const foreign = {
    _embedded: {
      enheter: [
        {
          organisasjonsnummer: '1',
          navn: 'TEMA SINERGIE S.P.A.',
          organisasjonsform: { kode: 'AS' },
          registreringsdatoEnhetsregisteret: '2026-07-16',
          forretningsadresse: { landkode: 'IT', poststed: 'FAENZA' },
        },
      ],
    },
  };
  assert.deepEqual(parseUnits(foreign), []);
});

test('parseRoles keeps current, human directors only', () => {
  const people = parseRoles(ROLES_FIXTURE, 'EACYG AS');
  assert.deepEqual(people, [
    { name: 'Endre Tveiten', role: 'director', affiliation: 'Styrets leder — EACYG AS' },
    { name: 'Espen Bjørge Urheim', role: 'director', affiliation: 'Styremedlem — EACYG AS' },
  ]);
});

test('one person holding several roles appears once', () => {
  const twice = {
    rollegrupper: [
      {
        roller: [
          { type: { kode: 'LEDE' }, person: { navn: { fornavn: 'Endre', etternavn: 'Tveiten' } } },
          { type: { kode: 'DAGL' }, person: { navn: { fornavn: 'Endre', etternavn: 'Tveiten' } } },
        ],
      },
    ],
  };
  assert.equal(parseRoles(twice).length, 1);
});

test('toRecord produces a SourceRecord the resolver can join on', () => {
  const [unit] = parseUnits(UNITS_FIXTURE);
  const record = toRecord(unit, parseRoles(ROLES_FIXTURE, unit.name));
  assert.equal(record.source, 'brreg');
  assert.equal(record.sourceId, '936978975');
  assert.equal(record.kind, 'company_creation');
  assert.equal(record.date, '2026-01-16');
  assert.equal(record.country, 'NO');
  assert.equal(record.extra.incorporatedAt, '2026-01-16');
  assert.equal(record.fingerprint, 'orgnr:936978975');
  assert.equal(record.people.length, 2);
  assert.deepEqual(record.organizations, [{ name: 'EACYG AS', role: 'company', kind: 'INDUSTRY' }]);
});

test('malformed payloads yield nothing rather than throwing', () => {
  assert.deepEqual(parseUnits({}), []);
  assert.deepEqual(parseUnits(null), []);
  assert.deepEqual(parseRoles({}), []);
  assert.deepEqual(parseRoles(null), []);
  assert.equal(totalPages({}), 1);
  assert.equal(totalPages({ page: { totalPages: 3 } }), 3);
});

test('fetchCompanyCreations needs no credentials and attaches officers', async () => {
  const calls = [];
  const http = {
    json: async (url) => {
      calls.push(url);
      return url.includes('/roller') ? ROLES_FIXTURE : UNITS_FIXTURE;
    },
  };
  const records = await fetchCompanyCreations({
    http,
    naceCodes: ['32.50'],
    now: Date.parse('2026-08-20T00:00:00Z'),
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].people.length, 2, 'officers came from the second call');
  assert.ok(calls.some((u) => u.includes('/roller')));
});

test('the officer-lookup cap is respected', async () => {
  const http = { json: async (url) => (url.includes('/roller') ? ROLES_FIXTURE : UNITS_FIXTURE) };
  const records = await fetchCompanyCreations({
    http,
    naceCodes: ['32.50'],
    maxRoleLookups: 0,
    now: Date.parse('2026-08-20T00:00:00Z'),
  });
  assert.equal(records.length, 1, 'the company is still reported');
  assert.deepEqual(records[0].people, [], 'but without officers');
});

test('an unavailable role list degrades instead of failing the run', async () => {
  const warnings = [];
  const http = {
    json: async (url) => {
      if (url.includes('/roller')) throw new Error('503');
      return UNITS_FIXTURE;
    },
  };
  const records = await fetchCompanyCreations({
    http,
    naceCodes: ['32.50'],
    now: Date.parse('2026-08-20T00:00:00Z'),
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].people, []);
  assert.match(warnings[0], /roles unavailable/);
});
