// node --test backend/signals/resolve/match.test.mjs
//
// Precision matters more than recall here. A false negative loses one lead; a
// false positive INVENTS one, which is the failure that destroys trust in the
// whole product. Both directions are pinned below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANY_MATCH_THRESHOLD,
  PERSON_MATCH_THRESHOLD,
  affiliationTokens,
  companiesMatch,
  matchCompanies,
  matchPersons,
  personsMatch,
} from './match.mjs';

test('an ORCID on both sides is decisive, in both directions', () => {
  const orcid = '0000-0002-1825-0097';
  assert.deepEqual(matchPersons({ name: 'Dupont JM', orcid }, { name: 'Totally Different', orcid }), {
    score: 1,
    reason: 'orcid',
  });
  assert.equal(
    matchPersons({ name: 'Dupont JM', orcid }, { name: 'Dupont JM', orcid: '0000-0001-1111-1111' }).score,
    0,
    'different ORCIDs refute, even with identical names'
  );
});

test('the PubMed / EPO / Pappers spellings of one researcher match', () => {
  // This is THE join the high-priority rule depends on.
  const pubmed = { name: 'Dupont JM', affiliation: 'Institut Pasteur, Paris' };
  const epo = { name: 'DUPONT JEAN-MARC [FR]' };
  const pappers = { name: 'Jean-Marc Dupont', affiliation: 'Président — Neuroscan Medical, Paris' };

  assert.ok(personsMatch(pubmed, epo), 'PubMed <-> EPO');
  assert.ok(personsMatch(epo, pappers), 'EPO <-> Pappers');
  assert.ok(personsMatch(pubmed, pappers), 'PubMed <-> Pappers');
});

test('a shared family name and ONE initial is NOT enough to merge', () => {
  // Two unrelated researchers with no corroborating evidence must stay apart.
  const { score, reason } = matchPersons({ name: 'Bernard A' }, { name: 'Bernard A' });
  assert.ok(score < PERSON_MATCH_THRESHOLD, `expected < ${PERSON_MATCH_THRESHOLD}, got ${score}`);
  assert.match(reason, /family\+initials/);
});

test('two agreeing initials are rarer, and score higher than one', () => {
  const one = matchPersons({ name: 'Bernard A' }, { name: 'Bernard A' });
  const two = matchPersons({ name: 'Bernard AC' }, { name: 'Bernard AC' });
  assert.ok(two.score > one.score);
});

test('a shared affiliation is the corroboration that pushes a match over the line', () => {
  const bare = matchPersons({ name: 'Martin P' }, { name: 'Martin P' });
  const corroborated = matchPersons(
    { name: 'Martin P', affiliation: 'Institut Curie, Orsay' },
    { name: 'Martin P', affiliation: 'Institut Curie, Paris' }
  );
  assert.ok(corroborated.score > bare.score);
  assert.ok(corroborated.score >= PERSON_MATCH_THRESHOLD);
  assert.match(corroborated.reason, /affiliation/);
});

test('conflicting initials, given names or family names refute outright', () => {
  assert.equal(matchPersons({ name: 'Dupont JM' }, { name: 'Dupont PL' }).score, 0);
  assert.equal(matchPersons({ name: 'Jean-Marc Dupont' }, { name: 'Sylvie Dupont' }).score, 0);
  assert.equal(matchPersons({ name: 'Dupont JM' }, { name: 'Durand JM' }).score, 0);
});

test('two full given names that agree score high without any affiliation', () => {
  const { score, reason } = matchPersons({ name: 'Jean-Marc Dupont' }, { name: 'Dupont, Jean-Marc' });
  assert.ok(score >= PERSON_MATCH_THRESHOLD);
  assert.equal(reason, 'full-name');
});

test('very common family names are penalised without corroboration', () => {
  // "Zhang Y" collides constantly in biomedical author lists.
  const common = matchPersons({ name: 'Zhang Y' }, { name: 'Zhang Y' });
  const rare = matchPersons({ name: 'Vandenbroucke J' }, { name: 'Vandenbroucke J' });
  assert.ok(common.score < rare.score);
  assert.ok(common.score < PERSON_MATCH_THRESHOLD);
  assert.match(common.reason, /common-name-penalty/);
});

test('a common name with a shared affiliation still merges', () => {
  const { score } = matchPersons(
    { name: 'Zhang Y', affiliation: 'Karolinska Institutet, Stockholm' },
    { name: 'Zhang Y', affiliation: 'Karolinska Institutet' }
  );
  assert.ok(score >= PERSON_MATCH_THRESHOLD);
});

test('missing names never match', () => {
  assert.equal(matchPersons({ name: '' }, { name: 'Dupont JM' }).score, 0);
  assert.equal(matchPersons({}, {}).score, 0);
});

test('companies match across legal forms and spellings', () => {
  assert.equal(matchCompanies({ name: 'NEUROSCAN MEDICAL SAS' }, { name: 'Neuroscan Medical' }).score, 1);
  assert.ok(companiesMatch({ name: 'Neuroscan Medical S.A.S.' }, { name: 'NeuroScan Medical' }));
});

test('a name that is a prefix of another matches — the common real-world case', () => {
  const { score, reason } = matchCompanies({ name: 'Neuroscan' }, { name: 'Neuroscan Medical' });
  assert.ok(score >= COMPANY_MATCH_THRESHOLD);
  assert.equal(reason, 'prefix');
});

test('two single-token names must be near-identical, not merely similar', () => {
  // Guards against merging "Cardia" with "Cardio", where token overlap has
  // nothing to work with.
  assert.ok(!companiesMatch({ name: 'Cardia' }, { name: 'Cardio' }));
  assert.ok(companiesMatch({ name: 'Neuroscan' }, { name: 'Neuroscann' }), 'a typo still matches');
});

test('unrelated companies do not match', () => {
  assert.ok(!companiesMatch({ name: 'GlucoSense SAS' }, { name: 'Neuroscan Medical' }));
  assert.equal(matchCompanies({ name: '' }, { name: 'X' }).score, 0);
});

test('affiliationTokens keeps only discriminating words', () => {
  // "University"/"Hospital"/"Department" appear in half of all affiliations and
  // would make every pair look related.
  assert.deepEqual([...affiliationTokens('Department of Medicine, University of Bordeaux')], ['bordeaux']);
  assert.deepEqual([...affiliationTokens('')], []);
});
