// node --test backend/signals/lib/dates.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayNumber, daysBetween, frDateLabel, isoDay, isoDaysAgo, toIsoDay } from './dates.mjs';

test('toIsoDay accepts every format our six sources actually emit', () => {
  const cases = [
    ['2026-07-08', '2026-07-08'], // ClinicalTrials.gov / Pappers
    ['2026-07-08T10:32:00Z', '2026-07-08'], // ISO timestamp
    ['2026/07/08', '2026-07-08'], // E-utilities
    ['20260708', '2026-07-08'], // EPO DOCDB compact
    ['2026 Jul 8', '2026-07-08'], // E-utilities pubdate
    ['July 8, 2026', '2026-07-08'],
    ['8 Jul 2026', '2026-07-08'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(toIsoDay(input), expected, `toIsoDay(${JSON.stringify(input)})`);
  }
});

test('toIsoDay pads partial dates to the first of the period', () => {
  assert.equal(toIsoDay('2026-07'), '2026-07-01');
  assert.equal(toIsoDay('2026'), '2026-01-01');
  assert.equal(toIsoDay('2026 Jul'), '2026-07-01');
});

test('toIsoDay returns empty for anything it cannot trust', () => {
  // A record with no usable date is dropped rather than dated by guesswork.
  for (const bad of ['', '   ', 'n/a', 'sometime in 2026', null, undefined, {}, '2026-02-31']) {
    assert.equal(toIsoDay(bad), '', `toIsoDay(${JSON.stringify(bad)})`);
  }
});

test('toIsoDay rejects impossible calendar dates instead of rolling them over', () => {
  // Date.parse would silently turn 2026-02-31 into 2026-03-03.
  assert.equal(toIsoDay('2026-13-01'), '');
  assert.equal(toIsoDay('20260231'), '');
});

test('isoDaysAgo / daysBetween form the lookback windows', () => {
  const now = Date.parse('2026-08-09T12:00:00Z');
  assert.equal(isoDay(now), '2026-08-09');
  assert.equal(isoDaysAgo(30, now), '2026-07-10');
  assert.equal(isoDaysAgo(183, now), '2026-02-07'); // the "< 6 mois" horizon
  assert.equal(daysBetween('2026-07-10', '2026-08-09'), 30);
  assert.equal(daysBetween('2026-08-09', '2026-07-10'), -30);
});

test('dayNumber and daysBetween are NaN on unusable input, never 0', () => {
  // 0 would read as "same day" and silently make a stale signal look fresh.
  assert.ok(Number.isNaN(dayNumber('pas une date')));
  assert.ok(Number.isNaN(daysBetween('', '2026-08-09')));
});

test('frDateLabel matches the app date convention', () => {
  assert.equal(frDateLabel('2026-07-08'), '8 juil. 2026');
  assert.equal(frDateLabel('nope'), 'nope'); // passes through rather than throwing
});
