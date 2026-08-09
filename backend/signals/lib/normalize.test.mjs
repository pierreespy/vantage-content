// node --test backend/signals/lib/normalize.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  basicNormalize,
  companyTokens,
  foldDiacritics,
  jaccard,
  jaroWinkler,
  normalizeCompany,
  hasLegalForm,
  normalizeCountry,
  parsePerson,
} from './normalize.mjs';

test('foldDiacritics and basicNormalize flatten accents and punctuation', () => {
  assert.equal(foldDiacritics('Jérôme Müller'), 'Jerome Muller');
  assert.equal(basicNormalize('Bio-Tech S.A.S. !'), 'bio tech s a s');
});

test('normalizeCompany collapses the spellings the sources really produce', () => {
  // The exact case from the module header: Pappers vs EPO vs ClinicalTrials.gov.
  const expected = 'neuroscan medical';
  for (const name of [
    'NEUROSCAN MEDICAL SAS',
    'Neuroscan Medical S.A.S.',
    'NeuroScan Medical',
    'Neuroscan  Medical, SAS',
  ]) {
    assert.equal(normalizeCompany(name), expected, name);
  }
});

test('normalizeCompany strips stacked legal forms but never empties a name', () => {
  assert.equal(normalizeCompany('Adler Ortho Holding GmbH & Co KG'), 'adler ortho');
  // A company genuinely called "Corp" must keep something to match on.
  assert.equal(normalizeCompany('Corp'), 'corp');
  assert.equal(normalizeCompany('SAS'), 'sas');
  assert.equal(normalizeCompany(''), '');
});

test('hasLegalForm spots a real incorporation, and only that', () => {
  // Live ClinicalTrials.gov data classes some sponsors `OTHER` while naming them
  // "VASCage GmbH" — the medium rule is about the ABSENCE of a company, so the
  // name has to be trusted alongside the declared class.
  for (const name of ['VASCage GmbH', 'Neuroscan Medical SAS', 'Acme Devices Ltd', 'GlucoSense S.A.S.']) {
    assert.equal(hasLegalForm(name), true, name);
  }
  for (const name of ['University of Rouen Normandie', 'CHU de Bordeaux', 'Cardiovascular Research Group', 'Owkin', '']) {
    assert.equal(hasLegalForm(name), false, name);
  }
});

test('parsePerson recovers the same key from all three source conventions', () => {
  // This IS the join that makes the high-priority rule possible.
  const pubmed = parsePerson('Dupont JM'); // E-utilities
  const epo = parsePerson('DUPONT Jean-Marc [FR]'); // EPO OPS
  const pappers = parsePerson('Jean-Marc Dupont'); // registry
  const csv = parsePerson('Dupont, Jean-Marc'); // grant export

  assert.equal(pubmed.key, 'dupont|j');
  assert.equal(epo.key, 'dupont|j');
  assert.equal(pappers.key, 'dupont|j');
  assert.equal(csv.key, 'dupont|j');
  assert.equal(epo.family, 'dupont');
  assert.equal(epo.given, 'jean marc');
});

test('an all-uppercase name puts the family name FIRST, as EPO writes them', () => {
  // Regression guard: treating "DUPONT JEAN-MARC" as Western order read JEAN-MARC
  // as the family name and silently broke the PubMed <-> EPO join.
  const epo = parsePerson('DUPONT JEAN-MARC');
  assert.equal(epo.family, 'dupont');
  assert.equal(epo.given, 'jean marc');
  assert.equal(parsePerson('LEFEVRE MARIE').family, 'lefevre');
});

test('parsePerson flags a given name reconstructed from initials', () => {
  // Matching must not compare "j m" against a real given name as if both were
  // spelled out — that refuted "Dupont JM" vs "Jean-Marc Dupont".
  assert.equal(parsePerson('Dupont JM').initialsOnly, true);
  assert.equal(parsePerson('Jean-Marc Dupont').initialsOnly, false);
  assert.equal(parsePerson('DUPONT JEAN-MARC').initialsOnly, false);
});

test('parsePerson keeps particles with the family name', () => {
  const person = parsePerson('Jean de La Fontaine');
  assert.equal(person.family, 'de la fontaine');
  assert.equal(person.given, 'jean');

  const dutch = parsePerson('Sanne van den Berg');
  assert.equal(dutch.family, 'van den berg');
  assert.equal(dutch.given, 'sanne');
});

test('parsePerson degrades safely on junk', () => {
  assert.equal(parsePerson('').key, '');
  assert.equal(parsePerson(null).key, '');
  assert.equal(parsePerson('Prince').family, 'prince');
});

test('jaccard and jaroWinkler behave at the edges', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  assert.equal(jaccard(new Set(), new Set(['a'])), 0); // empty is never a match

  assert.equal(jaroWinkler('owkin', 'owkin'), 1);
  assert.equal(jaroWinkler('', 'owkin'), 0);
  assert.ok(jaroWinkler('neuroscan', 'neuroscann') > 0.95);
  assert.ok(jaroWinkler('cardia', 'pulmona') < 0.6);
});

test('companyTokens drops stopwords so overlap stays meaningful', () => {
  assert.deepEqual([...companyTokens('The Institute of Cardiology')], ['institute', 'cardiology']);
});

test('normalizeCountry accepts codes and the names the sources spell out', () => {
  assert.equal(normalizeCountry('fr'), 'FR');
  assert.equal(normalizeCountry('France'), 'FR');
  assert.equal(normalizeCountry('United States'), 'US');
  assert.equal(normalizeCountry('Allemagne'), 'DE');
  assert.equal(normalizeCountry('Freedonia'), '');
  assert.equal(normalizeCountry(undefined), '');
});
