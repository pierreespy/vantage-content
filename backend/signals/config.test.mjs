// node --test backend/signals/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.mjs';
import { RECENT_COMPANY_DAYS } from './score.mjs';

test('defaults are sane with a completely empty environment', () => {
  const config = loadConfig({});
  assert.equal(config.lookbackDays, 30);
  assert.equal(config.maxPages, 5);
  assert.equal(config.port, 8787);
  assert.equal(config.dryRun, false);
  // `inpi` is the default registry, not `pappers`: Pappers is paid, and the
  // plan's architecture decision is "aucune source payante". Running both would
  // emit two company_creation records per SIREN.
  assert.deepEqual(config.enabledSources, [
    'pubmed',
    'europepmc',
    'epo',
    'clinicaltrials',
    'grants',
    'inpi',
  ]);
  // No credentials configured: those sources will skip themselves, not crash.
  assert.equal(config.epo.key, '');
  assert.equal(config.inpi.username, '');
  assert.equal(config.inpi.password, '');
});

test('the slow lookback covers the whole "société créée < 6 mois" window', () => {
  // Drift guard: if the registry window were shorter than the rule window,
  // companies aged just under six months would be invisible to the very rule
  // that is about them — and nothing else would fail.
  assert.ok(
    loadConfig({}).slowLookbackDays >= RECENT_COMPANY_DAYS,
    `slowLookbackDays must be >= RECENT_COMPANY_DAYS (${RECENT_COMPANY_DAYS})`
  );
});

test('numeric env vars are parsed, and garbage falls back to the default', () => {
  assert.equal(loadConfig({ SIGNALS_LOOKBACK_DAYS: '60' }).lookbackDays, 60);
  assert.equal(loadConfig({ SIGNALS_LOOKBACK_DAYS: 'soon' }).lookbackDays, 30);
  assert.equal(loadConfig({ SIGNALS_CACHE_TTL_MIN: '30' }).cacheTtlMs, 30 * 60_000);
});

test('an EMPTY numeric env var falls back — it must never be read as zero', () => {
  // Regression guard for the first live CI run, which went green having ingested
  // nothing: GitHub Actions injects an unset `${{ vars.X }}` as an empty string,
  // and `Number('')` is 0, so the lookback collapsed to a single day.
  assert.equal(loadConfig({ SIGNALS_LOOKBACK_DAYS: '' }).lookbackDays, 30);
  assert.equal(loadConfig({ SIGNALS_LOOKBACK_DAYS: '   ' }).lookbackDays, 30);
  assert.equal(loadConfig({ SIGNALS_MAX_PAGES: '' }).maxPages, 5);
  assert.equal(loadConfig({ SIGNALS_SLOW_LOOKBACK_DAYS: '' }).slowLookbackDays, 183);
  assert.equal(loadConfig({ SIGNALS_CACHE_TTL_MIN: '' }).cacheTtlMs, 720 * 60_000);
  assert.equal(loadConfig({ SIGNALS_PORT: '' }).port, 8787);

  // An explicit zero is still honoured — it is a real setting for the cache.
  assert.equal(loadConfig({ SIGNALS_CACHE_TTL_MIN: '0' }).cacheTtlMs, 0);
});

test('list env vars are split and trimmed', () => {
  assert.deepEqual(loadConfig({ SIGNALS_SOURCES: 'pubmed, pappers ' }).enabledSources, [
    'pubmed',
    'pappers',
  ]);
  assert.deepEqual(loadConfig({ EPO_IPC_CLASSES: 'A61B,G16H' }).epo.ipcClasses, ['A61B', 'G16H']);
  // An empty override must not become `['']` — that would query nothing.
  assert.equal(loadConfig({ EPO_IPC_CLASSES: '  ' }).epo.ipcClasses, undefined);
});

test('grant feed overrides are only set for the vars actually provided', () => {
  assert.deepEqual(loadConfig({}).grants.overrides, {});
  assert.deepEqual(loadConfig({ GRANTS_EIC_URL: 'https://x/eic.json' }).grants.overrides, {
    'eic-accelerator': 'https://x/eic.json',
  });
});

test('DRY_RUN=1 matches the favorites routine convention', () => {
  assert.equal(loadConfig({ DRY_RUN: '1' }).dryRun, true);
  assert.equal(loadConfig({ DRY_RUN: 'true' }).dryRun, false, 'only "1", like backend/routine');
});
