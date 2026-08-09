// Vantage — publication of the scored leads.
//
// The production read path for this pipeline is a STATIC JSON file, exactly like
// every other thing the app consumes (`edition.json`, `startup-news.json`,
// `words.json` — see src/config.ts in the `vantage` repo). It is written here,
// committed by the GitHub Action, and served by GitHub Pages. Zero infra, zero
// euro, and the same failure mode the app already knows how to handle.
//
// Committing is NOT done here: the workflow does it with the git CLI, which keeps
// this package dependency-free (backend/routine needs `simple-git` because it
// pushes to a DIFFERENT repo; this job runs inside the repo it writes to).

import { writeFile } from 'node:fs/promises';
import { frDateLabel, isoDay } from './lib/dates.mjs';

/**
 * The published file shape — a superset of what the HTTP endpoint returns, so a
 * client can either fetch the whole file or query the API and get the same leads.
 *
 * @param {object[]} leads
 * @param {object} [meta] `{ now, stats, sources, errors }`
 */
export function buildLeadsFile(leads = [], meta = {}) {
  const { now = Date.now(), stats = {}, sources = [], errors = [] } = meta;
  const generatedAt = isoDay(now);

  return {
    generatedAt,
    /** Human FR label, same convention as `Edition.dateLong`. */
    generatedAtLong: frDateLabel(generatedAt),
    counts: {
      total: leads.length,
      high: leads.filter((lead) => lead.priority === 'high').length,
      medium: leads.filter((lead) => lead.priority === 'medium').length,
      low: leads.filter((lead) => lead.priority === 'low').length,
      withNewSignal: leads.filter((lead) => (lead.newSignalCount ?? 0) > 0).length,
      ...stats,
    },
    /** Which connectors ran, and which ones failed — visible in the artefact
     *  itself, so a silently degraded run is obvious in the git diff. */
    sources,
    errors,
    leads,
  };
}

/** Write the leads file. Trailing newline + 2-space indent, as everywhere here. */
export async function writeLeadsFile(path, body) {
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return path;
}
