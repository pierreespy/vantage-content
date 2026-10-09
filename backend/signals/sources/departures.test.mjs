// node --test backend/signals/sources/departures.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffRoster,
  fetchFrDepartures,
  fetchUkDepartures,
  loadIncumbents,
  parseFrOfficers,
  parseNewAppointments,
  parseResignations,
} from './departures.mjs';
import { scoreLead } from '../score.mjs';

const NOW = Date.parse('2026-10-09T06:00:00Z');

test('incumbent list is well-formed (UK numbers, 9-digit SIRENs)', async () => {
  const { gb, fr } = await loadIncumbents();
  assert.ok(gb.length >= 10 && fr.length >= 5);
  for (const c of gb) assert.match(c.number, /^(\d{8}|SC\d{6})$/);
  for (const c of fr) assert.match(c.siren, /^\d{9}$/);
});

test('UK: only directors who resigned inside the window', () => {
  const out = parseResignations(
    {
      items: [
        { name: 'SMITH, Jane', officer_role: 'director', resigned_on: '2026-06-30', occupation: 'Vp R&D', links: { officer: { appointments: '/officers/abc/appointments' } } },
        { name: 'OLD, Tom', officer_role: 'director', resigned_on: '2024-01-01' },
        { name: 'STAY, Ann', officer_role: 'director' },
        { name: 'SEC, Bob', officer_role: 'secretary', resigned_on: '2026-06-30' },
      ],
    },
    { since: '2025-10-09', until: '2026-10-09' }
  );
  assert.deepEqual(out.map((o) => o.name), ['SMITH, Jane']);
  assert.equal(out[0].appointmentsPath, '/officers/abc/appointments');
});

test('UK: new mandates ignore the incumbent, resigned and pre-departure ones', () => {
  const { activeCount, fresh } = parseNewAppointments(
    {
      items: [
        { appointed_to: { company_number: '01070807', company_name: 'MEDTRONIC LIMITED' }, appointed_on: '2019-01-01', resigned_on: '2026-06-30' },
        { appointed_to: { company_number: '15000001', company_name: 'NEWCO MED LTD', company_status: 'active' }, appointed_on: '2026-05-10' },
        { appointed_to: { company_number: '09000001', company_name: 'OLD BOARD LTD', company_status: 'active' }, appointed_on: '2018-01-01' },
      ],
    },
    { incumbentNumber: '01070807', resignedOn: '2026-06-30' }
  );
  assert.equal(activeCount, 2);
  assert.deepEqual(fresh.map((c) => c.name), ['NEWCO MED LTD']);
});

test('UK: end to end, with incorporation date fetched for the new company', async () => {
  const calls = [];
  const http = {
    async json(url) {
      calls.push(url);
      if (url.includes('/company/01070807/officers'))
        return { items: [{ name: 'SMITH, Jane', officer_role: 'director', resigned_on: '2026-06-30', links: { officer: { appointments: '/officers/abc/appointments' } } }] };
      if (url.endsWith('/officers/abc/appointments'))
        return { items: [{ appointed_to: { company_number: '15000001', company_name: 'NEWCO MED LTD', company_status: 'active' }, appointed_on: '2026-07-02' }] };
      if (url.endsWith('/company/15000001')) return { date_of_creation: '2026-07-01' };
      throw new Error(`unexpected ${url}`);
    },
  };
  const records = await fetchUkDepartures({ http, apiKey: 'k', now: NOW, incumbents: [{ number: '01070807', name: 'MEDTRONIC LIMITED', label: 'Medtronic (UK)' }], logger: {} });
  assert.equal(records.length, 1);
  const [r] = records;
  assert.equal(r.kind, 'departure');
  assert.equal(r.people[0].role, 'departed');
  assert.equal(r.organizations.length, 0, 'the incumbent must not become a lead');
  assert.deepEqual(r.extra.newCompanies[0], { number: '15000001', name: 'NEWCO MED LTD', appointedOn: '2026-07-02', incorporatedAt: '2026-07-01' });

  const scored = scoreLead({ records, now: NOW });
  assert.deepEqual(scored.rules, ['departure_newco']);
  assert.ok(scored.score >= 80);
});

test('UK: no key → skipped, not fatal', async () => {
  assert.deepEqual(await fetchUkDepartures({ http: {}, apiKey: '', logger: {} }), []);
});

test('FR: officers exclude auditors and legal persons; a miss is null, not empty', () => {
  const payload = {
    results: [
      {
        siren: '722008232',
        dirigeants: [
          { type_dirigeant: 'personne physique', prenoms: 'AGNES MARIE', nom: 'PERENOM (LE TEUFF)', qualite: 'Directeur Général' },
          { type_dirigeant: 'personne physique', prenoms: 'PAUL', nom: 'AUDIT', qualite: 'Commissaire aux comptes titulaire' },
          { type_dirigeant: 'personne morale', denomination: 'KPMG', qualite: 'Commissaire aux comptes titulaire' },
        ],
      },
    ],
  };
  const officers = parseFrOfficers(payload, '722008232');
  assert.deepEqual(officers.map((o) => o.name), ['Agnes Marie Perenom']);
  assert.equal(parseFrOfficers({ results: [] }, '722008232'), null);
});

test('FR roster diff: gone = departure, back = not a departure, old ones expire', () => {
  const a = { key: 'a', name: 'A', role: 'DG' };
  const b = { key: 'b', name: 'B', role: 'Président' };
  let roster = diffRoster({ officers: [a, b], departures: [] }, [a], '2026-10-09');
  assert.deepEqual(roster.departures.map((d) => [d.key, d.date]), [['b', '2026-10-09']]);
  // Next run, unchanged: same departure, same date.
  roster = diffRoster(roster, [a], '2026-10-10');
  assert.deepEqual(roster.departures.map((d) => d.date), ['2026-10-09']);
  // B comes back: forgotten.
  assert.equal(diffRoster(roster, [a, b], '2026-10-11').departures.length, 0);
  // A year later: expired.
  assert.equal(diffRoster(roster, [a], '2027-11-01').departures.length, 0);
});

test('FR: first run seeds silently, second run emits the departure → stealth lead', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dep-'));
  const incumbents = [{ siren: '722008232', name: 'MEDTRONIC FRANCE', label: 'Medtronic France' }];
  const roster = (people) => ({
    async json() {
      return { results: [{ siren: '722008232', dirigeants: people.map((n) => ({ type_dirigeant: 'personne physique', prenoms: n[0], nom: n[1], qualite: 'Directeur Général' })) }] };
    },
  });
  const first = await fetchFrDepartures({ http: roster([['JEAN', 'DUPONT'], ['MARIE', 'MARTIN']]), incumbents, stateDir, now: NOW, logger: {} });
  assert.equal(first.length, 0);
  const later = Date.parse('2026-11-20T06:00:00Z');
  const second = await fetchFrDepartures({ http: roster([['MARIE', 'MARTIN']]), incumbents, stateDir, now: later, logger: {} });
  assert.equal(second.length, 1);
  assert.equal(second[0].people[0].name, 'Jean Dupont');
  assert.equal(second[0].date, '2026-11-20');
  assert.ok(JSON.parse(await readFile(join(stateDir, 'rosters-fr.json'), 'utf8')).rosters['722008232']);

  const scored = scoreLead({ records: second, now: later });
  assert.deepEqual(scored.rules, ['stealth_departure']);
  assert.ok(scored.score >= 50 && scored.score < 80);
  assert.match(scored.reasons[0], /stealth/);
});

test('a departure followed by a known other mandate is not stealth', () => {
  const records = [
    {
      source: 'departures', sourceId: 'x', kind: 'departure', title: 't', date: '2026-08-01', url: '',
      extra: { incumbent: 'Medtronic (UK)', otherActiveMandates: 3, newCompanies: [] },
    },
  ];
  assert.deepEqual(scoreLead({ records, now: NOW }).rules, []);
});

test('departure + registry creation joined by the resolver → high priority', () => {
  const records = [
    { source: 'departures', sourceId: 'x', kind: 'departure', title: 't', date: '2026-04-01', url: '', extra: { incumbent: 'Medtronic France', otherActiveMandates: null, newCompanies: [] } },
    { source: 'inpi', sourceId: '999', kind: 'company_creation', title: 'Création de NEUROVALVE', date: '2026-06-15', url: '', extra: {} },
  ];
  const scored = scoreLead({ records, now: NOW });
  assert.deepEqual(scored.rules, ['departure_newco']);
  assert.match(scored.reasons[0], /NEUROVALVE/);
});
