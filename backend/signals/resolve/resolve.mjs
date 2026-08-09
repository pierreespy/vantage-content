// Vantage — entity resolution: turn scattered source records into stable entities.
//
// WHY THIS HAS TO PERSIST ACROSS RUNS
// The high-priority pattern is "a researcher published, then filed a patent, then
// incorporated". Those three events are months apart. A single run — which looks
// back 30 days for publications and trials — can physically never see all three.
// So resolved entities are stored in `signal-state/entities.json` and each run
// MERGES into them. The store is the pipeline's memory of who is who; without it
// the whole scoring model would be unreachable. (No database: the architecture
// decision in docs/signals-plan.md is 0 € of infra, state in git.)
//
// ALGORITHM
//   1. flatten records into person / organization MENTIONS;
//   2. index existing entities by blocking key (family name, first company token)
//      and by ORCID, so matching is O(block) rather than O(n²);
//   3. for each mention, collect EVERY existing cluster above the match threshold
//      and merge them all together with it — a new mention carrying an ORCID can
//      bridge two clusters that were previously kept apart;
//   4. link people to organizations that co-occur on the same record;
//   5. prune what has not been seen in a long time, and cap the records kept per
//      entity, so the committed state file stays small and diff-readable.

import { createHash } from 'node:crypto';
import { parsePerson, normalizeCompany } from '../lib/normalize.mjs';
import { isoDay, dayNumber } from '../lib/dates.mjs';
import {
  COMPANY_MATCH_THRESHOLD,
  PERSON_MATCH_THRESHOLD,
  matchCompanies,
  matchPersons,
} from './match.mjs';

/** Organization roles that denote a real structure. `affiliation` is excluded on
 *  purpose: PubMed puts the JOURNAL there, and a journal is not a company. */
const ORG_ENTITY_ROLES = new Set(['company', 'applicant', 'sponsor', 'collaborator']);

/** Keep the state file small: only the most recent records per entity. */
const MAX_RECORDS_PER_ENTITY = 40;
/** Forget entities not seen for this long. */
const DEFAULT_RETENTION_DAYS = 540;

/** Short, deterministic suffix so a new entity id is reproducible for a given seed. */
function shortHash(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

/** The record fields an entity keeps — never the whole payload. */
function recordRef(record, role) {
  return {
    source: record.source,
    sourceId: record.sourceId,
    kind: record.kind,
    date: record.date,
    title: record.title,
    url: record.url,
    role,
    ...(record.country ? { country: record.country } : {}),
  };
}

/**
 * Flatten records into the mentions the resolver clusters.
 *
 * @returns {{ persons: object[], organizations: object[] }}
 */
export function mentionsFromRecords(records = []) {
  const persons = [];
  const organizations = [];

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;

    for (const person of record.people ?? []) {
      persons.push({
        name: person.name,
        orcid: person.orcid ?? '',
        affiliation: person.affiliation ?? '',
        country: record.country ?? '',
        role: person.role,
        record,
      });
    }

    for (const org of record.organizations ?? []) {
      if (!ORG_ENTITY_ROLES.has(org.role)) continue;
      organizations.push({
        name: org.name,
        orgKind: org.kind ?? '',
        country: record.country ?? '',
        role: org.role,
        record,
      });
    }
  }

  return { persons, organizations };
}

/** Blocking key: only mentions sharing it are ever compared. */
function blockKeyFor(kind, mention) {
  if (kind === 'person') return parsePerson(mention.name).family || '';
  return normalizeCompany(mention.name).split(' ')[0] ?? '';
}

/** A fresh cluster seeded from one mention. */
function newCluster(kind, mention, today) {
  const seed =
    mention.orcid ||
    `${mention.name}|${mention.record?.source ?? ''}:${mention.record?.sourceId ?? ''}`;
  const id = mention.orcid
    ? `${kind}:orcid:${mention.orcid}`
    : `${kind}:${blockKeyFor(kind, mention) || 'x'}:${shortHash(seed)}`;

  return {
    id,
    kind,
    name: mention.name,
    aliases: [],
    orcid: mention.orcid ?? '',
    countries: [],
    affiliations: [],
    attributes: {},
    records: [],
    links: [],
    // Four dates, and they mean different things — conflating them is a bug that
    // silently breaks both retention and scoring:
    //   firstSeen/lastSeen   the RUN days we created / last touched this entity
    //                        (retention is measured on lastSeen);
    //   firstEvidence/latestEvidence  the earliest / latest RECORD date attached
    //                        (scoring's recency and "created < 6 months" read these).
    firstSeen: today,
    lastSeen: today,
    firstEvidence: '',
    latestEvidence: '',
  };
}

/** Add a value to an entity's string list, deduped and capped. */
function addUnique(list, value, max = 12) {
  if (!value || list.includes(value)) return list;
  list.push(value);
  return list.length > max ? list.slice(0, max) : list;
}

/**
 * How good a spelling is as the DISPLAYED name.
 *
 * Longer is more informative ("Jean-Marc Dupont" over "Dupont JM"), but an
 * ALL-CAPS spelling — which is all EPO and the registries ever emit — reads
 * badly and loses to any mixed-case spelling of the same length.
 */
function displayRank(name) {
  const shouted = name === name.toUpperCase() && /[A-ZÀ-Þ]/.test(name);
  return (shouted ? 0 : 1000) + name.length;
}

/** Fold one mention into a cluster (in place). */
function absorb(cluster, mention, today) {
  if (mention.name && displayRank(mention.name) > displayRank(cluster.name)) {
    addUnique(cluster.aliases, cluster.name);
    cluster.name = mention.name;
  } else if (mention.name && mention.name !== cluster.name) {
    addUnique(cluster.aliases, mention.name);
  }

  if (mention.orcid && !cluster.orcid) cluster.orcid = mention.orcid;
  if (mention.affiliation) addUnique(cluster.affiliations, mention.affiliation, 8);
  if (mention.country) addUnique(cluster.countries, mention.country, 6);

  // Enrichment: registry facts (SIREN, incorporation date, NAF) and the sponsor
  // class are what downstream scoring and the API read off an organization.
  const extra = mention.record?.extra ?? {};
  if (mention.orgKind && mention.orgKind !== 'UNKNOWN') cluster.attributes.orgKind = mention.orgKind;
  for (const key of ['siren', 'incorporatedAt', 'nafLabel', 'city', 'program']) {
    if (extra[key] && !cluster.attributes[key]) cluster.attributes[key] = extra[key];
  }

  const ref = recordRef(mention.record, mention.role);
  const refKey = `${ref.source}:${ref.sourceId}:${ref.role}`;
  if (!cluster.records.some((r) => `${r.source}:${r.sourceId}:${r.role}` === refKey)) {
    cluster.records.push(ref);
  }

  if (!cluster.firstEvidence || ref.date < cluster.firstEvidence) cluster.firstEvidence = ref.date;
  if (ref.date > cluster.latestEvidence) cluster.latestEvidence = ref.date;
  cluster.lastSeen = today; // touched by this run
}

/** Merge `source` into `target` (in place), keeping `target`'s id. */
function mergeClusters(target, source) {
  addUnique(target.aliases, source.name);
  for (const alias of source.aliases) addUnique(target.aliases, alias);
  for (const affiliation of source.affiliations) addUnique(target.affiliations, affiliation, 8);
  for (const country of source.countries) addUnique(target.countries, country, 6);
  if (!target.orcid && source.orcid) target.orcid = source.orcid;
  target.attributes = { ...source.attributes, ...target.attributes };

  const seen = new Set(target.records.map((r) => `${r.source}:${r.sourceId}:${r.role}`));
  for (const ref of source.records) {
    const key = `${ref.source}:${ref.sourceId}:${ref.role}`;
    if (!seen.has(key)) {
      seen.add(key);
      target.records.push(ref);
    }
  }
  for (const link of source.links) if (!target.links.includes(link)) target.links.push(link);

  if (source.firstSeen && source.firstSeen < target.firstSeen) target.firstSeen = source.firstSeen;
  if (source.lastSeen && source.lastSeen > target.lastSeen) target.lastSeen = source.lastSeen;
  if (source.firstEvidence && (!target.firstEvidence || source.firstEvidence < target.firstEvidence)) {
    target.firstEvidence = source.firstEvidence;
  }
  if (source.latestEvidence && source.latestEvidence > (target.latestEvidence ?? '')) {
    target.latestEvidence = source.latestEvidence;
  }
  if (displayRank(source.name) > displayRank(target.name)) {
    addUnique(target.aliases, target.name);
    target.name = source.name;
  }
}

/** Mutable index over clusters, so matching only ever scans one block. */
function createIndex(clusters) {
  const byId = new Map();
  const blocks = new Map();
  const byOrcid = new Map();

  function indexCluster(cluster) {
    byId.set(cluster.id, cluster);
    if (cluster.orcid) byOrcid.set(cluster.orcid, cluster.id);
    // Index under every spelling: aliases are what make a later "Dupont JM"
    // land in the same block as the stored "DUPONT Jean-Marc".
    for (const name of [cluster.name, ...cluster.aliases]) {
      const key = blockKeyFor(cluster.kind, { name });
      if (!key) continue;
      if (!blocks.has(key)) blocks.set(key, new Set());
      blocks.get(key).add(cluster.id);
    }
  }

  for (const cluster of clusters) indexCluster(cluster);

  return {
    byId,
    add: indexCluster,
    candidates(kind, mention) {
      if (kind === 'person' && mention.orcid && byOrcid.has(mention.orcid)) {
        return [byId.get(byOrcid.get(mention.orcid))].filter(Boolean);
      }
      const key = blockKeyFor(kind, mention);
      const ids = key ? blocks.get(key) : null;
      return ids ? [...ids].map((id) => byId.get(id)).filter(Boolean) : [];
    },
    remove(id) {
      byId.delete(id);
      for (const set of blocks.values()) set.delete(id);
      for (const [orcid, mapped] of byOrcid) if (mapped === id) byOrcid.delete(orcid);
    },
  };
}

/** Best-effort representative of a cluster, used when scoring a mention against it. */
function clusterAsMention(cluster) {
  return {
    name: cluster.name,
    orcid: cluster.orcid,
    affiliation: cluster.affiliations.join(' '),
    country: cluster.countries[0] ?? '',
  };
}

/**
 * Resolve records into entities, merging into what we already knew.
 *
 * Pure apart from the injected `now`: same stored state + same records => same
 * entities, which is what keeps the committed state file stable.
 *
 * @param {Record<string, object>} stored  entities from the previous run
 * @param {object[]} records               this run's `SourceRecord[]`
 * @param {object} [opts]
 * @returns {{ entities: Record<string, object>, stats: object }}
 */
export function resolveEntities(stored = {}, records = [], opts = {}) {
  const {
    now = Date.now(),
    retentionDays = DEFAULT_RETENTION_DAYS,
    maxRecordsPerEntity = MAX_RECORDS_PER_ENTITY,
  } = opts;

  const today = isoDay(now);
  const todayDay = dayNumber(today);

  // Deep-ish copy so the caller's stored object is never mutated.
  const clusters = Object.values(stored)
    .filter((entity) => entity?.id && entity?.kind)
    .map((entity) => ({
      ...entity,
      aliases: [...(entity.aliases ?? [])],
      countries: [...(entity.countries ?? [])],
      affiliations: [...(entity.affiliations ?? [])],
      attributes: { ...(entity.attributes ?? {}) },
      records: [...(entity.records ?? [])],
      links: [...(entity.links ?? [])],
      firstEvidence: entity.firstEvidence ?? '',
      latestEvidence: entity.latestEvidence ?? '',
    }));

  const index = createIndex(clusters);
  const stats = { created: 0, merged: 0, bridged: 0 };

  /** Assign one mention: merge into matching clusters, or start a new one. */
  function assign(kind, mention) {
    const threshold = kind === 'person' ? PERSON_MATCH_THRESHOLD : COMPANY_MATCH_THRESHOLD;
    const score = kind === 'person' ? matchPersons : matchCompanies;

    const matches = index
      .candidates(kind, mention)
      .map((cluster) => ({ cluster, ...score(clusterAsMention(cluster), mention) }))
      .filter((m) => m.score >= threshold)
      .sort((a, b) => b.score - a.score);

    if (!matches.length) {
      const cluster = newCluster(kind, mention, today);
      absorb(cluster, mention, today);
      index.add(cluster);
      stats.created += 1;
      return cluster;
    }

    // Merge every match into the strongest one: a mention that matches two
    // clusters is evidence those clusters were the same entity all along.
    const [best, ...rest] = matches;
    for (const other of rest) {
      mergeClusters(best.cluster, other.cluster);
      index.remove(other.cluster.id);
      stats.bridged += 1;
    }
    absorb(best.cluster, mention, today);
    // Re-index under any new alias picked up from this mention.
    index.add(best.cluster);
    stats.merged += 1;
    return best.cluster;
  }

  const { persons, organizations } = mentionsFromRecords(records);

  // Assign organizations first: a person's link then always points at a cluster
  // that already exists.
  const orgByRecord = new Map();
  for (const mention of organizations) {
    const cluster = assign('company', mention);
    const key = `${mention.record.source}:${mention.record.sourceId}`;
    if (!orgByRecord.has(key)) orgByRecord.set(key, new Set());
    orgByRecord.get(key).add(cluster.id);
  }

  const personByRecord = new Map();
  for (const mention of persons) {
    const cluster = assign('person', mention);
    const key = `${mention.record.source}:${mention.record.sourceId}`;
    if (!personByRecord.has(key)) personByRecord.set(key, new Set());
    personByRecord.get(key).add(cluster.id);
  }

  // Co-occurrence links: an inventor and the applicant on the same patent, a
  // director and the company they registered. This is what lets a lead say
  // "cette personne ET cette société".
  let linked = 0;
  for (const [recordKey, personIds] of personByRecord) {
    const orgIds = orgByRecord.get(recordKey);
    if (!orgIds) continue;
    for (const personId of personIds) {
      const person = index.byId.get(personId);
      if (!person) continue;
      for (const orgId of orgIds) {
        const org = index.byId.get(orgId);
        if (!org) continue;
        if (!person.links.includes(orgId)) {
          person.links.push(orgId);
          linked += 1;
        }
        if (!org.links.includes(personId)) org.links.push(personId);
      }
    }
  }
  stats.linked = linked;

  // Trim and prune.
  const entities = {};
  for (const cluster of index.byId.values()) {
    const lastSeenDay = dayNumber(cluster.lastSeen);
    if (Number.isFinite(lastSeenDay) && todayDay - lastSeenDay > retentionDays) continue;

    cluster.records.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    cluster.records = cluster.records.slice(0, maxRecordsPerEntity);
    // Links can only point at entities that survived the prune.
    cluster.links = cluster.links.filter((id) => index.byId.has(id));
    entities[cluster.id] = cluster;
  }

  stats.total = Object.keys(entities).length;
  return { entities, stats };
}
