// Vantage — MedTech weak-signal pipeline orchestrator.
//
// One run, five steps:
//
//   1. INGEST   the six public sources concurrently, each rate-limited and cached
//               (sources/index.mjs);
//   2. DIFF     each source's records against `signal-state/<source>.json` — only
//               what is NEW or CHANGED counts as an emitted signal (lib/state.mjs);
//   3. RESOLVE  merge the records into persistent entities, joining researchers to
//               inventors to company directors (resolve/resolve.mjs);
//   4. SCORE    weighted signals + the two rule floors (score.mjs, leads.mjs);
//   5. PUBLISH  write `medtech-leads.json`; the workflow commits it alongside the
//               updated state (publish.mjs).
//
// Run it:
//   node backend/signals/run.mjs
//   DRY_RUN=1 node backend/signals/run.mjs     # no writes, prints a summary
//
// Env: see .env.example. Every credential is optional — a source without one is
// skipped with a warning, and the run still produces leads from the others.

import { loadConfig } from './config.mjs';
import { createPipelineHttp, ingestAll, SOURCES } from './sources/index.mjs';
import { createStateStore, diffRecords } from './lib/state.mjs';
import { resolveEntities } from './resolve/resolve.mjs';
import { buildLeads } from './leads.mjs';
import { buildLeadsFile, writeLeadsFile } from './publish.mjs';
import { isoDay } from './lib/dates.mjs';

/**
 * Run the whole pipeline.
 *
 * Exported (and fully injectable) so the integration test can drive it end to end
 * with a stub fetch, a temp state dir and a fixed clock — no network, no wall clock.
 *
 * @param {object} [opts]
 * @param {object} [opts.config]  from `loadConfig()`
 * @param {object} [opts.http]    shared HTTP handle; built from config when absent
 * @param {Array}  [opts.sources] source registry; defaults to all six
 * @param {number|Date} [opts.now]
 * @returns {Promise<{ leads: object[], file: object, stats: object }>}
 */
export async function runPipeline(opts = {}) {
  const {
    config = loadConfig(),
    now = Date.now(),
    sources = SOURCES,
    http = createPipelineHttp(config),
    logger = console,
  } = opts;

  const today = isoDay(now);
  logger.log?.(`vantage medtech signals — run ${today}`);

  // 1. Ingest.
  const { records, bySource, errors } = await ingestAll({ http, config, now, sources, logger });
  logger.log?.(`ingest: ${records.length} record(s) across ${Object.keys(bySource).length} source(s)`);

  // 2. Diff against stored state, per source.
  const store = createStateStore({ dir: config.stateDir });
  const emittedKeys = new Set();
  const changesBySource = {};

  for (const [sourceId, sourceRecords] of Object.entries(bySource)) {
    const previous = await store.read(sourceId);
    const { added, changed, emitted, next } = diffRecords(previous, sourceRecords, { now });
    for (const record of emitted) emittedKeys.add(`${record.source}:${record.sourceId}`);
    changesBySource[sourceId] = { added: added.length, changed: changed.length };
    logger.log?.(`  ${sourceId}: ${added.length} new, ${changed.length} changed`);
    if (!config.dryRun) await store.write(sourceId, next, now);
  }

  // 3. Resolve entities, merging into what previous runs learned. This is what
  //    lets a March publication, a May patent and a July incorporation meet.
  const storedEntities = await store.readEntities();
  const { entities, stats: resolveStats } = resolveEntities(storedEntities, records, { now });
  logger.log?.(
    `resolve: ${resolveStats.total} entities ` +
      `(${resolveStats.created} new, ${resolveStats.merged} merged, ${resolveStats.bridged} bridged, ${resolveStats.linked} links)`
  );
  if (!config.dryRun) await store.writeEntities(entities, now);

  // 4. Score.
  const { leads, stats: leadStats } = buildLeads({ entities, records, emittedKeys, now });
  logger.log?.(
    `score: ${leadStats.total} lead(s) — ${leadStats.high} haute, ${leadStats.medium} moyenne`
  );

  // 5. Publish.
  const file = buildLeadsFile(leads, {
    now,
    stats: { entities: resolveStats.total, records: records.length },
    sources: sources
      .filter((source) => (config.enabledSources ?? []).includes(source.id))
      .map((source) => ({
        id: source.id,
        label: source.label,
        records: (bySource[source.id] ?? []).length,
        ...(changesBySource[source.id] ?? { added: 0, changed: 0 }),
      })),
    errors,
  });

  if (config.dryRun) {
    logger.log?.(`DRY_RUN=1 — not writing ${config.leadsPath}.`);
  } else {
    await writeLeadsFile(config.leadsPath, file);
    logger.log?.(`wrote ${config.leadsPath}`);
  }

  return { leads, file, stats: { ...leadStats, ...resolveStats, errors } };
}

// CLI entrypoint.
if (import.meta.url === `file://${process.argv[1]}`) {
  runPipeline().catch((err) => {
    console.error('medtech signals pipeline failed:', err);
    process.exit(1);
  });
}
