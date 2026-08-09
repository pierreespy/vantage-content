// node --test backend/signals/lib/state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore, diffRecords } from './state.mjs';

const NOW = '2026-08-09';

/** A record as the connectors produce it, reduced to what diffing reads. */
function record(source, sourceId, fingerprint, extra = {}) {
  return { source, sourceId, fingerprint, date: NOW, ...extra };
}

test('everything is new on a first run', () => {
  const { added, changed, emitted, next } = diffRecords(
    {},
    [record('clinicaltrials', 'NCT1', 'RECRUITING|2026-08-01')],
    { now: NOW }
  );
  assert.equal(added.length, 1);
  assert.equal(changed.length, 0);
  assert.equal(emitted.length, 1);
  assert.equal(added[0].seenChange, 'new');
  assert.deepEqual(next['clinicaltrials:NCT1'], {
    fp: 'RECRUITING|2026-08-01',
    firstSeen: NOW,
    lastSeen: NOW,
  });
});

test('an unchanged record emits nothing — this is what stops daily re-announcing', () => {
  const previous = {
    'clinicaltrials:NCT1': { fp: 'RECRUITING|2026-08-01', firstSeen: '2026-08-01', lastSeen: '2026-08-08' },
  };
  const { added, changed, emitted, next } = diffRecords(
    previous,
    [record('clinicaltrials', 'NCT1', 'RECRUITING|2026-08-01')],
    { now: NOW }
  );
  assert.deepEqual([added.length, changed.length, emitted.length], [0, 0, 0]);
  assert.equal(next['clinicaltrials:NCT1'].firstSeen, '2026-08-01', 'firstSeen is preserved');
  assert.equal(next['clinicaltrials:NCT1'].lastSeen, NOW, 'lastSeen is refreshed');
});

test('a moved fingerprint re-emits as changed and keeps the original firstSeen', () => {
  // The whole point of "Voie B": a trial changing status IS the signal.
  const previous = {
    'clinicaltrials:NCT1': { fp: 'NOT_YET_RECRUITING|2026-07-01', firstSeen: '2026-07-01', lastSeen: '2026-08-08' },
  };
  const { added, changed } = diffRecords(
    previous,
    [record('clinicaltrials', 'NCT1', 'RECRUITING|2026-08-09')],
    { now: NOW }
  );
  assert.equal(added.length, 0);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].seenChange, 'changed');
  assert.equal(changed[0].firstSeen, '2026-07-01');
  assert.equal(changed[0].previousFingerprint, 'NOT_YET_RECRUITING|2026-07-01');
});

test('ids unseen past the retention window are forgotten', () => {
  const previous = {
    'pubmed:1': { fp: 'a', firstSeen: '2024-01-01', lastSeen: '2024-01-01' },
    'pubmed:2': { fp: 'b', firstSeen: '2026-08-01', lastSeen: '2026-08-01' },
  };
  const { next } = diffRecords(previous, [], { now: NOW, retentionDays: 400 });
  assert.deepEqual(Object.keys(next), ['pubmed:2']);
});

test('records without a stable id are skipped rather than diffed on nothing', () => {
  const { added, next } = diffRecords({}, [{ source: 'pubmed', fingerprint: 'x' }], { now: NOW });
  assert.equal(added.length, 0);
  assert.deepEqual(next, {});
});

test('the same record from two sources is two distinct ids', () => {
  const { added } = diffRecords(
    {},
    [record('pubmed', '42', 'a'), record('europepmc', '42', 'a')],
    { now: NOW }
  );
  assert.equal(added.length, 2);
});

test('store round-trips per-source state and entities, key-sorted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vantage-state-'));
  try {
    const store = createStateStore({ dir });
    assert.deepEqual(await store.read('pubmed'), {}, 'missing file reads as empty state');
    assert.deepEqual(await store.readEntities(), {});

    await store.write('pubmed', { b: { fp: '2' }, a: { fp: '1' } }, Date.parse(NOW));
    assert.deepEqual(Object.keys(await store.read('pubmed')), ['a', 'b'], 'keys are sorted for readable diffs');

    await store.writeEntities({ 'person:z': { id: 'person:z' }, 'person:a': { id: 'person:a' } });
    assert.deepEqual(Object.keys(await store.readEntities()), ['person:a', 'person:z']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
