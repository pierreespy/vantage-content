// Vantage — the pipeline's memory: "what we already knew", stored in git.
//
// This is the core of "Voie B" in docs/signals-plan.md. A weak signal is not
// "this trial exists", it is "this trial CHANGED" or "this patent APPEARED".
// Telling those apart needs state, and the project's architecture decision is
// explicit: 0 € of infra, no database, no Firebase Functions — state lives as
// JSON in the repo, next to the content it produces.
//
// One file per source under `signal-state/`:
//
//   { "updatedAt": "2026-08-09",
//     "records": { "<sourceId>": { "fp": "<fingerprint>", "firstSeen": "…", "lastSeen": "…" } } }
//
// `fp` is a source-defined fingerprint of the fields whose change is itself the
// signal (a trial's status + last-update date, a patent's publication number…).
// We store the fingerprint, never the payload: the state file must stay small
// and diff-readable, since every run commits it.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isoDay, dayNumber } from './dates.mjs';

/** How long an unseen id is remembered before being forgotten. */
const DEFAULT_RETENTION_DAYS = 400;

/**
 * File-backed state store.
 *
 * @param {object} opts
 * @param {string} opts.dir  directory holding one JSON file per source
 */
export function createStateStore(opts) {
  const { dir } = opts ?? {};
  if (!dir) throw new Error('createStateStore: `dir` is required');

  const fileFor = (source) => join(dir, `${source}.json`);

  return {
    dir,

    /**
     * Read one source's state. A missing or corrupt file yields empty state —
     * the run then treats everything as new, which is noisy but never wrong.
     * @returns {Promise<Record<string, {fp: string, firstSeen: string, lastSeen: string}>>}
     */
    async read(source) {
      try {
        const parsed = JSON.parse(await readFile(fileFor(source), 'utf8'));
        return parsed?.records && typeof parsed.records === 'object' ? parsed.records : {};
      } catch {
        return {};
      }
    },

    /** Write one source's state, key-sorted so git diffs stay readable. */
    async write(source, records, now = Date.now()) {
      await mkdir(dir, { recursive: true });
      const sorted = {};
      for (const key of Object.keys(records).sort()) sorted[key] = records[key];
      const body = { updatedAt: isoDay(now), records: sorted };
      await writeFile(fileFor(source), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    },

    /**
     * Resolved entities live in the same directory but under their own key, since
     * they are not per-source: `entities.json` is the cross-source memory of who
     * is who (see resolve/resolve.mjs).
     */
    async readEntities() {
      try {
        const parsed = JSON.parse(await readFile(fileFor('entities'), 'utf8'));
        return parsed?.entities && typeof parsed.entities === 'object' ? parsed.entities : {};
      } catch {
        return {};
      }
    },

    async writeEntities(entities, now = Date.now()) {
      await mkdir(dir, { recursive: true });
      const sorted = {};
      for (const key of Object.keys(entities).sort()) sorted[key] = entities[key];
      const body = { updatedAt: isoDay(now), entities: sorted };
      await writeFile(fileFor('entities'), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    },
  };
}

/**
 * Compare freshly fetched records against stored state — the diffing step.
 *
 * A record is EMITTED when it is new (`added`) or when its fingerprint moved
 * (`changed`); a record we have already seen unchanged emits nothing, it only
 * refreshes `lastSeen`. That is what stops the pipeline from re-announcing the
 * same trial every single morning.
 *
 * Pure: no I/O, no clock beyond the injected `now`.
 *
 * @param {Record<string, object>} previous  stored state (from `store.read`)
 * @param {Array<object>} records            freshly fetched records
 * @param {object} [opts]
 * @param {string|number|Date} [opts.now]    reference "today"
 * @param {(r: object) => string} [opts.fingerprint]  defaults to the record's own `fingerprint`/`date`
 * @param {number} [opts.retentionDays=400]  forget ids unseen for this long
 * @returns {{ added: object[], changed: object[], emitted: object[], next: Record<string, object> }}
 *   `emitted` items carry a `firstSeen` field: the day WE first saw them, which
 *   is what "société créée il y a moins de 6 mois" is measured against when the
 *   source has no date of its own.
 */
export function diffRecords(previous = {}, records = [], opts = {}) {
  const {
    now = Date.now(),
    fingerprint = (r) => String(r?.fingerprint ?? r?.date ?? ''),
    retentionDays = DEFAULT_RETENTION_DAYS,
  } = opts;

  const today = isoDay(now);
  const todayDay = dayNumber(today);
  const next = {};
  const added = [];
  const changed = [];

  // Carry over everything we knew, minus what has aged out. Pruned ids can only
  // reappear as "new" if a source still returns them after `retentionDays` — far
  // beyond any connector's lookback window, so in practice they never do.
  for (const [id, entry] of Object.entries(previous)) {
    if (!entry || typeof entry !== 'object') continue;
    const lastSeenDay = dayNumber(entry.lastSeen);
    if (Number.isFinite(lastSeenDay) && todayDay - lastSeenDay > retentionDays) continue;
    next[id] = entry;
  }

  for (const record of records) {
    const id = record?.sourceId ? `${record.source ?? ''}:${record.sourceId}` : null;
    if (!id) continue; // a record with no stable id cannot be diffed — skip it

    const fp = fingerprint(record);
    const prev = previous[id];

    if (!prev) {
      next[id] = { fp, firstSeen: today, lastSeen: today };
      added.push({ ...record, firstSeen: today, seenChange: 'new' });
    } else if (prev.fp !== fp) {
      next[id] = { fp, firstSeen: prev.firstSeen ?? today, lastSeen: today };
      changed.push({ ...record, firstSeen: prev.firstSeen ?? today, seenChange: 'changed', previousFingerprint: prev.fp });
    } else {
      next[id] = { ...prev, lastSeen: today };
    }
  }

  return { added, changed, emitted: [...added, ...changed], next };
}
