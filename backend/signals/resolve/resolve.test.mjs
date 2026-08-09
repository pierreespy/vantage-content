// node --test backend/signals/resolve/resolve.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionsFromRecords, resolveEntities } from './resolve.mjs';
import { makeRecord } from '../lib/record.mjs';

const NOW = Date.parse('2026-08-09T00:00:00Z');

/** Build a valid SourceRecord with sensible defaults. */
function rec(overrides) {
  const record = makeRecord({
    source: 'pubmed',
    sourceId: '1',
    kind: 'publication',
    title: 'A title',
    date: '2026-07-02',
    ...overrides,
  });
  assert.ok(record, `fixture is not a valid record: ${JSON.stringify(overrides)}`);
  return record;
}

const publication = rec({
  source: 'europepmc',
  sourceId: 'MED:40112233',
  kind: 'publication',
  title: 'Implantable cardiac sensor',
  date: '2026-03-02',
  people: [{ name: 'Dupont JM', role: 'author', affiliation: 'Institut Pasteur, Paris' }],
  organizations: [{ name: 'Nature Biomedical Engineering', role: 'affiliation' }],
});

const patent = rec({
  source: 'epo',
  sourceId: 'EP4123456A1',
  kind: 'patent',
  title: 'Implantable cardiac sensor',
  date: '2026-05-15',
  country: 'EP',
  people: [{ name: 'DUPONT JEAN-MARC', role: 'inventor' }],
  organizations: [{ name: 'NEUROSCAN MEDICAL SAS', role: 'applicant' }],
});

const incorporation = rec({
  source: 'pappers',
  sourceId: '987654321',
  kind: 'company_creation',
  title: 'Création de NEUROSCAN MEDICAL',
  date: '2026-06-14',
  country: 'FR',
  people: [{ name: 'Jean-Marc Dupont', role: 'director', affiliation: 'Président — NEUROSCAN MEDICAL' }],
  organizations: [{ name: 'NEUROSCAN MEDICAL', role: 'company', kind: 'INDUSTRY' }],
  extra: { siren: '987654321', incorporatedAt: '2026-06-14', companyName: 'NEUROSCAN MEDICAL' },
});

test('mentionsFromRecords excludes journals — an affiliation is not a company', () => {
  const { persons, organizations } = mentionsFromRecords([publication, patent]);
  assert.equal(persons.length, 2);
  assert.deepEqual(
    organizations.map((o) => o.name),
    ['NEUROSCAN MEDICAL SAS'],
    'the journal (role: affiliation) must not become a company entity'
  );
});

test('the same researcher across PubMed, EPO and Pappers resolves to ONE entity', () => {
  // The join the entire high-priority rule depends on.
  const { entities } = resolveEntities({}, [publication, patent, incorporation], { now: NOW });
  const people = Object.values(entities).filter((e) => e.kind === 'person');
  assert.equal(people.length, 1, `expected 1 person, got ${people.map((p) => p.name).join(' / ')}`);

  const [person] = people;
  assert.equal(person.records.length, 3);
  assert.deepEqual(new Set(person.records.map((r) => r.kind)), new Set(['publication', 'patent', 'company_creation']));
  assert.equal(person.name, 'Jean-Marc Dupont', 'the longest spelling wins as the display name');
  assert.ok(person.aliases.includes('Dupont JM'));
});

test('company mentions collapse across their legal spellings', () => {
  const { entities } = resolveEntities({}, [patent, incorporation], { now: NOW });
  const companies = Object.values(entities).filter((e) => e.kind === 'company');
  assert.equal(companies.length, 1, 'NEUROSCAN MEDICAL SAS and NEUROSCAN MEDICAL are one company');
  assert.equal(companies[0].attributes.siren, '987654321', 'registry facts enrich the entity');
  assert.equal(companies[0].attributes.incorporatedAt, '2026-06-14');
  assert.equal(companies[0].attributes.orgKind, 'INDUSTRY');
});

test('people are linked to the companies they co-occur with', () => {
  const { entities, stats } = resolveEntities({}, [patent, incorporation], { now: NOW });
  const person = Object.values(entities).find((e) => e.kind === 'person');
  const company = Object.values(entities).find((e) => e.kind === 'company');
  assert.ok(person.links.includes(company.id));
  assert.ok(company.links.includes(person.id));
  assert.ok(stats.linked > 0);
});

test('entities PERSIST across runs — which is what lets months-apart events meet', () => {
  // A single run only ever sees a 30-day window; the March publication, the May
  // patent and the June incorporation can only meet through stored state.
  const first = resolveEntities({}, [publication], { now: Date.parse('2026-03-05T00:00:00Z') });
  const second = resolveEntities(first.entities, [patent], { now: Date.parse('2026-05-20T00:00:00Z') });
  const third = resolveEntities(second.entities, [incorporation], { now: NOW });

  const person = Object.values(third.entities).find((e) => e.kind === 'person');
  assert.equal(person.records.length, 3);
  assert.equal(person.firstEvidence, '2026-03-02');
  assert.equal(person.latestEvidence, '2026-06-14');
});

test('re-running on the same records is idempotent', () => {
  // Otherwise every run would commit a churned state file for nothing.
  const once = resolveEntities({}, [publication, patent, incorporation], { now: NOW });
  const twice = resolveEntities(once.entities, [publication, patent, incorporation], { now: NOW });
  assert.deepEqual(Object.keys(twice.entities).sort(), Object.keys(once.entities).sort());
  for (const id of Object.keys(once.entities)) {
    assert.equal(twice.entities[id].records.length, once.entities[id].records.length, id);
  }
});

test('a bridging mention collapses two clusters that were kept apart', () => {
  // Same family name and initial, different institutions: too weak to merge, and
  // rightly so — they could be two people.
  const a = rec({
    source: 'pubmed',
    sourceId: 'p1',
    date: '2026-07-01',
    people: [{ name: 'Bernard A', role: 'author', affiliation: 'Karolinska Institutet' }],
  });
  const b = rec({
    source: 'europepmc',
    sourceId: 'MED:2',
    date: '2026-07-02',
    people: [{ name: 'Bernard A', role: 'author', affiliation: 'ETH Zurich' }],
  });
  const separate = resolveEntities({}, [a, b], { now: NOW });
  assert.equal(Object.values(separate.entities).filter((e) => e.kind === 'person').length, 2);

  // ...until a paper listing BOTH affiliations shows they were one person.
  const bridging = rec({
    source: 'pubmed',
    sourceId: 'p3',
    date: '2026-07-03',
    people: [{ name: 'Bernard A', role: 'author', affiliation: 'Karolinska Institutet / ETH Zurich' }],
  });
  const merged = resolveEntities(separate.entities, [bridging], { now: NOW });
  const people = Object.values(merged.entities).filter((e) => e.kind === 'person');
  assert.equal(people.length, 1, 'the bridging mention collapsed both clusters');
  assert.equal(merged.stats.bridged, 1);
});

test('distinct researchers are NOT merged', () => {
  const one = rec({
    sourceId: 'a',
    people: [{ name: 'Dupont JM', role: 'author', affiliation: 'Institut Pasteur' }],
  });
  const two = rec({
    sourceId: 'b',
    people: [{ name: 'Lefevre M', role: 'author', affiliation: 'CHU Bordeaux' }],
  });
  const { entities } = resolveEntities({}, [one, two], { now: NOW });
  assert.equal(Object.values(entities).filter((e) => e.kind === 'person').length, 2);
});

test('entities unseen past the retention window are pruned', () => {
  const stored = {
    'person:old:1234abcd': {
      id: 'person:old:1234abcd',
      kind: 'person',
      name: 'Ancient Author',
      aliases: [],
      countries: [],
      affiliations: [],
      attributes: {},
      records: [{ source: 'pubmed', sourceId: 'x', kind: 'publication', date: '2023-01-01', role: 'author' }],
      links: [],
      firstSeen: '2023-01-01',
      lastSeen: '2023-01-02',
    },
  };
  const { entities } = resolveEntities(stored, [], { now: NOW, retentionDays: 400 });
  assert.deepEqual(Object.keys(entities), []);
});

test('records per entity are capped and kept newest-first', () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    rec({
      sourceId: `p${i}`,
      date: `2026-0${(i % 8) + 1}-0${(i % 9) + 1}`,
      people: [{ name: 'Dupont JM', role: 'author', affiliation: 'Institut Pasteur' }],
    })
  );
  const { entities } = resolveEntities({}, many, { now: NOW, maxRecordsPerEntity: 10 });
  const person = Object.values(entities).find((e) => e.kind === 'person');
  assert.equal(person.records.length, 10);
  const dates = person.records.map((r) => r.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first');
});

test('resolveEntities never mutates the stored object it was given', () => {
  const first = resolveEntities({}, [publication], { now: NOW });
  const snapshot = JSON.parse(JSON.stringify(first.entities));
  resolveEntities(first.entities, [patent, incorporation], { now: NOW });
  assert.deepEqual(first.entities, snapshot);
});

test('empty inputs yield empty entities', () => {
  const { entities, stats } = resolveEntities({}, [], { now: NOW });
  assert.deepEqual(entities, {});
  assert.equal(stats.total, 0);
});
