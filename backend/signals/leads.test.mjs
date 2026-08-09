// node --test backend/signals/leads.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLeads, indexRecords } from './leads.mjs';

const NOW = Date.parse('2026-08-09T00:00:00Z');

/** Entity in the shape resolve/resolve.mjs produces. */
function entity(overrides) {
  return {
    id: 'person:dupont:abcd1234',
    kind: 'person',
    name: 'Jean-Marc Dupont',
    aliases: ['Dupont JM'],
    countries: ['FR'],
    affiliations: [],
    attributes: {},
    records: [],
    links: [],
    firstSeen: '2026-03-05',
    lastSeen: '2026-08-09',
    firstEvidence: '2026-03-02',
    latestEvidence: '2026-06-14',
    ...overrides,
  };
}

/** Record ref as stored on an entity. */
function ref(source, sourceId, kind, date, role) {
  return { source, sourceId, kind, date, title: `${kind} ${sourceId}`, url: `https://x/${sourceId}`, role };
}

/** Full record as an ingest run produces it. */
function record(source, sourceId, kind, date, extra = {}) {
  return {
    source,
    sourceId,
    kind,
    date,
    title: `${kind} ${sourceId}`,
    url: `https://x/${sourceId}`,
    country: extra.country ?? 'FR',
    people: [],
    organizations: [],
    keywords: extra.keywords ?? [],
    extra: extra.extra ?? {},
  };
}

/** A researcher matching the high-priority rule, plus the company entity. */
function highPriorityFixture() {
  const company = entity({
    id: 'company:neuroscan:1111',
    kind: 'company',
    name: 'Neuroscan Medical',
    aliases: [],
    attributes: { siren: '987654321', incorporatedAt: '2026-06-14', orgKind: 'INDUSTRY' },
    records: [ref('pappers', '987654321', 'company_creation', '2026-06-14', 'company')],
    links: ['person:dupont:abcd1234'],
  });
  const person = entity({
    records: [
      ref('europepmc', 'MED:1', 'publication', '2026-03-02', 'author'),
      ref('epo', 'EP4123456A1', 'patent', '2026-05-15', 'inventor'),
    ],
    links: [company.id],
  });
  return { entities: { [person.id]: person, [company.id]: company } };
}

test('a high-priority researcher becomes a lead carrying its signal detail', () => {
  const { entities } = highPriorityFixture();
  const records = [
    record('europepmc', 'MED:1', 'publication', '2026-03-02', { keywords: ['implantable sensor'] }),
    record('epo', 'EP4123456A1', 'patent', '2026-05-15'),
    record('pappers', '987654321', 'company_creation', '2026-06-14'),
  ];

  const { leads } = buildLeads({ entities, records, now: NOW });
  const person = leads.find((lead) => lead.kind === 'person');

  assert.ok(person, 'the researcher is a lead');
  assert.equal(person.priority, 'high');
  assert.ok(person.score >= 80);
  assert.deepEqual(person.rules, ['researcher_patent_newco']);
  assert.equal(person.company, 'Neuroscan Medical');
  assert.equal(person.country, 'FR');
  assert.deepEqual(person.sources.sort(), ['epo', 'europepmc']);
  assert.equal(person.signals.length, 2);
  assert.ok(person.signals.every((s) => typeof s.contribution === 'number'));
  assert.ok(person.keywords.includes('implantable sensor'));
});

test('emittedKeys flag which signals are new, so nothing is re-announced', () => {
  const { entities } = highPriorityFixture();
  const records = [
    record('europepmc', 'MED:1', 'publication', '2026-03-02'),
    record('epo', 'EP4123456A1', 'patent', '2026-05-15'),
  ];
  const { leads } = buildLeads({
    entities,
    records,
    emittedKeys: new Set(['epo:EP4123456A1']),
    now: NOW,
  });

  const person = leads.find((lead) => lead.kind === 'person');
  assert.equal(person.newSignalCount, 1);
  assert.equal(person.signals.find((s) => s.source === 'epo').isNew, true);
  assert.equal(person.signals.find((s) => s.source === 'europepmc').isNew, false);
});

test('a ref from an earlier run still scores even if the record is not in this batch', () => {
  // Entities outlive any single 30-day ingest window — the ref itself carries
  // kind, date, title and url, which is all scoring needs.
  const { entities } = highPriorityFixture();
  const { leads } = buildLeads({ entities, records: [], now: NOW });
  const person = leads.find((lead) => lead.kind === 'person');
  assert.equal(person.signals.length, 2);
  assert.equal(person.priority, 'high');
});

test('a commercial company is a lead; a big academic sponsor is not', () => {
  const hospital = entity({
    id: 'company:chu:2222',
    kind: 'company',
    name: 'CHU de Bordeaux',
    aliases: [],
    attributes: { orgKind: 'OTHER' },
    records: Array.from({ length: 8 }, (_, i) =>
      ref('clinicaltrials', `NCT${i}`, 'trial', '2026-08-01', 'sponsor')
    ),
  });
  const startup = entity({
    id: 'company:gluco:3333',
    kind: 'company',
    name: 'GlucoSense',
    aliases: [],
    attributes: { siren: '123456789', incorporatedAt: '2026-07-02', orgKind: 'INDUSTRY' },
    records: [ref('pappers', '123456789', 'company_creation', '2026-07-02', 'company')],
  });

  const { leads } = buildLeads({
    entities: { [hospital.id]: hospital, [startup.id]: startup },
    records: [],
    now: NOW,
  });

  const names = leads.map((lead) => lead.name);
  assert.ok(names.includes('GlucoSense'), 'a real company is a lead');
  assert.ok(
    !names.includes('CHU de Bordeaux'),
    'a hospital sponsoring 8 trials is an institution, not a spin-out candidate'
  );
});

/** A small non-commercial sponsor of one brand-new trial. */
function academicSponsorFixture(name) {
  const lab = entity({
    id: 'company:lab:4444',
    kind: 'company',
    name,
    aliases: [],
    attributes: { orgKind: 'OTHER' },
    records: [ref('clinicaltrials', 'NCT9', 'trial', '2026-08-05', 'sponsor')],
  });
  const records = [
    record('clinicaltrials', 'NCT9', 'trial', '2026-08-05', {
      extra: { firstPostedAt: '2026-07-25', hasCommercialSponsor: false, leadSponsor: name },
    }),
  ];
  return { entities: { [lab.id]: lab }, records };
}

test('a small non-institutional sponsor of a brand-new trial IS surfaced', () => {
  const { entities, records } = academicSponsorFixture('Laboratoire Cardiovasculaire Rouen');
  const { leads } = buildLeads({ entities, records, now: NOW });
  assert.equal(leads.length, 1);
  assert.equal(leads[0].priority, 'medium');
  assert.deepEqual(leads[0].rules, ['new_trial_no_company']);
});

test('universities, hospitals and foundations are never leads — nobody pitches a university', () => {
  // Learned from a live ClinicalTrials.gov run: without this the medium rule
  // fills the list with institutions instead of spin-out candidates.
  for (const name of [
    'University of Rouen Normandie',
    'The First Affiliated Hospital of Anhui Medical University',
    'CHU de Bordeaux',
    'ADIR Association',
    'Fondation Ophtalmologique Rothschild',
    'Assistance Publique - Hôpitaux de Paris',
  ]) {
    const { entities, records } = academicSponsorFixture(name);
    assert.deepEqual(buildLeads({ entities, records, now: NOW }).leads, [], name);
  }
});

test('when a trial has a named investigator, the PERSON is the lead, not their lab', () => {
  const { entities, records } = academicSponsorFixture('Laboratoire Cardiovasculaire Rouen');
  const investigator = entity({
    id: 'person:lefevre:7777',
    name: 'Marie Lefevre',
    aliases: [],
    records: [ref('clinicaltrials', 'NCT9', 'trial', '2026-08-05', 'investigator')],
  });

  const { leads } = buildLeads({
    entities: { ...entities, [investigator.id]: investigator },
    records,
    now: NOW,
  });

  assert.deepEqual(leads.map((l) => l.name), ['Marie Lefevre'], 'the lab would only duplicate them');
});

test('leads below the minimum score are dropped as noise', () => {
  const faint = entity({
    id: 'person:faint:5555',
    records: [ref('pubmed', 'p1', 'publication', '2024-01-01', 'author')],
  });
  const { leads, stats } = buildLeads({ entities: { [faint.id]: faint }, records: [], now: NOW });
  assert.equal(leads.length, 0);
  assert.equal(stats.skippedBelowMin, 1);

  const kept = buildLeads({ entities: { [faint.id]: faint }, records: [], minScore: 0, now: NOW });
  assert.equal(kept.leads.length, 1);
});

test('entities with no records at all are skipped', () => {
  const empty = entity({ id: 'person:empty:6666', records: [] });
  const { leads } = buildLeads({ entities: { [empty.id]: empty }, records: [], minScore: 0, now: NOW });
  assert.deepEqual(leads, []);
});

test('ordering is deterministic: score, then freshness, then id', () => {
  const build = (id, date) =>
    entity({
      id,
      records: [ref('epo', `pat-${id}`, 'patent', date, 'inventor')],
      latestEvidence: date,
    });

  const entities = {
    b: build('b', '2026-08-01'),
    a: build('a', '2026-08-01'),
    c: build('c', '2026-08-05'),
  };

  const first = buildLeads({ entities, records: [], now: NOW }).leads.map((l) => l.id);
  const second = buildLeads({ entities, records: [], now: NOW }).leads.map((l) => l.id);
  assert.deepEqual(first, second, 'same input, same order — the published file stays stable');
  assert.deepEqual(first, ['c', 'a', 'b'], 'freshest first, then id');
});

test('stats summarise the run', () => {
  const { entities } = highPriorityFixture();
  const { stats } = buildLeads({ entities, records: [], now: NOW });
  assert.equal(stats.high, 1);
  assert.equal(typeof stats.total, 'number');
});

test('indexRecords keys on source + sourceId', () => {
  const index = indexRecords([record('pubmed', '1', 'publication', '2026-08-01')]);
  assert.ok(index.has('pubmed:1'));
  assert.equal(indexRecords([{ source: 'x' }]).size, 0, 'a record without an id is not indexable');
});
