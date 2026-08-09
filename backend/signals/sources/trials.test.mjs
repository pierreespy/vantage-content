// node --test backend/signals/sources/trials.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl, fetchTrials, parseStudies } from './trials.mjs';

/** Shape of a real ClinicalTrials.gov v2 `/studies` page. */
const STUDIES_FIXTURE = {
  studies: [
    {
      protocolSection: {
        identificationModule: { nctId: 'NCT06123456', briefTitle: 'Catheter-based renal denervation' },
        statusModule: {
          overallStatus: 'RECRUITING',
          studyFirstPostDateStruct: { date: '2026-07-20' },
          lastUpdatePostDateStruct: { date: '2026-08-05' },
        },
        sponsorCollaboratorsModule: {
          leadSponsor: { name: 'CHU de Bordeaux', class: 'OTHER' },
          collaborators: [{ name: 'Inserm', class: 'OTHER_GOV' }],
        },
        designModule: { phases: ['PHASE2'] },
        contactsLocationsModule: {
          overallOfficials: [
            { name: 'Marie Lefevre', affiliation: 'CHU de Bordeaux', role: 'PRINCIPAL_INVESTIGATOR' },
          ],
          locations: [{ country: 'France', city: 'Bordeaux' }, { country: 'Belgium', city: 'Gent' }],
        },
        conditionsModule: { conditions: ['Hypertension'], keywords: ['denervation'] },
      },
    },
    {
      protocolSection: {
        identificationModule: { nctId: 'NCT06999999', briefTitle: 'Wearable glucose sensor validation' },
        statusModule: {
          overallStatus: 'NOT_YET_RECRUITING',
          studyFirstPostDateStruct: { date: '2026-08-01' },
          lastUpdatePostDateStruct: { date: '2026-08-01' },
        },
        sponsorCollaboratorsModule: { leadSponsor: { name: 'GlucoSense SAS', class: 'INDUSTRY' } },
        contactsLocationsModule: { locations: [{ country: 'France' }] },
      },
    },
  ],
  nextPageToken: 'TOKEN2',
};

test('buildSearchUrl filters on LastUpdatePostDate — new AND changed in one query', () => {
  const url = new URL(buildSearchUrl({ since: '2026-07-10', until: '2026-08-09', query: 'AREA[X]Y' }));
  const advanced = url.searchParams.get('filter.advanced');
  assert.match(advanced, /AREA\[LastUpdatePostDate\]RANGE\[2026-07-10,2026-08-09\]/);
  assert.match(advanced, /AREA\[X\]Y/);
  assert.equal(url.searchParams.get('pageSize'), '100');
});

test('parseStudies maps identification, status and sponsors', () => {
  const [trial] = parseStudies(STUDIES_FIXTURE);
  assert.equal(trial.source, 'clinicaltrials');
  assert.equal(trial.sourceId, 'NCT06123456');
  assert.equal(trial.kind, 'trial');
  assert.equal(trial.date, '2026-08-05', 'dated by when it MOVED, not when it was registered');
  assert.equal(trial.url, 'https://clinicaltrials.gov/study/NCT06123456');
  assert.equal(trial.country, 'FR', 'first location, normalized to ISO-3166');
  assert.deepEqual(trial.extra.countries, ['France', 'Belgium']);
  assert.deepEqual(trial.extra.phases, ['PHASE2']);
});

test('the fingerprint is status + last update — that is what makes a change a signal', () => {
  const [trial] = parseStudies(STUDIES_FIXTURE);
  assert.equal(trial.fingerprint, 'RECRUITING|2026-08-05');
});

test('sponsor class drives hasCommercialSponsor, the medium-priority rule input', () => {
  const [academic, industry] = parseStudies(STUDIES_FIXTURE);
  assert.equal(academic.extra.sponsorClass, 'OTHER');
  assert.equal(academic.extra.hasCommercialSponsor, false, 'a CHU is not a company');
  assert.equal(industry.extra.hasCommercialSponsor, true, 'INDUSTRY means a company exists');
});

test('overall officials become investigator people we can join on', () => {
  const [trial] = parseStudies(STUDIES_FIXTURE);
  assert.deepEqual(trial.people, [
    { name: 'Marie Lefevre', role: 'investigator', affiliation: 'CHU de Bordeaux' },
  ]);
});

test('sponsors and collaborators are kept with their class', () => {
  const [trial] = parseStudies(STUDIES_FIXTURE);
  assert.deepEqual(trial.organizations, [
    { name: 'CHU de Bordeaux', role: 'sponsor', kind: 'OTHER' },
    { name: 'Inserm', role: 'collaborator', kind: 'OTHER_GOV' },
  ]);
});

test('parseStudies tolerates missing modules and a missing nctId', () => {
  assert.deepEqual(parseStudies({ studies: [{}, { protocolSection: {} }] }), []);
  assert.deepEqual(parseStudies({}), []);
  assert.deepEqual(parseStudies(null), []);
});

test('fetchTrials follows nextPageToken and stops when it disappears', async () => {
  const seen = [];
  const http = {
    json: async (url) => {
      seen.push(url);
      return seen.length === 1 ? STUDIES_FIXTURE : { studies: [] };
    },
  };
  const records = await fetchTrials({ http, now: Date.parse('2026-08-09T00:00:00Z') });
  assert.equal(records.length, 2);
  assert.equal(seen.length, 2);
  assert.match(seen[1], /pageToken=TOKEN2/);
});

test('fetchTrials respects maxPages so a broad query cannot run away', async () => {
  let calls = 0;
  const http = {
    json: async () => {
      calls += 1;
      return { studies: [], nextPageToken: 'ALWAYS' };
    },
  };
  await fetchTrials({ http, maxPages: 3 });
  assert.equal(calls, 3);
});
