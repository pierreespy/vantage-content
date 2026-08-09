// Vantage — the single place this pipeline reads `process.env`.
//
// Every other module takes its settings as arguments, so nothing below the
// entrypoints depends on the environment and every unit test can construct the
// exact config it wants. Keys and defaults are mirrored in `.env.example`.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root, i.e. two levels above `backend/signals`. */
const REPO_ROOT = resolve(HERE, '../..');

/**
 * Parse a numeric env var, falling back when it is absent or unusable.
 *
 * The empty-string guard is load-bearing, not defensive noise. GitHub Actions
 * injects an UNSET `${{ vars.X }}` as an EMPTY STRING, and `Number('')` is `0`,
 * not `NaN` — so without it, an unset `SIGNALS_LOOKBACK_DAYS` silently became a
 * lookback of ZERO days. Every source then queried a single day, found nothing,
 * threw no error, and the whole run went green having ingested nothing at all.
 * Pinned by config.test.mjs.
 */
function num(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Read the pipeline configuration.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 */
export function loadConfig(env = process.env) {
  return {
    /** State + cache locations. `signal-state/` is committed; `.cache/` is not. */
    stateDir: env.SIGNALS_STATE_DIR || resolve(REPO_ROOT, 'signal-state'),
    cacheDir: env.SIGNALS_CACHE_DIR || resolve(REPO_ROOT, '.cache/signals'),
    cacheTtlMs: num(env.SIGNALS_CACHE_TTL_MIN, 720) * 60_000, // 12 h by default

    /** Where the scored leads are written for publication. */
    leadsPath: env.SIGNALS_LEADS_PATH || resolve(REPO_ROOT, 'medtech-leads.json'),

    /** How far back each family of sources looks. */
    lookbackDays: num(env.SIGNALS_LOOKBACK_DAYS, 30),
    /** Grants and incorporations are announced in waves and must cover the
     *  6-month horizon the high-priority rule asks about. Keep this >=
     *  `RECENT_COMPANY_DAYS` (score.mjs) — config.test.mjs enforces it. */
    slowLookbackDays: num(env.SIGNALS_SLOW_LOOKBACK_DAYS, 183),

    /** Hard cap on pages per source, so a broad query can never run away. */
    maxPages: num(env.SIGNALS_MAX_PAGES, 5),

    /** Sources to run; defaults to all of them. */
    enabledSources: list(env.SIGNALS_SOURCES, [
      'pubmed',
      'europepmc',
      'epo',
      'clinicaltrials',
      'grants',
      'pappers',
    ]),

    /** Per-source credentials and query overrides. */
    pubmed: {
      apiKey: env.NCBI_API_KEY || '',
      tool: env.NCBI_TOOL || 'vantage-signals',
      email: env.NCBI_EMAIL || '',
      query: env.PUBMED_QUERY || undefined,
    },
    europepmc: {
      query: env.EUROPEPMC_QUERY || undefined,
    },
    epo: {
      key: env.EPO_OPS_KEY || '',
      secret: env.EPO_OPS_SECRET || '',
      ipcClasses: list(env.EPO_IPC_CLASSES, undefined),
    },
    clinicaltrials: {
      query: env.CLINICALTRIALS_QUERY || undefined,
    },
    grants: {
      /** Per-feed URL overrides, e.g. point `eic-accelerator` at a real export. */
      overrides: {
        ...(env.GRANTS_ILAB_URL ? { 'i-lab': env.GRANTS_ILAB_URL } : {}),
        ...(env.GRANTS_IPHD_URL ? { 'i-phd': env.GRANTS_IPHD_URL } : {}),
        ...(env.GRANTS_EIC_URL ? { 'eic-accelerator': env.GRANTS_EIC_URL } : {}),
      },
    },
    pappers: {
      apiToken: env.PAPPERS_API_KEY || '',
      nafCodes: list(env.PAPPERS_NAF_CODES, undefined),
    },

    /** API server. */
    port: num(env.SIGNALS_PORT, 8787),

    /** `1` to run everything but the git push (local testing) — same flag as the
     *  favorites routine, so both jobs behave identically in a dry run. */
    dryRun: env.DRY_RUN === '1',
  };
}
