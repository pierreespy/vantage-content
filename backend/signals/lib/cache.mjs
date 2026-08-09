// Vantage — TTL response cache for the MedTech signal connectors.
//
// The pipeline runs on a cron and re-queries the same public APIs every day with
// largely overlapping windows. Caching is not an optimization here, it is what
// keeps us inside free quotas (and what makes a local re-run cheap while
// developing a connector). Entries are plain JSON files under a cache dir keyed
// by a hash of the request, so a stale or corrupt entry is always a MISS and
// never a crash.
//
// The cache dir is disposable: it is gitignored and can be deleted at any time.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Stable file name for a cache key. */
function fileNameFor(key) {
  return `${createHash('sha256').update(key).digest('hex')}.json`;
}

/**
 * Disk-backed cache with a per-entry TTL.
 *
 * @param {object} opts
 * @param {string} opts.dir            directory holding the entries
 * @param {number} [opts.ttlMs=0]      entry lifetime; `0` disables the cache entirely
 * @param {() => number} [opts.now]    clock, epoch ms
 */
export function createCache(opts) {
  const { dir, ttlMs = 0, now = () => Date.now() } = opts ?? {};
  const enabled = ttlMs > 0 && !!dir;
  let ensured = false;

  async function ensureDir() {
    if (ensured) return;
    await mkdir(dir, { recursive: true });
    ensured = true;
  }

  return {
    enabled,

    /**
     * @param {string} key
     * @returns {Promise<{ hit: boolean, value?: unknown }>} `hit: false` on miss,
     *   expiry, unreadable file or malformed JSON — callers just refetch.
     */
    async get(key) {
      if (!enabled) return { hit: false };
      const path = join(dir, fileNameFor(key));
      let entry;
      try {
        entry = JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return { hit: false }; // missing or corrupt — treat as a miss
      }
      if (!entry || typeof entry.storedAt !== 'number') return { hit: false };
      if (now() - entry.storedAt > ttlMs) {
        // Expired: drop it so the dir does not grow without bound. Best-effort.
        await rm(path, { force: true }).catch(() => {});
        return { hit: false };
      }
      return { hit: true, value: entry.value };
    },

    /** Store a value. Write failures are swallowed: a cache is never load-bearing. */
    async set(key, value) {
      if (!enabled) return;
      try {
        await ensureDir();
        const path = join(dir, fileNameFor(key));
        await writeFile(path, JSON.stringify({ storedAt: now(), key, value }), 'utf8');
      } catch {
        /* ignore — running without a usable cache is degraded, not broken */
      }
    },
  };
}

/** In-memory cache with the same shape. Used by tests and by `DRY_RUN` local runs. */
export function createMemoryCache(opts = {}) {
  const { ttlMs = 0, now = () => Date.now() } = opts;
  const enabled = ttlMs > 0;
  const store = new Map();
  return {
    enabled,
    async get(key) {
      if (!enabled) return { hit: false };
      const entry = store.get(key);
      if (!entry) return { hit: false };
      if (now() - entry.storedAt > ttlMs) {
        store.delete(key);
        return { hit: false };
      }
      return { hit: true, value: entry.value };
    },
    async set(key, value) {
      if (!enabled) return;
      store.set(key, { storedAt: now(), value });
    },
  };
}
