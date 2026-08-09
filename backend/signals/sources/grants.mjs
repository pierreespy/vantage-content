// Vantage — innovation-grant connector (i-Lab, i-PhD, EIC Accelerator).
//
// A grant win is a strong pre-company signal: i-Lab and i-PhD are explicitly
// awarded to researchers ABOUT to spin a lab out, and an EIC Accelerator grant
// lands months before the equity round it de-risks.
//
// IMPORTANT — why this connector is an ADAPTER and not a hard-coded endpoint:
// none of the three programmes publishes a free, documented, stable JSON API.
// Bpifrance publishes i-Lab / i-PhD laureates as web pages and PDFs; the EIC
// publishes beneficiaries through the EU portal and CORDIS as bulk CSV/JSON
// exports whose URLs are versioned per call. Hard-coding a URL here would mean
// shipping something that 404s within a season, and inventing one would be worse.
//
// So a "feed" is a DESCRIPTOR — where the rows are, and which column means what:
//
//   { id, program, country, url, format: 'json'|'csv', rowsPath, mapping: {…} }
//
// `url` accepts `https:` (a real export endpoint, once you have one) or `file:`
// (a curated list kept in the repo, which is the realistic path for i-Lab/i-PhD).
// Feeds are configured in `grants.feeds.json` and overridable per programme via
// env — see .env.example. Adding a programme is a config edit, not a code change.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRecord } from '../lib/record.mjs';
import { isoDaysAgo, toIsoDay } from '../lib/dates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the shipped feed descriptors live. */
export const FEEDS_FILE = resolve(HERE, 'grants.feeds.json');

/** Politeness pacing for whatever host a feed points at. */
export const MIN_INTERVAL_MS = 500;

/** Read a dotted path out of a row: `mapping.date = "call.deadlineDate"`. */
export function getPath(row, path) {
  if (!path) return undefined;
  return String(path)
    .split('.')
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), row);
}

/**
 * Minimal RFC4180 CSV parser — quoted fields, escaped `""`, embedded newlines,
 * CRLF. Deliberately dependency-free: the pipeline ships with zero packages, and
 * pulling `csv-parse` in for one export format is not worth the install.
 *
 * @returns {Array<Record<string, string>>} rows keyed by the header line
 */
export function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // Skip the blank line a trailing newline produces.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === delimiter) pushField();
    else if (char === '\r') continue; // CRLF -> handled by the \n below
    else if (char === '\n') pushRow();
    else field += char;
  }
  if (field !== '' || row.length) pushRow();

  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((values) =>
    Object.fromEntries(header.map((key, index) => [key, (values[index] ?? '').trim()]))
  );
}

/** Split a mapped cell that may hold several names ("A; B" / "A, B" / an array). */
function splitNames(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value
    .split(/[;|]|\s+et\s+|\s+and\s+/i)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * One feed's rows -> `SourceRecord[]`. Pure — the parser tests run on fixtures.
 *
 * @param {Array<object>} rows
 * @param {object} feed  the descriptor (see the header)
 */
export function mapRows(rows, feed) {
  const mapping = feed?.mapping ?? {};

  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => {
      const title = getPath(row, mapping.title);
      const company = getPath(row, mapping.company);
      const laureates = splitNames(getPath(row, mapping.people));
      const date = toIsoDay(getPath(row, mapping.date) ?? feed?.defaultDate);

      // The programme + its own row id; falls back to the index so a feed with no
      // id column still produces stable-enough keys within a run.
      const rawId = getPath(row, mapping.id) ?? company ?? title ?? String(index);
      const sourceId = `${feed.id}:${String(rawId).slice(0, 80)}`;

      return makeRecord({
        source: 'grants',
        sourceId,
        kind: 'grant',
        // A grant row is often just a company + a programme; build a real headline.
        title: title || (company ? `${company} — lauréat ${feed.program}` : ''),
        date,
        // `makeRecord` drops anything that is not an http(s) URL, so a feed with
        // no link column simply yields a record without one.
        url: getPath(row, mapping.url) ?? feed.programUrl ?? '',
        country: getPath(row, mapping.country) ?? feed.country ?? '',
        people: laureates.map((name) => ({ name, role: 'laureate' })),
        organizations: company ? [{ name: String(company), role: 'company' }] : [],
        keywords: splitNames(getPath(row, mapping.keywords)),
        fingerprint: `grant:${sourceId}`,
        extra: {
          program: feed.program,
          ...(getPath(row, mapping.amount) ? { amount: String(getPath(row, mapping.amount)) } : {}),
        },
      });
    })
    .filter(Boolean);
}

/** Load the shipped feed descriptors, applying any per-programme URL override. */
export async function loadFeeds(opts = {}) {
  const { file = FEEDS_FILE, overrides = {}, read = readFile } = opts;
  let feeds;
  try {
    feeds = JSON.parse(await read(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(feeds)) return [];
  return feeds
    .filter((feed) => feed?.id && feed?.url)
    .map((feed) => (overrides[feed.id] ? { ...feed, url: overrides[feed.id] } : feed));
}

/** Fetch one feed's raw rows, over HTTP or from a repo-local file. */
async function readRows(feed, { http, read }) {
  const isFile = feed.url.startsWith('file:');
  const body = isFile
    ? await read(resolve(HERE, feed.url.replace(/^file:/, '')), 'utf8')
    : await http.text(feed.url, { accept: feed.format === 'csv' ? 'text/csv,*/*' : 'application/json' });

  if (feed.format === 'csv') return parseCsv(body, feed.delimiter ?? ',');

  const payload = JSON.parse(body);
  const rows = feed.rowsPath ? getPath(payload, feed.rowsPath) : payload;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Fetch grant laureates across every configured feed.
 *
 * A feed that is unreachable or malformed is logged and skipped — one broken
 * programme export must not cost us the other two.
 *
 * @param {object} opts
 * @param {{ text: Function }} opts.http
 * @param {number} [opts.lookbackDays=180]  grants are announced in waves, so the
 *   window is much wider than the 30 days used for publications and trials
 * @returns {Promise<object[]>} `SourceRecord[]`
 */
export async function fetchGrants(opts) {
  const {
    http,
    feeds,
    lookbackDays = 180,
    now = Date.now(),
    read = readFile,
    logger = console,
  } = opts ?? {};

  const list = feeds ?? (await loadFeeds({ read }));
  const since = isoDaysAgo(lookbackDays, now);

  const records = [];
  for (const feed of list) {
    try {
      const rows = await readRows(feed, { http, read });
      // Grant feeds are cumulative dumps: window them here, not at the source.
      records.push(...mapRows(rows, feed).filter((record) => record.date >= since));
    } catch (err) {
      logger.warn?.(`grants: feed "${feed.id}" skipped (${err.message})`);
    }
  }
  return records;
}
