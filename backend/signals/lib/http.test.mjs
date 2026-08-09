// node --test backend/signals/lib/http.test.mjs
//
// No network: `fetchImpl` is a stub, the clock and sleep are fakes. These tests
// pin the three behaviours connectors rely on — retrying the right errors, NOT
// retrying the wrong ones, and never serving one request's body to another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttp, HttpError } from './http.mjs';
import { createMemoryCache } from './cache.mjs';
import { createLimiterRegistry } from './ratelimit.mjs';

/** Minimal Response stand-in. */
function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

/** A fetch stub that replays a queue of responses and records the calls. */
function stubFetch(queue) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const next = queue.shift();
    if (typeof next === 'function') return next(url, options);
    if (next instanceof Error) throw next;
    return next;
  };
  impl.calls = calls;
  return impl;
}

/** An http handle with everything faked out. */
function makeHttp(fetchImpl, opts = {}) {
  const sleeps = [];
  const http = createHttp({
    fetchImpl,
    cache: opts.cache ?? createMemoryCache(),
    limiters: createLimiterRegistry({}, { defaultIntervalMs: 0 }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 0,
    backoffBaseMs: 100,
    ...opts,
  });
  return { http, sleeps };
}

test('json parses a successful body', async () => {
  const { http } = makeHttp(stubFetch([response(200, '{"ok":true}')]));
  assert.deepEqual(await http.json('https://x.example/a'), { ok: true });
});

test('retries 429 with exponential backoff and succeeds', async () => {
  const fetchImpl = stubFetch([
    response(429, 'slow down'),
    response(429, 'slow down'),
    response(200, '{"ok":1}'),
  ]);
  const { http, sleeps } = makeHttp(fetchImpl);

  assert.deepEqual(await http.json('https://x.example/a'), { ok: 1 });
  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(sleeps, [100, 200], 'exponential backoff');
});

test('honours Retry-After instead of its own backoff', async () => {
  const fetchImpl = stubFetch([response(429, '', { 'retry-after': '3' }), response(200, '{}')]);
  const { http, sleeps } = makeHttp(fetchImpl);
  await http.json('https://x.example/a');
  assert.deepEqual(sleeps, [3000]);
});

test('retries network errors too', async () => {
  const fetchImpl = stubFetch([new Error('ECONNRESET'), response(200, '{"ok":1}')]);
  const { http } = makeHttp(fetchImpl);
  assert.deepEqual(await http.json('https://x.example/a'), { ok: 1 });
});

test('does NOT retry a 404 — a missing resource is final', async () => {
  const fetchImpl = stubFetch([response(404, 'nope')]);
  const { http } = makeHttp(fetchImpl);
  await assert.rejects(http.json('https://x.example/a'), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 404);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('gives up after the retry budget and surfaces the last error', async () => {
  const fetchImpl = stubFetch([response(500, 'a'), response(500, 'b'), response(500, 'c')]);
  const { http } = makeHttp(fetchImpl);
  await assert.rejects(http.json('https://x.example/a', { retries: 2 }), (err) => {
    assert.equal(err.status, 500);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 3, '1 attempt + 2 retries');
});

test('invalid JSON raises HttpError rather than a raw SyntaxError', async () => {
  const { http } = makeHttp(stubFetch([response(200, '<html>maintenance</html>')]));
  await assert.rejects(http.json('https://x.example/a'), /invalid JSON/);
});

test('a cached GET is served without touching the network', async () => {
  const fetchImpl = stubFetch([response(200, '{"n":1}')]);
  const cache = createMemoryCache({ ttlMs: 60_000, now: () => 0 });
  const { http } = makeHttp(fetchImpl, { cache });

  assert.deepEqual(await http.json('https://x.example/a'), { n: 1 });
  assert.deepEqual(await http.json('https://x.example/a'), { n: 1 });
  assert.equal(fetchImpl.calls.length, 1, 'second call came from the cache');
});

test('cacheSalt keeps header-paginated requests apart', async () => {
  // Regression guard for EPO OPS: it pages by varying the `Range` HEADER against
  // one unchanging URL. Without the salt, page 2 would be served page 1's body.
  const fetchImpl = stubFetch([response(200, '{"page":1}'), response(200, '{"page":2}')]);
  const cache = createMemoryCache({ ttlMs: 60_000, now: () => 0 });
  const { http } = makeHttp(fetchImpl, { cache });

  const url = 'https://ops.example/search?q=x';
  const first = await http.json(url, { headers: { range: '1-100' }, cacheSalt: '1-100' });
  const second = await http.json(url, { headers: { range: '101-200' }, cacheSalt: '101-200' });

  assert.deepEqual(first, { page: 1 });
  assert.deepEqual(second, { page: 2 });
  assert.equal(fetchImpl.calls.length, 2);
});

test('POST is not cached by default, so a token exchange is never replayed', async () => {
  const fetchImpl = stubFetch([response(200, '{"t":1}'), response(200, '{"t":2}')]);
  const cache = createMemoryCache({ ttlMs: 60_000, now: () => 0 });
  const { http } = makeHttp(fetchImpl, { cache });

  await http.json('https://x.example/auth', { method: 'POST', body: 'grant_type=client_credentials' });
  await http.json('https://x.example/auth', { method: 'POST', body: 'grant_type=client_credentials' });
  assert.equal(fetchImpl.calls.length, 2);
});

test('sends a user-agent, because several of these APIs require one', async () => {
  const fetchImpl = stubFetch([response(200, '{}')]);
  const { http } = makeHttp(fetchImpl);
  await http.json('https://x.example/a');
  assert.match(fetchImpl.calls[0].options.headers['user-agent'], /vantage-signals/);
});
