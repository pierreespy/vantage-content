// node --test backend/signals/lib/ratelimit.test.mjs
//
// The limiter is driven by a FAKE clock: a real one would make these tests take
// seconds and turn pacing assertions into flaky timing races.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, createLimiterRegistry } from './ratelimit.mjs';

/** Fake clock + sleep: sleeping just moves the clock forward, instantly. */
function fakeClock(start = 0) {
  let time = start;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    advance: (ms) => {
      time += ms;
    },
    get time() {
      return time;
    },
  };
}

test('spaces task starts by at least minIntervalMs', async () => {
  const clock = fakeClock();
  const schedule = createLimiter({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });

  const starts = [];
  await Promise.all([1, 2, 3].map((n) => schedule(async () => starts.push([n, clock.now()]))));

  assert.deepEqual(
    starts.map(([, at]) => at),
    [0, 100, 200]
  );
});

test('serializes: a slow task does not let the next one fire early', async () => {
  const clock = fakeClock();
  const schedule = createLimiter({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });

  const starts = [];
  await Promise.all([
    schedule(async () => {
      starts.push(clock.now());
      clock.advance(500); // a slow request
    }),
    schedule(async () => {
      starts.push(clock.now());
    }),
  ]);

  // The second start is gated on the FIRST one's reserved slot, not on its end,
  // but it can never precede it — the instantaneous rate stays under the limit.
  assert.deepEqual(starts, [0, 500]);
});

test('a rejected task does not wedge the queue', async () => {
  // Regression guard: chaining on the rejected promise itself would leave every
  // later call queued behind it and the limiter would stop scheduling entirely.
  const clock = fakeClock();
  const schedule = createLimiter({ minIntervalMs: 10, now: clock.now, sleep: clock.sleep });

  await assert.rejects(
    schedule(async () => {
      throw new Error('boom');
    }),
    /boom/
  );
  assert.equal(await schedule(async () => 'ok'), 'ok');
});

test('registry gives one limiter per host and paces them independently', async () => {
  const clock = fakeClock();
  const registry = createLimiterRegistry(
    { 'a.example': 100, 'b.example': 0 },
    { now: clock.now, sleep: clock.sleep, defaultIntervalMs: 50 }
  );

  const a1 = registry.for('https://a.example/one');
  const a2 = registry.for('https://a.example/two');
  assert.equal(a1, a2, 'same host shares a limiter — the limit is per host, not per caller');
  assert.notEqual(a1, registry.for('https://b.example/one'));

  // Unknown host falls back to the default interval.
  const starts = [];
  const other = registry.for('https://c.example/x');
  await Promise.all([other(async () => starts.push(clock.now())), other(async () => starts.push(clock.now()))]);
  assert.deepEqual(starts, [0, 50]);
});

test('an unparseable url still gets its own bucket instead of throwing', () => {
  const registry = createLimiterRegistry();
  assert.equal(typeof registry.for('not a url'), 'function');
});
