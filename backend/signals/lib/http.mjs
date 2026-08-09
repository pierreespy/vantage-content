// Vantage — the single HTTP door for every MedTech signal connector.
//
// Connectors never call `fetch` themselves. They receive an `http` handle built
// here, which layers the three things the brief requires on top of native fetch:
//
//   1. RATE LIMITING — one limiter per host (lib/ratelimit.mjs), so two
//      connectors hitting the same API cannot together exceed its published rate;
//   2. CACHING — TTL disk cache (lib/cache.mjs) keyed by method+url+body, so a
//      same-day re-run costs no quota;
//   3. RESILIENCE — bounded retries with exponential backoff on the errors that
//      are actually transient (network, 429, 5xx), honouring `Retry-After`.
//
// Everything is injectable (fetch, clock, sleep, cache, limiters) so the whole
// pipeline can be exercised in tests with a stub fetch and a fake clock, and so
// no test ever touches the network.

import { createLimiterRegistry } from './ratelimit.mjs';
import { createMemoryCache } from './cache.mjs';

/** Error carrying the HTTP status, so callers can tell 404 (skip) from 500 (retry). */
export class HttpError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Statuses worth retrying: throttling and server-side flakiness. Never 4xx logic errors. */
function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * `Retry-After` in ms, if the server sent a usable one (delta-seconds or HTTP date).
 * Returns `null` when absent/unparseable so the caller falls back to its backoff.
 */
function retryAfterMs(headers, now) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * Build the HTTP handle shared by all connectors.
 *
 * @param {object} [opts]
 * @param {object} [opts.cache]            cache instance (see lib/cache.mjs)
 * @param {object} [opts.limiters]         limiter registry (see lib/ratelimit.mjs)
 * @param {typeof fetch} [opts.fetchImpl]  fetch implementation (stubbed in tests)
 * @param {() => number} [opts.now]        clock, epoch ms
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {string} [opts.userAgent]        polite UA — several of these APIs ask for one
 * @param {number} [opts.maxRetries=3]
 * @param {number} [opts.backoffBaseMs=500]
 * @param {number} [opts.timeoutMs=20000]
 */
export function createHttp(opts = {}) {
  const {
    cache = createMemoryCache(),
    limiters = createLimiterRegistry(),
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    sleep = realSleep,
    userAgent = 'vantage-signals/1.0 (+https://github.com/pierreespy/vantage-content)',
    maxRetries = 3,
    backoffBaseMs = 500,
    timeoutMs = 20_000,
  } = opts;

  if (typeof fetchImpl !== 'function') {
    throw new Error('createHttp: no fetch implementation available');
  }

  /**
   * Cache key: the request identity. Two different bodies must not collide, and
   * neither must two requests that differ ONLY by a header — EPO OPS pages by
   * varying the `Range` header against one unchanging URL, so without `cacheSalt`
   * page 2 would be served page 1's cached body.
   */
  function cacheKey(url, { method, body, cacheSalt }) {
    return `${method} ${url} ${typeof body === 'string' ? body : ''} ${cacheSalt ?? ''}`;
  }

  /**
   * One request, with pacing + retries. Returns the raw response TEXT so the
   * caller decides how to parse (JSON here, but EPO also serves XML).
   */
  async function request(url, options = {}) {
    const {
      method = 'GET',
      headers = {},
      body,
      accept = 'application/json',
      retries = maxRetries,
      // Extra discriminator for requests that differ only by a header.
      cacheSalt = '',
      // Only GETs are cached by default: a POST is either a token exchange or a
      // search whose body we do not want to key a long-lived entry on by accident.
      useCache = method === 'GET',
    } = options;

    const key = cacheKey(url, { method, body, cacheSalt });
    if (useCache) {
      const cached = await cache.get(key);
      if (cached.hit) return { text: String(cached.value), fromCache: true };
    }

    const limiter = limiters.for(url);
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff, unless the server told us exactly how long to wait.
        const wait = lastError?.retryAfterMs ?? backoffBaseMs * 2 ** (attempt - 1);
        await sleep(wait);
      }

      try {
        // The limiter wraps the network call only — the backoff sleep above must
        // NOT hold the host's slot, or a retrying request would stall the queue.
        const response = await limiter(() =>
          fetchImpl(url, {
            method,
            body,
            headers: { accept, 'user-agent': userAgent, ...headers },
            signal: AbortSignal.timeout(timeoutMs),
          })
        );

        if (response.ok) {
          const text = await response.text();
          if (useCache) await cache.set(key, text);
          return { text, fromCache: false };
        }

        const errBody = await response.text().catch(() => '');
        const error = new HttpError(`HTTP ${response.status} on ${url}`, {
          status: response.status,
          url,
          body: errBody.slice(0, 500),
        });
        if (!isRetryableStatus(response.status)) throw error;
        error.retryAfterMs = retryAfterMs(response.headers, now());
        lastError = error;
      } catch (err) {
        // A non-retryable HttpError is final; anything else (DNS, reset, timeout)
        // is worth another go.
        if (err instanceof HttpError && !isRetryableStatus(err.status)) throw err;
        lastError = err;
      }
    }

    throw lastError ?? new HttpError(`request to ${url} failed`, { url });
  }

  return {
    /** GET/POST returning parsed JSON. Throws `HttpError` with status on failure. */
    async json(url, options = {}) {
      const { text } = await request(url, options);
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(`invalid JSON from ${url}`, { url, body: text.slice(0, 500) });
      }
    },

    /** GET returning raw text (XML endpoints, CSV grant exports). */
    async text(url, options = {}) {
      const { text } = await request(url, { accept: 'text/plain,*/*', ...options });
      return text;
    },
  };
}
