// Vantage — turn resolved entities into scored MedTech leads.
//
// This is where the three halves of the pipeline meet: entities (who), records
// (what happened) and score.mjs (how much it matters). The output is the shape
// the API serves and the app could render — one object per lead, carrying the
// DETAIL OF THE SIGNALS that produced its score, because a score nobody can audit
// is a score nobody will act on.
//
// Not every entity becomes a lead:
//   - PEOPLE always can — a researcher is exactly who a seed fund wants to reach;
//   - COMPANIES only when they look commercial (an incorporation, a SIREN, an
//     INDUSTRY sponsor class), OR when they are the academic sponsor of a brand
//     new trial with no company attached, which IS the medium-priority signal.
//
// That second case needs three guards, all of them learned from running the
// pipeline against live ClinicalTrials.gov data, where it otherwise fills the
// list with universities and hospital groups:
//
//   1. an ORGANISATION NAME that says "institution" ("… University", "CHU …",
//      "… Hospital", "… Foundation") is never a sourcing lead — nobody pitches
//      a university;
//   2. if the trial has a named INVESTIGATOR, the signal belongs to that person,
//      not to their employer — the person is who you would actually contact;
//   3. an organisation sponsoring many trials is an institution by definition.
//
// Guard 2 is why the signal is not lost: the org lead only appears when there is
// no person to carry it.

import { scoreLead } from './score.mjs';
import { isoDay } from './lib/dates.mjs';

/** Above this many trials, an academic sponsor is an institution, not a lead. */
const MAX_TRIALS_FOR_INSTITUTION_LEAD = 3;

/**
 * Names that mark a research institution rather than a spin-out candidate.
 * Matched on the raw name, accents included, FR + EN + the forms
 * ClinicalTrials.gov actually emits.
 */
const INSTITUTION_NAME = new RegExp(
  [
    'universit', // University / Université / Universitat / Università
    'hospital', 'h[oô]pital', 'hospices', 'klinik', 'clinic',
    '\\bchu\\b', '\\bchru\\b', '\\bahp\\b', 'assistance publique',
    'medical cent(er|re)', 'cancer cent(er|re)', 'health system',
    'foundation', 'fondation', 'fondazione', 'fundaci[oó]n', 'funda[çc][aã]o',
    'stiftung', 'stichting', 'association', 'onlus', '\\btrust\\b', '\\bcouncil\\b',
    'college', 'school', 'academy', 'acad[ée]mie',
    'ministry', 'minist[èe]re', '\\bnhs\\b', '\\binserm\\b', '\\bcnrs\\b',
  ].join('|'),
  'i'
);

/** Default cut-off: below this, a "lead" is a single faint signal and pure noise. */
export const DEFAULT_MIN_SCORE = 25;

/** Signals shown per lead. Enough to justify the score, not the entity's whole history. */
const MAX_SIGNALS_PER_LEAD = 12;

/** Index records so an entity's refs can be hydrated back into full records. */
export function indexRecords(records = []) {
  const byKey = new Map();
  for (const record of records) {
    if (record?.source && record?.sourceId) byKey.set(`${record.source}:${record.sourceId}`, record);
  }
  return byKey;
}

/** An entity looks commercial when something says a company actually exists. */
function isCommercialLike(entity) {
  if (entity.kind !== 'company') return false;
  if (entity.attributes?.orgKind === 'INDUSTRY') return true;
  if (entity.attributes?.siren || entity.attributes?.incorporatedAt) return true;
  return (entity.records ?? []).some((r) => r.kind === 'company_creation');
}

/** Incorporation date known for an entity, from its attributes or its records. */
function incorporationDate(entity) {
  if (entity?.attributes?.incorporatedAt) return entity.attributes.incorporatedAt;
  const creation = (entity?.records ?? [])
    .filter((r) => r.kind === 'company_creation')
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  return creation?.date ?? '';
}

/** Build the scoring context for one entity: its companies and its trial facts. */
function buildContext(entity, hydrated, entities) {
  const linkedCompanies = (entity.links ?? [])
    .map((id) => entities[id])
    .filter((linked) => linked && linked.kind === 'company' && isCommercialLike(linked))
    .map((linked) => ({
      id: linked.id,
      name: linked.name,
      incorporatedAt: incorporationDate(linked),
    }));

  // A company entity that is itself commercial counts as its own structure.
  if (isCommercialLike(entity)) {
    linkedCompanies.unshift({
      id: entity.id,
      name: entity.name,
      incorporatedAt: incorporationDate(entity),
    });
  }

  const trials = hydrated.filter((record) => record.kind === 'trial');
  const trialFirstPostedById = {};
  let hasCommercialSponsor = false;
  let sponsorLabel = '';
  for (const trial of trials) {
    trialFirstPostedById[trial.sourceId] = trial.extra?.firstPostedAt || trial.date;
    if (trial.extra?.hasCommercialSponsor) hasCommercialSponsor = true;
    if (!sponsorLabel && trial.extra?.leadSponsor) sponsorLabel = trial.extra.leadSponsor;
  }

  return { linkedCompanies, hasCommercialSponsor, sponsorLabel, trialFirstPostedById, trials };
}

/**
 * Should this entity be offered as a lead at all?
 *
 * @param {Set<string>} trialsWithInvestigator `source:sourceId` of trials that
 *   already have a person entity attached — their signal belongs to that person.
 */
function isLeadCandidate(entity, context, rules, trialsWithInvestigator) {
  if (entity.kind === 'person') return true;
  if (isCommercialLike(entity)) return true;

  // From here on: an academic / public organisation. It can only earn a lead as
  // the medium-priority "new trial with no company" case.
  if (!rules.includes('new_trial_no_company')) return false;
  if (INSTITUTION_NAME.test(entity.name)) return false; // guard 1
  if (context.trials.length > MAX_TRIALS_FOR_INSTITUTION_LEAD) return false; // guard 3

  // Guard 2: if any of its trials has a named investigator, that person is the
  // lead and this organisation would only duplicate them.
  return !context.trials.some((trial) =>
    trialsWithInvestigator.has(`${trial.source}:${trial.sourceId}`)
  );
}

/** Trials that already have a person entity attached (an investigator we can name). */
function trialsCoveredByAPerson(entities) {
  const covered = new Set();
  for (const entity of Object.values(entities)) {
    if (entity.kind !== 'person') continue;
    for (const ref of entity.records ?? []) {
      if (ref.kind === 'trial') covered.add(`${ref.source}:${ref.sourceId}`);
    }
  }
  return covered;
}

/**
 * Build the scored lead list.
 *
 * @param {object} input
 * @param {Record<string, object>} input.entities  resolved entities
 * @param {object[]} input.records                 every record seen this run
 * @param {number} [input.minScore=25]
 * @param {Set<string>} [input.emittedKeys] `source:sourceId` of records the diffing
 *   step found NEW or CHANGED this run. Signals are flagged `isNew` accordingly, so
 *   the editorial routine can surface only what it has not already published —
 *   the "n'émettre un signal que si nouveau ou changé" rule of docs/signals-plan.md.
 * @param {string|number|Date} [input.now]
 * @returns {{ leads: object[], stats: object }} leads sorted by score, newest first on ties
 */
export function buildLeads(input) {
  const {
    entities = {},
    records = [],
    minScore = DEFAULT_MIN_SCORE,
    emittedKeys = new Set(),
    now = Date.now(),
  } = input ?? {};
  const today = isoDay(now);
  const byKey = indexRecords(records);
  const trialsWithInvestigator = trialsCoveredByAPerson(entities);

  const leads = [];
  let skippedBelowMin = 0;
  let skippedNotCandidate = 0;

  for (const entity of Object.values(entities)) {
    // Hydrate refs into full records. A ref whose record is not in THIS run's
    // batch (it came from an earlier run) still counts: the ref itself carries
    // enough — kind, date, title, url — to be scored as a signal.
    const hydrated = (entity.records ?? []).map(
      (ref) => byKey.get(`${ref.source}:${ref.sourceId}`) ?? { ...ref, extra: {}, keywords: [] }
    );
    if (!hydrated.length) continue;

    const context = buildContext(entity, hydrated, entities);
    const { score, priority, signals, reasons, rules } = scoreLead({ records: hydrated, context, now });

    if (!isLeadCandidate(entity, context, rules, trialsWithInvestigator)) {
      skippedNotCandidate += 1;
      continue;
    }
    if (score < minScore) {
      skippedBelowMin += 1;
      continue;
    }

    const keywords = [...new Set(hydrated.flatMap((record) => record.keywords ?? []))].slice(0, 20);
    const countries = [
      ...new Set([...(entity.countries ?? []), ...hydrated.map((r) => r.country).filter(Boolean)]),
    ];
    const company =
      context.linkedCompanies[0]?.name ?? (entity.kind === 'company' ? entity.name : '');

    leads.push({
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      aliases: entity.aliases ?? [],
      ...(entity.orcid ? { orcid: entity.orcid } : {}),
      company,
      companies: context.linkedCompanies.map((c) => c.name),
      country: countries[0] ?? '',
      countries,
      score,
      priority,
      rules,
      reasons,
      // The auditable part: what actually fired, with each signal's contribution.
      signals: signals.slice(0, MAX_SIGNALS_PER_LEAD).map((signal) => ({
        signalType: signal.signalType,
        strength: signal.strength,
        recordKind: signal.recordKind,
        source: signal.source,
        sourceId: signal.sourceId,
        title: signal.title,
        url: signal.url,
        date: signal.date,
        contribution: signal.contribution ?? 0,
        isNew: emittedKeys.has(`${signal.source}:${signal.sourceId}`),
      })),
      signalCount: signals.length,
      newSignalCount: signals.filter((s) => emittedKeys.has(`${s.source}:${s.sourceId}`)).length,
      sources: [...new Set(signals.map((s) => s.source))],
      keywords,
      firstEvidence: entity.firstEvidence || '',
      latestEvidence: entity.latestEvidence || '',
      updatedAt: today,
    });
  }

  // Deterministic order: score, then freshness, then id — so an unchanged day
  // produces a byte-identical file and nothing gets committed for nothing.
  leads.sort(
    (a, b) =>
      b.score - a.score ||
      (a.latestEvidence < b.latestEvidence ? 1 : a.latestEvidence > b.latestEvidence ? -1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );

  return {
    leads,
    stats: {
      total: leads.length,
      high: leads.filter((l) => l.priority === 'high').length,
      medium: leads.filter((l) => l.priority === 'medium').length,
      skippedBelowMin,
      skippedNotCandidate,
    },
  };
}
