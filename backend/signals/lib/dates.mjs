// Vantage — date helpers for the MedTech signal pipeline.
//
// Every date that crosses a module boundary in this pipeline is an ISO
// `AAAA-MM-JJ` day string: it sorts lexically the same as chronologically, it
// survives a JSON round-trip, and it has no timezone to get wrong. Sources hand
// us a zoo of formats (E-utilities "2026/07/08", EPO "20260708", Pappers
// "2026-07-08", ClinicalTrials.gov "2026-07" or "July 8, 2026"), so parsing is
// centralised here.
//
// `frDateLabel` is deliberately a copy of the one in backend/routine/research.mjs
// rather than an import: that module pulls in the Anthropic SDK from a different
// package with its own node_modules, and this pipeline has zero dependencies.

const MS_PER_DAY = 86_400_000;

const MONTHS_EN = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** UTC day number for an ISO day string (or anything Date-parseable). NaN when unusable. */
export function dayNumber(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return NaN;
  return Math.floor(ms / MS_PER_DAY);
}

/** ISO `AAAA-MM-JJ` for a Date / epoch ms / ISO-ish string. */
export function isoDay(value = Date.now()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** ISO day `days` before `from` — the usual way we build a lookback window. */
export function isoDaysAgo(days, from = Date.now()) {
  const base = from instanceof Date ? from.getTime() : Number(from);
  return isoDay(base - days * MS_PER_DAY);
}

/** Whole days between two ISO days (`b - a`). NaN when either is unparseable. */
export function daysBetween(a, b) {
  const da = dayNumber(a);
  const db = dayNumber(b);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return NaN;
  return db - da;
}

/**
 * Coerce whatever a source returned into an ISO `AAAA-MM-JJ`, or `''`.
 *
 * Handles: ISO (`2026-07-08`, `2026-07-08T10:00:00Z`), slashes (`2026/07/08`),
 * compact EPO (`20260708`), partial (`2026-07`, `2026`) — padded to the 1st —
 * and English long form (`July 8, 2026`, `8 Jul 2026`). Anything else is `''`
 * so callers can drop the record instead of inventing a date.
 */
export function toIsoDay(value) {
  if (value instanceof Date) return isoDay(value);
  if (typeof value === 'number' && Number.isFinite(value)) return isoDay(value);
  if (typeof value !== 'string') return '';

  const raw = value.trim();
  if (!raw) return '';

  // 2026-07-08 / 2026-07-08T… / 2026/07/08
  const ymd = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (ymd) return pad(ymd[1], ymd[2], ymd[3]);

  // 20260708 (EPO / DOCDB style)
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return pad(compact[1], compact[2], compact[3]);

  // 2026-07 or 2026/07 -> first of the month; 2026 -> first of the year.
  const ym = raw.match(/^(\d{4})[-/](\d{1,2})$/);
  if (ym) return pad(ym[1], ym[2], '1');
  const y = raw.match(/^(\d{4})$/);
  if (y) return pad(y[1], '1', '1');

  // "2026 Jul 8" / "2026 Jul" — the E-utilities `pubdate` format.
  const yearMonthFirst = raw.match(/^(\d{4})\s+([A-Za-z]{3,})(?:\s+(\d{1,2}))?$/);
  if (yearMonthFirst) {
    const m = MONTHS_EN[yearMonthFirst[2].slice(0, 3).toLowerCase()];
    if (m) return pad(yearMonthFirst[1], String(m), yearMonthFirst[3] ?? '1');
  }

  // "July 8, 2026" / "Jul 2026" / "8 July 2026"
  const monthFirst = raw.match(/^([A-Za-z]{3,})\s+(\d{1,2})?,?\s*(\d{4})$/);
  if (monthFirst) {
    const m = MONTHS_EN[monthFirst[1].slice(0, 3).toLowerCase()];
    if (m) return pad(monthFirst[3], String(m), monthFirst[2] ?? '1');
  }
  const dayFirst = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (dayFirst) {
    const m = MONTHS_EN[dayFirst[2].slice(0, 3).toLowerCase()];
    if (m) return pad(dayFirst[3], String(m), dayFirst[1]);
  }

  return '';
}

/** Zero-pad y/m/d into an ISO day, rejecting impossible calendar values. */
function pad(y, m, d) {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!(mm >= 1 && mm <= 12) || !(dd >= 1 && dd <= 31)) return '';
  const iso = `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  // Reject e.g. 2026-02-31, which Date.parse would silently roll over.
  return isoDay(`${iso}T00:00:00Z`) === iso ? iso : '';
}

/** FR absolute display label from an ISO day, e.g. "2026-07-08" -> "8 juil. 2026". */
export function frDateLabel(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}
