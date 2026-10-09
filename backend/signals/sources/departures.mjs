// Vantage — departures from MedTech incumbents (« le cadre qui part et ne dit rien »).
//
// The weak signal: someone leaves a large MedTech group and, for months, takes no
// new public mandate. People rarely leave a director seat at Medtronic for
// nothing; a silent gap is often a company being built in stealth. When that
// person later reappears as the director of a just-incorporated company, the
// lead jumps to high priority (see `departure_newco` in score.mjs).
//
// LinkedIn is where most departures show, and it stays OUT (terms of service —
// docs/signals-plan.md). So this connector only sees what public REGISTERS show:
// directors / legal officers (mandataires sociaux). It catches executives, not
// the engineers who also spin out. That limit is deliberate, not an oversight.
//
// Two registers, two techniques:
//
//   · UK — Companies House exposes `resigned_on` on each officer, AND the
//     officer's other appointments. So a departure is dated exactly, and "has
//     taken no new mandate since" is checked directly, across every UK company
//     (not just MedTech SIC codes). Needs COMPANIES_HOUSE_API_KEY.
//
//   · FR — the open « Recherche d'entreprises » API (api.gouv.fr, no key) lists
//     a company's CURRENT officers only. A departure is therefore detected by
//     SNAPSHOT DIFF: an officer present in the stored roster and gone today. It
//     is dated on the day it was detected (± one run), and the first run only
//     seeds the roster. "No new mandate" is left to entity resolution: if the
//     person reappears as director of a new company in the INPI / Companies
//     House creation feeds, the resolver joins them.
//
// The incumbent lists are `sources/data/incumbents.json`; every registration
// number there was checked against the register, not guessed.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRecord } from '../lib/record.mjs';
import { daysBetween, isoDay, toIsoDay } from '../lib/dates.mjs';
import { authHeader, HOST as CH_HOST } from './companieshouse.mjs';

export { CH_HOST };
export const FR_HOST = 'recherche-entreprises.api.gouv.fr';
/** The open API allows 7 req/s; one every 400 ms leaves plenty of room. */
export const FR_MIN_INTERVAL_MS = 400;

/** A departure older than this is no longer a stealth signal — just history. */
export const DEPARTURE_WINDOW_DAYS = 365;

const CH_BASE = `https://${CH_HOST}`;
const FR_BASE = `https://${FR_HOST}`;
const DIRECTOR_ROLES = new Set(['director', 'llp-member', 'llp-designated-member', 'member']);
/** FR officer roles that are not "a person who runs the company". */
const FR_NON_EXEC_ROLE = /commissaire aux comptes|repr[ée]sentant permanent|liquidateur/i;

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

export async function loadIncumbents(path = new URL('./data/incumbents.json', import.meta.url)) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  return { gb: asArray(parsed.gb), fr: asArray(parsed.fr) };
}

/** Build one departure `SourceRecord`. */
export function toDepartureRecord(d) {
  const newCompanies = asArray(d.newCompanies);
  return makeRecord({
    source: d.source,
    sourceId: `${d.incumbentId}:${d.personKey}`,
    kind: 'departure',
    title: `${d.name} quitte ${d.incumbentName}${d.role ? ` (${d.role})` : ''}`,
    date: d.date,
    url: d.url,
    country: d.country,
    // The person only. The incumbent is NOT an organization mention: it would
    // become a company entity, and an 8 B€ group is not a sourcing lead.
    people: [{ name: d.name, role: 'departed', affiliation: `ex-${d.role || 'dirigeant'} — ${d.incumbentName}` }],
    organizations: [],
    // What "changed" means: the person taking a new mandate is itself news.
    fingerprint: `${d.date}|${newCompanies.map((c) => c.number).sort().join(',')}`,
    extra: {
      incumbent: d.incumbentName,
      role: d.role || '',
      // `null` = unknown (FR: the open API cannot list a person's other mandates).
      otherActiveMandates: d.otherActiveMandates ?? null,
      newCompanies,
      dateIsDetection: Boolean(d.dateIsDetection),
    },
  });
}

// ---------------------------------------------------------------- UK ----------

export function buildCompanyOfficersUrl(companyNumber) {
  return `${CH_BASE}/company/${encodeURIComponent(companyNumber)}/officers?items_per_page=100`;
}

/** Directors who resigned inside the window, with their appointments link. Pure. */
export function parseResignations(payload, { since, until }) {
  const out = [];
  for (const officer of asArray(payload?.items)) {
    if (!DIRECTOR_ROLES.has(String(officer?.officer_role ?? ''))) continue;
    const resignedOn = toIsoDay(officer?.resigned_on);
    if (!resignedOn || resignedOn < since || resignedOn > until) continue;
    const name = String(officer?.name ?? '').trim();
    if (!name) continue;
    out.push({
      name,
      resignedOn,
      role: String(officer?.occupation || officer?.officer_role || 'director'),
      appointmentsPath: officer?.links?.officer?.appointments ?? '',
    });
  }
  return out;
}

/**
 * Mandates a departed director holds elsewhere, from `/officers/{id}/appointments`.
 * Only ACTIVE appointments starting on/after (departure − 90 days) count: a
 * mandate set up just before leaving is the classic way to prepare a company.
 * Pure.
 */
export function parseNewAppointments(payload, { incumbentNumber, resignedOn }) {
  const cutoff = shiftDays(resignedOn, -90);
  const active = [];
  for (const item of asArray(payload?.items)) {
    const number = String(item?.appointed_to?.company_number ?? '');
    if (!number || number === incumbentNumber) continue;
    if (item?.resigned_on) continue;
    const status = String(item?.appointed_to?.company_status ?? 'active');
    if (status !== 'active') continue;
    active.push({
      number,
      name: String(item?.appointed_to?.company_name ?? ''),
      appointedOn: toIsoDay(item?.appointed_on) || '',
    });
  }
  const fresh = active.filter((a) => a.appointedOn && a.appointedOn >= cutoff);
  return { activeCount: active.length, fresh };
}

/**
 * UK departures from the incumbent list.
 *
 * Calls: 1 per incumbent + 1 per departure (appointments) + 1 per new company
 * (its incorporation date), bounded by `maxLookups`.
 */
export async function fetchUkDepartures(opts) {
  const {
    http,
    apiKey,
    incumbents = [],
    now = Date.now(),
    windowDays = DEPARTURE_WINDOW_DAYS,
    maxLookups = 80,
    logger = console,
  } = opts ?? {};
  if (!apiKey) {
    logger.warn?.('departures: COMPANIES_HOUSE_API_KEY not set — skipping UK departures.');
    return [];
  }
  const headers = { authorization: authHeader(apiKey) };
  const until = isoDay(now);
  const since = shiftDays(until, -windowDays);
  let lookups = 0;

  const records = [];
  for (const incumbent of incumbents) {
    let resignations = [];
    try {
      resignations = parseResignations(
        await http.json(buildCompanyOfficersUrl(incumbent.number), { headers }),
        { since, until }
      );
    } catch (err) {
      logger.warn?.(`departures: officers unavailable for ${incumbent.name} (${err.message})`);
      continue;
    }

    for (const r of resignations) {
      let otherActiveMandates = null;
      let newCompanies = [];
      if (r.appointmentsPath && lookups < maxLookups) {
        lookups += 1;
        try {
          const { activeCount, fresh } = parseNewAppointments(
            await http.json(`${CH_BASE}${r.appointmentsPath}`, { headers }),
            { incumbentNumber: incumbent.number, resignedOn: r.resignedOn }
          );
          otherActiveMandates = activeCount;
          for (const company of fresh) {
            let incorporatedAt = '';
            if (lookups < maxLookups) {
              lookups += 1;
              try {
                const profile = await http.json(`${CH_BASE}/company/${encodeURIComponent(company.number)}`, { headers });
                incorporatedAt = toIsoDay(profile?.date_of_creation) || '';
              } catch {
                /* the appointment alone is still evidence */
              }
            }
            newCompanies.push({ ...company, incorporatedAt });
          }
        } catch (err) {
          logger.warn?.(`departures: appointments unavailable for ${r.name} (${err.message})`);
        }
      }

      const record = toDepartureRecord({
        source: 'departures',
        incumbentId: `gb-${incumbent.number}`,
        incumbentName: incumbent.label || incumbent.name,
        personKey: slug(r.name),
        name: r.name,
        role: r.role,
        date: r.resignedOn,
        url: `https://find-and-update.company-information.service.gov.uk/company/${incumbent.number}/officers`,
        country: 'GB',
        otherActiveMandates,
        newCompanies,
      });
      if (record) records.push(record);
    }
  }
  return records;
}

// ---------------------------------------------------------------- FR ----------

export function buildFrSearchUrl(siren) {
  const url = new URL(`${FR_BASE}/search`);
  url.searchParams.set('q', siren);
  url.searchParams.set('per_page', '1');
  return url.toString();
}

/** Current natural-person officers of one SIREN, from a /search payload. Pure. */
export function parseFrOfficers(payload, siren) {
  const company = asArray(payload?.results).find((r) => String(r?.siren) === String(siren));
  if (!company) return null; // not found ≠ "nobody left": never diff on a miss
  const people = [];
  for (const d of asArray(company.dirigeants)) {
    if (d?.type_dirigeant !== 'personne physique') continue;
    const role = String(d?.qualite ?? '');
    if (FR_NON_EXEC_ROLE.test(role)) continue;
    const name = [d?.prenoms, d?.nom].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (name) people.push({ key: slug(name), name: titleCase(name), role });
  }
  return people;
}

/**
 * Diff a roster: who was there last time and is gone now. Pure.
 *
 * @param {{ officers?: object[], departures?: object[] }} previous  stored roster
 * @param {object[]} current  `parseFrOfficers` output
 * @returns {{ officers: object[], departures: object[] }} the next roster
 */
export function diffRoster(previous, current, today, windowDays = DEPARTURE_WINDOW_DAYS) {
  const before = asArray(previous?.officers);
  const nowKeys = new Set(current.map((p) => p.key));
  const kept = asArray(previous?.departures).filter(
    // Someone back on the roster did not leave after all.
    (d) => !nowKeys.has(d.key) && daysBetween(d.date, today) <= windowDays
  );
  const keptKeys = new Set(kept.map((d) => d.key));
  for (const officer of before) {
    if (nowKeys.has(officer.key) || keptKeys.has(officer.key)) continue;
    kept.push({ ...officer, date: today });
  }
  return { officers: current, departures: kept };
}

/**
 * FR departures by snapshot diff. Reads and (unless `dryRun`) writes the roster
 * file `signal-state/rosters-fr.json`. The first run for a SIREN only seeds it.
 */
export async function fetchFrDepartures(opts) {
  const {
    http,
    incumbents = [],
    now = Date.now(),
    stateDir,
    dryRun = false,
    windowDays = DEPARTURE_WINDOW_DAYS,
    logger = console,
  } = opts ?? {};
  const today = isoDay(now);
  const path = stateDir ? join(stateDir, 'rosters-fr.json') : '';
  let rosters = {};
  if (path) {
    try {
      rosters = JSON.parse(await readFile(path, 'utf8'))?.rosters ?? {};
    } catch {
      rosters = {};
    }
  }

  const records = [];
  for (const incumbent of incumbents) {
    let current;
    try {
      current = parseFrOfficers(await http.json(buildFrSearchUrl(incumbent.siren)), incumbent.siren);
    } catch (err) {
      logger.warn?.(`departures: officers unavailable for ${incumbent.name} (${err.message})`);
    }
    const previous = rosters[incumbent.siren];
    if (current) {
      // First sighting: seed, emit nothing — everyone would look "new".
      rosters[incumbent.siren] = previous ? diffRoster(previous, current, today, windowDays) : { officers: current, departures: [] };
    }
    for (const d of asArray(rosters[incumbent.siren]?.departures)) {
      const record = toDepartureRecord({
        source: 'departures',
        incumbentId: `fr-${incumbent.siren}`,
        incumbentName: incumbent.label || incumbent.name,
        personKey: d.key,
        name: d.name,
        role: d.role,
        date: d.date,
        url: `https://annuaire-entreprises.data.gouv.fr/dirigeants/${incumbent.siren}`,
        country: 'FR',
        dateIsDetection: true,
      });
      if (record) records.push(record);
    }
  }

  if (path && !dryRun) {
    await mkdir(stateDir, { recursive: true });
    const sorted = {};
    for (const key of Object.keys(rosters).sort()) sorted[key] = rosters[key];
    await writeFile(path, `${JSON.stringify({ updatedAt: today, rosters: sorted }, null, 2)}\n`, 'utf8');
  }
  return records;
}

/** Both registers. A missing UK key only skips the UK half. */
export async function fetchDepartures(opts) {
  const { incumbents = await loadIncumbents(), ...rest } = opts ?? {};
  const [gb, fr] = await Promise.all([
    fetchUkDepartures({ ...rest, incumbents: incumbents.gb }),
    fetchFrDepartures({ ...rest, incumbents: incumbents.fr }),
  ]);
  return [...gb, ...fr];
}

// ------------------------------------------------------------- helpers --------

function shiftDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function slug(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // FR birth names "(LE TEUFF)"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function titleCase(name) {
  return String(name)
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}
