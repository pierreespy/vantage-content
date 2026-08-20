// Vantage — source registry and the ingestion fan-out.
//
// Wires the six connectors to one shared HTTP handle so the rate limiters are
// GLOBAL: PubMed's 3 req/s is enforced across every caller in the process, not
// per connector. Sources then run CONCURRENTLY — they hit different hosts, so
// there is nothing to gain from serialising them, and the per-host limiters keep
// each one polite on its own.
//
// A source that throws is recorded in `errors` and the run continues with the
// others. That is the same rule the favorites routine applies per startup
// (backend/routine/run.mjs): one bad source must never cost us the whole morning.

import { createHttp } from '../lib/http.mjs';
import { createCache } from '../lib/cache.mjs';
import { createLimiterRegistry } from '../lib/ratelimit.mjs';

import * as pubmed from './pubmed.mjs';
import * as europepmc from './europepmc.mjs';
import * as patents from './patents.mjs';
import * as trials from './trials.mjs';
import * as grants from './grants.mjs';
import * as registry from './registry.mjs';
import * as inpi from './inpi.mjs';

/**
 * The six connectors, each reduced to `id` + how to run it from the config.
 * Adding a source = adding an entry here plus its parser module.
 */
export const SOURCES = [
  {
    id: 'pubmed',
    label: 'PubMed (NCBI E-utilities)',
    run: ({ http, config, now }) =>
      pubmed.fetchPublications({
        http,
        now,
        lookbackDays: config.lookbackDays,
        ...config.pubmed,
      }),
  },
  {
    id: 'europepmc',
    label: 'Europe PMC',
    run: ({ http, config, now }) =>
      europepmc.fetchPublications({
        http,
        now,
        lookbackDays: config.lookbackDays,
        maxPages: config.maxPages,
        ...config.europepmc,
      }),
  },
  {
    id: 'epo',
    label: 'EPO OPS (Espacenet)',
    run: ({ http, config, now, logger }) =>
      patents.fetchPatents({
        http,
        now,
        logger,
        lookbackDays: config.lookbackDays,
        maxPages: config.maxPages,
        ...config.epo,
      }),
  },
  {
    id: 'clinicaltrials',
    label: 'ClinicalTrials.gov v2',
    run: ({ http, config, now }) =>
      trials.fetchTrials({
        http,
        now,
        lookbackDays: config.lookbackDays,
        maxPages: config.maxPages,
        ...config.clinicaltrials,
      }),
  },
  {
    id: 'grants',
    label: 'Concours d’innovation (i-Lab, i-PhD, EIC)',
    run: async ({ http, config, now, logger }) =>
      grants.fetchGrants({
        http,
        now,
        logger,
        lookbackDays: config.slowLookbackDays,
        feeds: await grants.loadFeeds({ overrides: config.grants.overrides }),
      }),
  },
  {
    id: 'inpi',
    label: 'Registre légal (INPI RNE)',
    run: ({ http, config, now, logger }) =>
      inpi.fetchCompanyCreations({
        http,
        now,
        logger,
        // Must span the 6 months the high-priority rule asks about.
        lookbackDays: config.slowLookbackDays,
        maxPages: config.maxPages,
        ...config.inpi,
      }),
  },
  {
    id: 'pappers',
    label: 'Registre légal (Pappers, payant)',
    run: ({ http, config, now, logger }) =>
      registry.fetchCompanyCreations({
        http,
        now,
        logger,
        // Must span the 6 months the high-priority rule asks about.
        lookbackDays: config.slowLookbackDays,
        maxPages: config.maxPages,
        ...config.pappers,
      }),
  },
];

/** Per-host minimum spacing, in ms. The keys are the hosts the connectors call. */
export function hostIntervals(config) {
  return {
    [pubmed.HOST]: config?.pubmed?.apiKey
      ? pubmed.MIN_INTERVAL_MS.withKey
      : pubmed.MIN_INTERVAL_MS.anonymous,
    [europepmc.HOST]: europepmc.MIN_INTERVAL_MS,
    [patents.HOST]: patents.MIN_INTERVAL_MS,
    [trials.HOST]: trials.MIN_INTERVAL_MS,
    [registry.HOST]: registry.MIN_INTERVAL_MS,
    [inpi.HOST]: inpi.MIN_INTERVAL_MS,
  };
}

/**
 * Build the shared HTTP handle: disk cache + per-host limiters + retries.
 *
 * @param {object} config  from config.mjs
 * @param {object} [overrides]  injection points for tests (fetchImpl, now, sleep, cache)
 */
export function createPipelineHttp(config, overrides = {}) {
  const {
    cache = createCache({ dir: config.cacheDir, ttlMs: config.cacheTtlMs }),
    ...rest
  } = overrides;

  return createHttp({
    cache,
    limiters: createLimiterRegistry(hostIntervals(config), {
      // Unknown hosts (a grant feed pointing anywhere) still get paced.
      defaultIntervalMs: 500,
      ...(rest.now ? { now: rest.now } : {}),
      ...(rest.sleep ? { sleep: rest.sleep } : {}),
    }),
    ...rest,
  });
}

/**
 * Run every enabled source and return their records.
 *
 * @param {object} ctx
 * @param {object} ctx.http
 * @param {object} ctx.config
 * @param {number|Date} [ctx.now]
 * @param {object} [ctx.logger]
 * @param {Array} [ctx.sources]  defaults to `SOURCES` (tests pass fakes)
 * @returns {Promise<{ records: object[], bySource: Record<string, object[]>, errors: Array<{source: string, message: string}> }>}
 */
export async function ingestAll(ctx) {
  const { config, sources = SOURCES, logger = console } = ctx;
  const enabled = new Set(config.enabledSources ?? sources.map((s) => s.id));

  const settled = await Promise.all(
    sources
      .filter((source) => enabled.has(source.id))
      .map(async (source) => {
        try {
          const records = await source.run({ ...ctx, logger });
          logger.log?.(`  ${source.id}: ${records.length} record(s)`);
          return { id: source.id, records };
        } catch (err) {
          logger.error?.(`  ${source.id}: FAILED — ${err.message}`);
          return { id: source.id, records: [], error: err.message };
        }
      })
  );

  const bySource = {};
  const records = [];
  const errors = [];
  for (const result of settled) {
    bySource[result.id] = result.records;
    records.push(...result.records);
    if (result.error) errors.push({ source: result.id, message: result.error });
  }

  return { records, bySource, errors };
}
