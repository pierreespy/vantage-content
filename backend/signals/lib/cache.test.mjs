// node --test backend/signals/lib/cache.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache, createMemoryCache } from './cache.mjs';

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'vantage-cache-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('disk cache round-trips a value and expires it', async () => {
  await withTempDir(async (dir) => {
    let time = 1000;
    const cache = createCache({ dir, ttlMs: 500, now: () => time });

    assert.deepEqual(await cache.get('k'), { hit: false });
    await cache.set('k', 'payload');
    assert.deepEqual(await cache.get('k'), { hit: true, value: 'payload' });

    time += 499;
    assert.equal((await cache.get('k')).hit, true, 'still inside the TTL');

    time += 2;
    assert.equal((await cache.get('k')).hit, false, 'past the TTL');
  });
});

test('an expired entry is deleted from disk, so the dir cannot grow forever', async () => {
  await withTempDir(async (dir) => {
    let time = 0;
    const cache = createCache({ dir, ttlMs: 10, now: () => time });
    await cache.set('k', 'v');
    assert.equal((await readdir(dir)).length, 1);

    time = 1000;
    await cache.get('k');
    assert.equal((await readdir(dir)).length, 0);
  });
});

test('a corrupt entry is a miss, never a crash', async () => {
  await withTempDir(async (dir) => {
    const cache = createCache({ dir, ttlMs: 10_000 });
    await cache.set('k', 'v');
    const [file] = await readdir(dir);
    await writeFile(join(dir, file), '{ not json', 'utf8');
    assert.deepEqual(await cache.get('k'), { hit: false });
  });
});

test('ttlMs of 0 disables the cache entirely — nothing is even written', async () => {
  await withTempDir(async (dir) => {
    const cache = createCache({ dir, ttlMs: 0 });
    assert.equal(cache.enabled, false);
    await cache.set('k', 'v');
    assert.deepEqual(await cache.get('k'), { hit: false });
    assert.deepEqual(await readdir(dir), [], 'no files written');
  });
});

test('distinct keys never collide', async () => {
  await withTempDir(async (dir) => {
    const cache = createCache({ dir, ttlMs: 10_000 });
    await cache.set('GET https://x/a', 'A');
    await cache.set('GET https://x/b', 'B');
    assert.equal((await cache.get('GET https://x/a')).value, 'A');
    assert.equal((await cache.get('GET https://x/b')).value, 'B');
  });
});

test('memory cache mirrors the disk cache semantics', async () => {
  let time = 0;
  const cache = createMemoryCache({ ttlMs: 100, now: () => time });
  await cache.set('k', { deep: true });
  assert.deepEqual((await cache.get('k')).value, { deep: true });
  time = 101;
  assert.equal((await cache.get('k')).hit, false);
});
