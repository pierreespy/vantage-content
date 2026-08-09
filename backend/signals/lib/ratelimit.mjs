// Vantage — per-host request pacing for the MedTech signal connectors.
//
// Every public API we ingest publishes a rate limit, and they are the kind of
// limit you get banned for, not throttled on: NCBI E-utilities allows 3 req/s
// anonymously (10 with an API key), EPO OPS meters by the minute, Pappers bills
// per call. So connectors never call `fetch` directly — they go through a
// limiter that SERIALIZES calls to one host and spaces their start times by at
// least `minIntervalMs`.
//
// The clock and the sleep are injected, so tests drive the pacing with a fake
// clock instead of actually waiting (see ratelimit.test.mjs).

/** Real sleep. Replaced by a fake in tests. */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a scheduler that runs tasks one at a time, at most one per
 * `minIntervalMs`.
 *
 * @param {object} [opts]
 * @param {number}   [opts.minIntervalMs=0] minimum delay between two task STARTS
 * @param {() => number} [opts.now]         clock, epoch ms
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {<T>(task: () => Promise<T>) => Promise<T>} schedule a task
 */
export function createLimiter(opts = {}) {
  const { minIntervalMs = 0, now = () => Date.now(), sleep = realSleep } = opts;

  let chain = Promise.resolve();
  let nextAllowedAt = 0;

  return function schedule(task) {
    const run = chain.then(async () => {
      const wait = nextAllowedAt - now();
      if (wait > 0) await sleep(wait);
      // Reserve the NEXT slot before running: a slow task must not let the one
      // behind it fire immediately after, which would double the instantaneous rate.
      nextAllowedAt = now() + minIntervalMs;
      return task();
    });

    // Keep the chain alive on failure. If we chained on `run` directly, one
    // rejected task would leave every later call queued behind a rejected
    // promise and the limiter would stop scheduling entirely.
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

/**
 * A registry of per-host limiters. Two connectors hitting the same host share
 * one limiter (that is the whole point — the limit is per host, not per caller),
 * while different hosts run concurrently.
 *
 * @param {Record<string, number>} [intervalsByHost] host -> minIntervalMs
 * @param {object} [opts] forwarded to `createLimiter` (now / sleep / default interval)
 */
export function createLimiterRegistry(intervalsByHost = {}, opts = {}) {
  const { defaultIntervalMs = 0, ...clock } = opts;
  const limiters = new Map();

  return {
    /** Limiter for a URL's host, created on first use. */
    for(url) {
      const host = hostOf(url);
      let limiter = limiters.get(host);
      if (!limiter) {
        const minIntervalMs = intervalsByHost[host] ?? defaultIntervalMs;
        limiter = createLimiter({ ...clock, minIntervalMs });
        limiters.set(host, limiter);
      }
      return limiter;
    },
  };
}

/** Host of a URL, or the raw string when it is not parseable (kept as its own bucket). */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}
