// Vantage — deterministic retention merge for one startup's news list.
//
// This is the ONLY place the retention contract from docs/perso-favoris.md is
// enforced (the app has no retention logic — it renders whatever we publish):
//
//   - dedupe by `url` (never two items with the same url);
//   - sliding window: drop any item whose `publishedAt` is more than `windowDays`
//     calendar days before `now`;
//   - keep only the `maxPerStartup` most recent by `publishedAt` (desc).
//
// Pure and side-effect free: same inputs -> same output. No I/O, no clock reads
// beyond the injected `now`. That is what makes it unit-testable and what keeps
// the published file stable across runs.
//
// NewsItem = { title, source, date, url, publishedAt } where `publishedAt` is an
// ISO `AAAA-MM-JJ` date and `date` is the human FR display label.

/** UTC day number for an ISO `AAAA-MM-JJ` string (or any Date-parseable value). */
function dayNumber(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return NaN;
  return Math.floor(ms / 86_400_000);
}

/**
 * Merge stored + freshly-researched items for a single startup under the
 * retention contract.
 *
 * @param {Array<object>} existing  items already stored for this startup
 * @param {Array<object>} incoming  newly researched items for this startup
 * @param {object}   opts
 * @param {number|string|Date} opts.now   reference "today"
 * @param {number} [opts.windowDays=30]   sliding retention window, in days
 * @param {number} [opts.maxPerStartup=3] hard cap on items kept
 * @returns {Array<object>} the kept items, newest first
 */
export function mergeStartupNews(existing = [], incoming = [], opts = {}) {
  const { now = Date.now(), windowDays = 30, maxPerStartup = 3 } = opts;

  const nowDay = dayNumber(now instanceof Date ? now : new Date(now));
  const cutoffDay = nowDay - windowDays; // items strictly older than this are dropped

  // Dedupe by url. Iterate existing THEN incoming so a fresher research pass for
  // the same url overwrites the stored copy (updated title / corrected date).
  const byUrl = new Map();
  for (const item of [...(existing ?? []), ...(incoming ?? [])]) {
    if (!item || typeof item.url !== 'string' || !item.url) continue;
    byUrl.set(item.url, item);
  }

  const kept = [...byUrl.values()].filter((item) => {
    const d = dayNumber(item.publishedAt);
    // Drop items with no / unparseable date, and items older than the window.
    // `>= cutoffDay` keeps an item that is exactly `windowDays` old, and drops
    // one that is `windowDays + 1` old.
    return Number.isFinite(d) && d >= cutoffDay;
  });

  // Sort by publishedAt descending. ISO `AAAA-MM-JJ` strings sort lexically the
  // same as chronologically; url is a stable tie-breaker for determinism.
  kept.sort((a, b) => {
    if (a.publishedAt < b.publishedAt) return 1;
    if (a.publishedAt > b.publishedAt) return -1;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });

  return kept.slice(0, maxPerStartup);
}
