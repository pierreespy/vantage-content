// node --test backend/signals/pipeline.test.mjs
//
// END-TO-END integration test: ingest -> diff -> resolve -> score -> publish,
// through the REAL connectors and the real state store. Only two things are
// faked — `fetch` (a router over recorded-shape payloads) and the clock — so
// nothing touches the network and the run is reproducible.
//
// The scenario is the product's headline case: Jean-Marc Dupont publishes
// (Europe PMC + PubMed), files a patent (EPO), and incorporates Neuroscan
// Medical (INPI RNE) — while, separately, a CHU registers a new trial with no
// company behind it. The run must end with one high-priority and one
// medium-priority lead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPipeline } from './run.mjs';
import { createPipelineHttp } from './sources/index.mjs';
import { loadConfig } from './config.mjs';

const NOW = Date.parse('2026-08-09T00:00:00Z');

const PAYLOADS = {
  esearch: { esearchresult: { idlist: ['40112233'] } },
  esummary: {
    result: {
      uids: ['40112233'],
      40112233: {
        uid: '40112233',
        pubdate: '2026 Mar 2',
        epubdate: '',
        fulljournalname: 'Nature Biomedical Engineering',
        authors: [{ name: 'Dupont JM', authtype: 'Author' }],
        title: 'A miniaturised implantable sensor for continuous cardiac monitoring',
        articleids: [{ idtype: 'pubmed', value: '40112233' }],
      },
    },
  },
  europepmc: {
    resultList: {
      result: [
        {
          id: '40112233',
          source: 'MED',
          pmid: '40112233',
          doi: '10.1038/s41551-026-01234-5',
          title: 'A miniaturised implantable sensor for continuous cardiac monitoring',
          firstPublicationDate: '2026-03-02',
          authorList: {
            author: [
              {
                fullName: 'Dupont Jean-Marc',
                authorId: { type: 'ORCID', value: '0000-0002-1825-0097' },
                authorAffiliationDetailsList: {
                  authorAffiliation: [{ affiliation: 'Institut Pasteur, Paris, France' }],
                },
              },
            ],
          },
          journalInfo: { journal: { title: 'Nature Biomedical Engineering' } },
          keywordList: { keyword: ['implantable sensor'] },
        },
      ],
    },
    nextCursorMark: '*',
  },
  epoToken: { access_token: 'ops-token', expires_in: '1200' },
  epoSearch: {
    'ops:world-patent-data': {
      'ops:biblio-search': {
        '@total-result-count': '1',
        'ops:search-result': {
          'exchange-documents': {
            'exchange-document': {
              'bibliographic-data': {
                'publication-reference': {
                  'document-id': {
                    '@document-id-type': 'docdb',
                    country: { $: 'EP' },
                    'doc-number': { $: '4123456' },
                    kind: { $: 'A1' },
                    date: { $: '20260515' },
                  },
                },
                'invention-title': { '@lang': 'en', $: 'Implantable cardiac sensor' },
                parties: {
                  applicants: { applicant: { 'applicant-name': { name: { $: 'NEUROSCAN MEDICAL SAS' } } } },
                  inventors: { inventor: { 'inventor-name': { name: { $: 'DUPONT JEAN-MARC [FR]' } } } },
                },
              },
            },
          },
        },
      },
    },
  },
  trials: {
    studies: [
      {
        protocolSection: {
          identificationModule: { nctId: 'NCT06123456', briefTitle: 'Catheter-based renal denervation' },
          statusModule: {
            overallStatus: 'RECRUITING',
            studyFirstPostDateStruct: { date: '2026-07-20' },
            lastUpdatePostDateStruct: { date: '2026-08-05' },
          },
          sponsorCollaboratorsModule: { leadSponsor: { name: 'CHU de Bordeaux', class: 'OTHER' } },
          contactsLocationsModule: {
            // A named investigator: the medium-priority signal belongs to HER,
            // not to the hospital that employs her.
            overallOfficials: [
              { name: 'Marie Lefevre', affiliation: 'CHU de Bordeaux', role: 'PRINCIPAL_INVESTIGATOR' },
            ],
            locations: [{ country: 'France' }],
          },
          conditionsModule: { conditions: ['Hypertension'] },
        },
      },
    ],
  },
  inpiLogin: { token: 'inpi-token' },
  inpi: {
    totalSize: 1,
    page: 1,
    maxPage: 1,
    pageSize: 100,
    results: [
      {
        siren: '987654321',
        formeJuridique: '5710',
        created: '2026-06-20T09:00:00.000Z',
        content: {
          natureCreation: { dateCreation: '2026-06-14' },
          personneMorale: {
            identite: {
              entreprise: {
                siren: '987654321',
                denomination: 'NEUROSCAN MEDICAL',
                codeApe: '2660Z',
                dateImmat: '2026-06-14',
                objet: 'Conception de capteurs cardiaques implantables',
              },
            },
            composition: {
              pouvoirs: [
                {
                  libelleRoleEntreprise: 'Président',
                  individu: { descriptionPersonne: { nom: 'Dupont', prenoms: ['Jean-Marc'] } },
                },
              ],
            },
          },
        },
      },
    ],
  },
};

/** Route a URL to its payload, the way the real hosts would. */
function fakeFetch(counter = { calls: 0 }) {
  return async (url) => {
    counter.calls += 1;
    const body = (() => {
      if (url.includes('esearch.fcgi')) return PAYLOADS.esearch;
      if (url.includes('esummary.fcgi')) return PAYLOADS.esummary;
      if (url.includes('ebi.ac.uk')) return PAYLOADS.europepmc;
      if (url.includes('ops.epo.org/3.2/auth')) return PAYLOADS.epoToken;
      if (url.includes('ops.epo.org')) return PAYLOADS.epoSearch;
      if (url.includes('clinicaltrials.gov')) return PAYLOADS.trials;
      if (url.includes('inpi.fr/api/sso/login')) return PAYLOADS.inpiLogin;
      if (url.includes('inpi.fr')) return PAYLOADS.inpi;
      throw new Error(`unexpected url in test: ${url}`);
    })();

    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  };
}

/** Config + http wired onto temp dirs, a stub fetch and a frozen clock. */
async function makeHarness(dir, counter) {
  const config = {
    ...loadConfig({}),
    stateDir: join(dir, 'signal-state'),
    leadsPath: join(dir, 'medtech-leads.json'),
    cacheTtlMs: 0, // no caching: each run must really re-query the stubs
    epo: { key: 'k', secret: 's', ipcClasses: undefined },
    inpi: { username: 'a@b.c', password: 'pw', apeCodes: undefined },
  };

  const http = createPipelineHttp(config, {
    fetchImpl: fakeFetch(counter),
    now: () => NOW,
    sleep: async () => {},
  });

  return { config, http };
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'vantage-pipeline-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const silent = { log: () => {}, warn: () => {}, error: () => {} };

test('a full run produces the high- and medium-priority leads', async () => {
  await withTempDir(async (dir) => {
    const { config, http } = await makeHarness(dir, { calls: 0 });
    const { leads, file } = await runPipeline({ config, http, now: NOW, logger: silent });

    // The headline case: one researcher, four sources, three signal kinds.
    const dupont = leads.find((lead) => lead.name.includes('Dupont'));
    assert.ok(dupont, `no Dupont lead in ${leads.map((l) => l.name).join(' / ')}`);
    assert.equal(dupont.priority, 'high');
    assert.ok(dupont.score >= 80, `score was ${dupont.score}`);
    assert.deepEqual(dupont.rules, ['researcher_patent_newco']);
    // EPO and the registry both shout their names, and we never invent a casing
    // a source did not use — title-casing would mangle legal forms ("SAS" ->
    // "Sas"). So the fullest spelling seen is what gets displayed.
    assert.equal(dupont.company, 'NEUROSCAN MEDICAL SAS');
    assert.match(dupont.reasons[0], /société créée/);

    // The three source kinds really did join onto one person.
    const kinds = new Set(dupont.signals.map((signal) => signal.recordKind));
    assert.deepEqual(kinds, new Set(['publication', 'patent', 'company_creation']));
    assert.ok(dupont.signals.every((signal) => signal.isNew), 'everything is new on a first run');

    // The academic trial with no company behind it surfaces through its
    // investigator — the hospital itself is filtered out as an institution.
    const trialLead = leads.find((lead) => lead.rules.includes('new_trial_no_company'));
    assert.ok(trialLead, 'the CHU trial should surface as a medium-priority lead');
    assert.equal(trialLead.priority, 'medium');
    assert.equal(trialLead.kind, 'person');
    assert.equal(trialLead.name, 'Marie Lefevre');
    assert.ok(
      !leads.some((lead) => lead.name.includes('CHU')),
      'a hospital is never a sourcing lead'
    );

    assert.equal(file.counts.high >= 1, true);
    assert.equal(file.errors.length, 0);
  });
});

test('the published file is written, well-formed and self-describing', async () => {
  await withTempDir(async (dir) => {
    const { config, http } = await makeHarness(dir, { calls: 0 });
    await runPipeline({ config, http, now: NOW, logger: silent });

    const published = JSON.parse(await readFile(config.leadsPath, 'utf8'));
    assert.equal(published.generatedAt, '2026-08-09');
    assert.equal(published.generatedAtLong, '9 août 2026');
    assert.ok(Array.isArray(published.leads));
    // Every connector reports what it contributed, so a degraded run is visible
    // in the git diff rather than silent.
    const byId = Object.fromEntries(published.sources.map((source) => [source.id, source]));
    assert.equal(byId.inpi.records, 1);
    assert.equal(byId.epo.records, 1);
    assert.equal(byId.clinicaltrials.records, 1);
    assert.equal(byId.grants.records, 0, 'the shipped grant feeds are empty placeholders');
  });
});

test('state is persisted per source, and a second run emits nothing new', async () => {
  await withTempDir(async (dir) => {
    const counter = { calls: 0 };
    const { config, http } = await makeHarness(dir, counter);

    await runPipeline({ config, http, now: NOW, logger: silent });
    const state = JSON.parse(await readFile(join(config.stateDir, 'clinicaltrials.json'), 'utf8'));
    assert.equal(state.records['clinicaltrials:NCT06123456'].fp, 'RECRUITING|2026-08-05');

    // Second run, same payloads: the diffing step must find nothing to announce.
    const second = await runPipeline({ config, http, now: NOW, logger: silent });
    const dupont = second.leads.find((lead) => lead.name.includes('Dupont'));
    assert.equal(dupont.newSignalCount, 0, 'nothing is re-announced');
    assert.equal(dupont.priority, 'high', 'but the lead itself is still there');
  });
});

test('a changed trial status re-emits as a new signal', async () => {
  await withTempDir(async (dir) => {
    const { config, http } = await makeHarness(dir, { calls: 0 });
    await runPipeline({ config, http, now: NOW, logger: silent });

    // The trial moves on: same NCT id, new status and update date.
    PAYLOADS.trials.studies[0].protocolSection.statusModule.overallStatus = 'ACTIVE_NOT_RECRUITING';
    PAYLOADS.trials.studies[0].protocolSection.statusModule.lastUpdatePostDateStruct.date = '2026-08-08';
    try {
      const second = await runPipeline({ config, http, now: NOW, logger: silent });
      const trialLead = second.leads.find((lead) => lead.rules.includes('new_trial_no_company'));
      assert.ok(trialLead.signals.some((signal) => signal.isNew), 'the status change is a fresh signal');
    } finally {
      PAYLOADS.trials.studies[0].protocolSection.statusModule.overallStatus = 'RECRUITING';
      PAYLOADS.trials.studies[0].protocolSection.statusModule.lastUpdatePostDateStruct.date = '2026-08-05';
    }
  });
});

test('one failing source degrades the run instead of aborting it', async () => {
  await withTempDir(async (dir) => {
    const { config } = await makeHarness(dir, { calls: 0 });
    const base = fakeFetch();
    const http = createPipelineHttp(config, {
      fetchImpl: async (url, options) => {
        if (url.includes('inpi.fr')) throw new Error('inpi is down');
        return base(url, options);
      },
      now: () => NOW,
      sleep: async () => {},
    });

    const { leads, stats } = await runPipeline({ config, http, now: NOW, logger: silent });
    assert.equal(stats.errors.length, 1);
    assert.equal(stats.errors[0].source, 'inpi');
    // Without the incorporation the high-priority rule cannot fire, but the
    // publication + patent lead still exists.
    const dupont = leads.find((lead) => lead.name.includes('Dupont'));
    assert.ok(dupont, 'the researcher is still a lead');
    assert.deepEqual(dupont.rules, [], 'the rule needs the incorporation');
  });
});

test('DRY_RUN writes nothing to disk', async () => {
  await withTempDir(async (dir) => {
    const { config, http } = await makeHarness(dir, { calls: 0 });
    const { leads } = await runPipeline(
      { config: { ...config, dryRun: true }, http, now: NOW, logger: silent }
    );
    assert.ok(leads.length > 0, 'it still computes everything');
    await assert.rejects(readFile(config.leadsPath, 'utf8'), /ENOENT/);
  });
});

test('a source disabled by config is not queried at all', async () => {
  await withTempDir(async (dir) => {
    const { config, http } = await makeHarness(dir, { calls: 0 });
    const { file } = await runPipeline({
      config: { ...config, enabledSources: ['clinicaltrials'] },
      http,
      now: NOW,
      logger: silent,
    });
    assert.deepEqual(file.sources.map((source) => source.id), ['clinicaltrials']);
  });
});
