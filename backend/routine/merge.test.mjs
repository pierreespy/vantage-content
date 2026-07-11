// node --test backend/routine/merge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStartupNews } from './merge.mjs';

const NOW = '2026-07-09'; // reference "today" for every case

/** Tiny factory for a NewsItem with a given url + publishedAt. */
function item(url, publishedAt, extra = {}) {
  return { title: `t-${url}`, source: 's', date: publishedAt, url, publishedAt, ...extra };
}

test('keeps only the 3 newest when more than 3 are in window', () => {
  const incoming = [
    item('a', '2026-07-01'),
    item('b', '2026-07-08'),
    item('c', '2026-07-05'),
    item('d', '2026-07-09'),
    item('e', '2026-07-03'),
  ];
  const out = mergeStartupNews([], incoming, { now: NOW });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((i) => i.url), ['d', 'b', 'c']); // newest first
});

test('drops items older than 30 days (sliding window), keeps exactly-30', () => {
  const incoming = [
    item('fresh', '2026-07-09'),
    item('edge30', '2026-06-09'), // exactly 30 days -> kept
    item('old31', '2026-06-08'), // 31 days -> dropped
    item('ancient', '2026-01-01'),
  ];
  const out = mergeStartupNews([], incoming, { now: NOW });
  assert.deepEqual(out.map((i) => i.url).sort(), ['edge30', 'fresh']);
});

test('dedupes by url across existing + incoming (incoming wins)', () => {
  const existing = [item('dup', '2026-07-01', { title: 'old title' })];
  const incoming = [item('dup', '2026-07-01', { title: 'new title' })];
  const out = mergeStartupNews(existing, incoming, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'new title');
});

test('empty inputs yield an empty array', () => {
  assert.deepEqual(mergeStartupNews([], [], { now: NOW }), []);
  assert.deepEqual(mergeStartupNews(undefined, undefined, { now: NOW }), []);
});

test('merges stored + new, still capping at 3 newest', () => {
  const existing = [item('s1', '2026-07-02'), item('s2', '2026-06-20')];
  const incoming = [item('n1', '2026-07-09'), item('n2', '2026-07-08')];
  const out = mergeStartupNews(existing, incoming, { now: NOW });
  assert.deepEqual(out.map((i) => i.url), ['n1', 'n2', 's1']); // s2 pushed out of top 3
});

test('items with missing/invalid publishedAt are dropped', () => {
  const incoming = [item('ok', '2026-07-09'), { url: 'bad', title: 'x', source: 's', date: '?' }];
  const out = mergeStartupNews([], incoming, { now: NOW });
  assert.deepEqual(out.map((i) => i.url), ['ok']);
});
