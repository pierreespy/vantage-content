import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enDate, toEnglish } from './ccr-merge.mjs';

test('enDate formats ISO dates in English', () => {
  assert.equal(enDate('2026-07-08'), 'Jul 8, 2026');
  assert.equal(enDate('bad', '8 juil. 2026'), '8 juil. 2026');
});

test('toEnglish uses titleEn and drops it, falls back to FR title', () => {
  const out = toEnglish({
    generatedAt: '2026-07-09',
    news: {
      A: [
        { title: 'FR', titleEn: 'EN', source: 's', url: 'u1', publishedAt: '2026-07-08', date: '8 juil. 2026' },
        { title: 'FR only', source: 's', url: 'u2', publishedAt: '2026-07-01', date: '1 juil. 2026' },
      ],
    },
  });
  assert.deepEqual(out.news.A[0], { title: 'EN', source: 's', url: 'u1', publishedAt: '2026-07-08', date: 'Jul 8, 2026' });
  assert.equal(out.news.A[1].title, 'FR only');
});
