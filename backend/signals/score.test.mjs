// node --test backend/signals/score.test.mjs
//
// The two priority rules are a product promise, so they are pinned directly:
//   >= 80  chercheur/auteur + brevet déposé + création de société < 6 mois
//   >= 50  nouvel essai ClinicalTrials sans structure commerciale associée
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIGH_PRIORITY_SCORE,
  MEDIUM_PRIORITY_SCORE,
  priorityFor,
  recencyFactor,
  scoreLead,
} from './score.mjs';

const NOW = Date.parse('2026-08-09T00:00:00Z');

/** Hydrated record, reduced to what scoring reads. */
function rec(kind, date, overrides = {}) {
  return {
    kind,
    date,
    source: overrides.source ?? kind,
    sourceId: overrides.sourceId ?? `${kind}-1`,
    title: overrides.title ?? `${kind} title`,
    url: overrides.url ?? '',
    extra: overrides.extra ?? {},
  };
}

test('recencyFactor is flat while fresh, then decays to a floor', () => {
  assert.equal(recencyFactor(0), 1);
  assert.equal(recencyFactor(30), 1, 'a 30-day-old signal is still fully fresh');
  assert.equal(recencyFactor(365), 0.35);
  assert.equal(recencyFactor(10_000), 0.35, 'never below the floor');
  const mid = recencyFactor(200);
  assert.ok(mid > 0.35 && mid < 1);
  assert.equal(recencyFactor(NaN), 0.35);
});

test('priorityFor maps scores onto the two announced thresholds', () => {
  assert.equal(priorityFor(80), 'high');
  assert.equal(priorityFor(79), 'medium');
  assert.equal(priorityFor(50), 'medium');
  assert.equal(priorityFor(49), 'low');
});

test('HIGH: author + patent + company incorporated 2 months ago scores >= 80', () => {
  const result = scoreLead({
    records: [rec('publication', '2026-03-02', { source: 'europepmc' }), rec('patent', '2026-05-15', { source: 'epo' })],
    context: { linkedCompanies: [{ name: 'Neuroscan Medical', incorporatedAt: '2026-06-14' }] },
    now: NOW,
  });

  assert.ok(result.score >= HIGH_PRIORITY_SCORE, `score was ${result.score}`);
  assert.equal(result.priority, 'high');
  assert.deepEqual(result.rules, ['researcher_patent_newco']);
  assert.match(result.reasons[0], /brevet déposé/);
  assert.match(result.reasons[0], /2026-06-14/);
});

test('HIGH also fires when the incorporation is a record on the person', () => {
  // Pappers lists the researcher as a director — no linked company entity needed.
  const result = scoreLead({
    records: [
      rec('publication', '2026-03-02', { source: 'europepmc' }),
      rec('patent', '2026-05-15', { source: 'epo' }),
      rec('company_creation', '2026-06-14', { source: 'pappers' }),
    ],
    now: NOW,
  });
  assert.ok(result.score >= HIGH_PRIORITY_SCORE);
  assert.ok(result.rules.includes('researcher_patent_newco'));
});

test('HIGH does not fire without a patent, without a publication, or without a new company', () => {
  const base = {
    records: [rec('publication', '2026-03-02'), rec('patent', '2026-05-15')],
    context: { linkedCompanies: [{ name: 'X', incorporatedAt: '2026-06-14' }] },
    now: NOW,
  };

  assert.deepEqual(scoreLead({ ...base, records: [rec('publication', '2026-03-02')] }).rules, [], 'no patent');
  assert.deepEqual(scoreLead({ ...base, records: [rec('patent', '2026-05-15')] }).rules, [], 'no publication');
  assert.deepEqual(scoreLead({ ...base, context: { linkedCompanies: [] } }).rules, [], 'no company');
});

test('HIGH does not fire when the company is older than six months', () => {
  const result = scoreLead({
    records: [rec('publication', '2026-03-02'), rec('patent', '2026-05-15')],
    // 2025-06-14 is well over six months before 2026-08-09.
    context: { linkedCompanies: [{ name: 'X', incorporatedAt: '2025-06-14' }] },
    now: NOW,
  });
  assert.deepEqual(result.rules, []);
  assert.ok(result.score < HIGH_PRIORITY_SCORE);
});

test('MEDIUM: a new trial with a non-commercial sponsor scores >= 50', () => {
  const result = scoreLead({
    records: [
      rec('trial', '2026-08-05', {
        source: 'clinicaltrials',
        sourceId: 'NCT06123456',
        extra: { firstPostedAt: '2026-07-20', hasCommercialSponsor: false },
      }),
    ],
    context: {
      linkedCompanies: [],
      hasCommercialSponsor: false,
      sponsorLabel: 'CHU de Bordeaux',
      trialFirstPostedById: { NCT06123456: '2026-07-20' },
    },
    now: NOW,
  });

  assert.ok(result.score >= MEDIUM_PRIORITY_SCORE, `score was ${result.score}`);
  assert.equal(result.priority, 'medium');
  assert.deepEqual(result.rules, ['new_trial_no_company']);
  assert.match(result.reasons[0], /sans structure commerciale/);
  assert.match(result.reasons[0], /CHU de Bordeaux/);
});

test('MEDIUM does not fire when a company IS behind the trial', () => {
  const records = [
    rec('trial', '2026-08-05', {
      source: 'clinicaltrials',
      sourceId: 'NCT1',
      extra: { firstPostedAt: '2026-07-20', hasCommercialSponsor: true },
    }),
  ];

  assert.deepEqual(
    scoreLead({
      records,
      context: { hasCommercialSponsor: true, trialFirstPostedById: { NCT1: '2026-07-20' } },
      now: NOW,
    }).rules,
    [],
    'INDUSTRY sponsor'
  );

  assert.deepEqual(
    scoreLead({
      records,
      context: {
        linkedCompanies: [{ name: 'GlucoSense', incorporatedAt: '2026-01-01' }],
        trialFirstPostedById: { NCT1: '2026-07-20' },
      },
      now: NOW,
    }).rules,
    [],
    'a company entity is already linked'
  );
});

test('MEDIUM does not fire on a trial that is no longer new', () => {
  const result = scoreLead({
    records: [rec('trial', '2026-08-05', { sourceId: 'NCT1', extra: { firstPostedAt: '2025-01-10' } })],
    context: { trialFirstPostedById: { NCT1: '2025-01-10' } },
    now: NOW,
  });
  assert.deepEqual(result.rules, []);
});

test('the floor only ever RAISES a score, never lowers it', () => {
  // Weighted sum here is already above 80; matching the rule must not cap it back.
  const result = scoreLead({
    records: [
      rec('company_creation', '2026-06-14', { source: 'pappers' }),
      rec('patent', '2026-05-15', { source: 'epo' }),
      rec('publication', '2026-07-02', { source: 'europepmc' }),
      rec('trial', '2026-07-30', { source: 'clinicaltrials' }),
      rec('grant', '2026-06-01', { source: 'grants' }),
    ],
    now: NOW,
  });
  assert.ok(result.rules.includes('researcher_patent_newco'));
  assert.equal(result.score, 100, 'weighted sum saturates and stays there');
});

test('repeat signals of one kind add a little, then stop', () => {
  const one = scoreLead({ records: [rec('patent', '2026-07-01', { sourceId: 'a' })], now: NOW });
  const many = scoreLead({
    records: Array.from({ length: 10 }, (_, i) => rec('patent', '2026-07-01', { sourceId: `p${i}` })),
    now: NOW,
  });
  assert.ok(many.score > one.score, 'a second patent IS worth something');
  assert.ok(many.score - one.score <= 12, 'but a prolific filer cannot brute-force the score');
});

test('corroboration across independent sources is rewarded and capped', () => {
  const single = scoreLead({
    records: [rec('publication', '2026-07-01', { source: 'pubmed', sourceId: 'a' })],
    now: NOW,
  });
  const corroborated = scoreLead({
    records: [
      rec('publication', '2026-07-01', { source: 'pubmed', sourceId: 'a' }),
      rec('patent', '2026-07-01', { source: 'epo', sourceId: 'b' }),
      rec('grant', '2026-07-01', { source: 'grants', sourceId: 'c' }),
    ],
    now: NOW,
  });
  assert.ok(corroborated.score > single.score);
  assert.match(corroborated.reasons.join(' '), /3 sources indépendantes/);
});

test('an old signal scores lower than the same signal fresh', () => {
  const fresh = scoreLead({ records: [rec('patent', '2026-08-01')], now: NOW });
  const old = scoreLead({ records: [rec('patent', '2024-01-01')], now: NOW });
  assert.ok(fresh.score > old.score);
  assert.ok(old.score > 0, 'an old signal still corroborates, it is just not news');
});

test('each signal carries its own contribution, so a score can be audited', () => {
  const result = scoreLead({
    records: [rec('patent', '2026-08-01', { source: 'epo' }), rec('publication', '2026-08-01', { source: 'pubmed' })],
    now: NOW,
  });
  const patent = result.signals.find((s) => s.recordKind === 'patent');
  const publication = result.signals.find((s) => s.recordKind === 'publication');
  assert.equal(patent.contribution, 25);
  assert.equal(publication.contribution, 15);
  assert.equal(patent.signalType, 'patent_filing', 'the app’s own vocabulary');
  assert.equal(publication.signalType, 'publication_preprint');
});

test('no records means no score, and no crash', () => {
  const result = scoreLead({ records: [], now: NOW });
  assert.deepEqual(result, { score: 0, priority: 'low', signals: [], reasons: [], rules: [] });
  assert.equal(scoreLead({}).score, 0);
});

test('unknown record kinds are ignored rather than scored at zero weight', () => {
  const result = scoreLead({ records: [rec('horoscope', '2026-08-01')], now: NOW });
  assert.equal(result.signals.length, 0);
  assert.equal(result.score, 0);
});
