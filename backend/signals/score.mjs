// Vantage — weak-signal scoring.
//
// TWO LAYERS, and the distinction matters:
//
//   1. a WEIGHTED SUM over the evidence, which gives fine-grained ordering — it
//      is what separates two leads that both match the same rule;
//   2. RULE FLOORS, which guarantee the thresholds the product asks for:
//        · chercheur/auteur + brevet déposé + création de société < 6 mois -> >= 80
//        · nouvel essai ClinicalTrials sans structure commerciale          -> >= 50
//        · dirigeant parti d'un grand groupe MedTech + société créée < 6 mois -> >= 80
//        · dirigeant parti d'un grand groupe, aucun nouveau mandat (stealth)  -> >= 50
//      A floor is `max(score, floor)`, never a replacement, so a lead matching the
//      high rule AND carrying five other signals still outranks a bare match.
//
// Implementing the thresholds as floors rather than hoping the weights add up to
// 80 is deliberate: the rules are a product promise, and a promise that depends
// on weight tuning is a promise that breaks the first time a weight is adjusted.
//
// Every signal type/strength emitted here is the app's own vocabulary
// (src/content/signalTypes.ts in the `vantage` repo), so a lead can be rendered
// by the existing SignalBadge with no translation layer.

import { daysBetween, isoDay } from './lib/dates.mjs';

/** Score at or above which a lead is "priorité haute". */
export const HIGH_PRIORITY_SCORE = 80;
/** Score at or above which a lead is "priorité moyenne". */
export const MEDIUM_PRIORITY_SCORE = 50;

/** "Création de société < 6 mois" — the window the high-priority rule asks for. */
export const RECENT_COMPANY_DAYS = 183;
/** A trial counts as "nouvel essai" for this long after its first posting. */
export const NEW_TRIAL_DAYS = 90;

/**
 * How each kind of record maps onto the app's signal vocabulary, and what it is
 * worth. Weights encode "how far does this move an investment decision":
 * incorporating is the strongest commitment, a patent is a real bet, a
 * publication is the faintest of the useful signals.
 */
export const SIGNAL_BY_RECORD_KIND = {
  company_creation: { signalType: 'company_incorporation', strength: 3, weight: 30 },
  patent: { signalType: 'patent_filing', strength: 2, weight: 25 },
  grant: { signalType: 'grant_award', strength: 3, weight: 20 },
  trial: { signalType: 'clinical_update', strength: 3, weight: 20 },
  publication: { signalType: 'publication_preprint', strength: 2, weight: 15 },
  // A leadership MOVE, so the app's « Dirigeant » type.
  departure: { signalType: 'leadership_hire', strength: 2, weight: 20 },
};

/** A departure stays a « stealth » candidate this long without a new mandate. */
export const STEALTH_WINDOW_DAYS = 365;
/** A company set up this long BEFORE leaving still counts as "the next thing". */
const PRE_DEPARTURE_GRACE_DAYS = 90;

/** Repeat signals of a kind already counted are worth this fraction of it. */
const REPEAT_FACTOR = 0.15;
/** …up to this much extra per kind, so a prolific lab cannot brute-force a score. */
const MAX_REPEAT_BONUS_PER_KIND = 12;
/** Corroboration across independent sources, per extra source. */
const CROSS_SOURCE_BONUS = 5;
const MAX_CROSS_SOURCE_BONUS = 15;

/**
 * Age discount, 1 down to `floor`.
 *
 * Flat for the first `freshDays` (a 3-week-old patent is not staler than a
 * 3-day-old one at VC timescales), then linear to the floor. Never zero: an old
 * publication still corroborates a person's identity, it just stops being news.
 */
export function recencyFactor(ageDays, opts = {}) {
  const { freshDays = 30, staleDays = 365, floor = 0.35 } = opts;
  if (!Number.isFinite(ageDays)) return floor;
  if (ageDays <= freshDays) return 1;
  if (ageDays >= staleDays) return floor;
  return 1 - ((ageDays - freshDays) / (staleDays - freshDays)) * (1 - floor);
}

/** Turn a hydrated record into a scored signal (before weighting decisions). */
function toSignal(record, today) {
  const mapping = SIGNAL_BY_RECORD_KIND[record.kind];
  if (!mapping) return null;
  const ageDays = daysBetween(record.date, today);
  return {
    signalType: mapping.signalType,
    strength: mapping.strength,
    recordKind: record.kind,
    source: record.source,
    sourceId: record.sourceId,
    title: record.title,
    url: record.url,
    date: record.date,
    ageDays: Number.isFinite(ageDays) ? ageDays : null,
    baseWeight: mapping.weight,
    ...(record.kind === 'departure' ? { extra: record.extra ?? {} } : {}),
  };
}

/**
 * Does this evidence match the HIGH-priority pattern?
 * Author/researcher + filed patent + a company incorporated less than 6 months ago.
 */
function matchesHighPriority(signals, context, today) {
  const kinds = new Set(signals.map((s) => s.recordKind));
  if (!kinds.has('publication') || !kinds.has('patent')) return null;

  // The incorporation can be attached to the person directly (Pappers lists them
  // as a director) or to a company entity the resolver linked them to.
  const incorporationDates = [
    ...signals.filter((s) => s.recordKind === 'company_creation').map((s) => s.date),
    ...(context.linkedCompanies ?? []).map((c) => c.incorporatedAt).filter(Boolean),
  ];

  const recent = incorporationDates
    .map((date) => ({ date, ageDays: daysBetween(date, today) }))
    .filter((d) => Number.isFinite(d.ageDays) && d.ageDays >= 0 && d.ageDays <= RECENT_COMPANY_DAYS)
    .sort((a, b) => a.ageDays - b.ageDays)[0];

  if (!recent) return null;
  return {
    id: 'researcher_patent_newco',
    floor: HIGH_PRIORITY_SCORE,
    reason:
      `Chercheur publiant + brevet déposé + société créée il y a ${Math.round(recent.ageDays / 30)} mois ` +
      `(${recent.date}) — le trio qui précède un tour d’amorçage.`,
  };
}

/**
 * Does this evidence match the MEDIUM-priority pattern?
 * A newly registered trial with no commercial structure identified behind it.
 */
function matchesMediumPriority(signals, context, today) {
  const trials = signals.filter((s) => s.recordKind === 'trial');
  if (!trials.length) return null;
  // A company already exists for this team — the point of the rule is the ABSENCE
  // of one, so a linked company disqualifies it.
  if ((context.linkedCompanies ?? []).length) return null;
  if (context.hasCommercialSponsor) return null;

  const fresh = trials
    .map((signal) => {
      const firstPosted = context.trialFirstPostedById?.[signal.sourceId] || signal.date;
      return { signal, ageDays: daysBetween(firstPosted, today), firstPosted };
    })
    .filter((t) => Number.isFinite(t.ageDays) && t.ageDays >= 0 && t.ageDays <= NEW_TRIAL_DAYS)
    .sort((a, b) => a.ageDays - b.ageDays)[0];

  if (!fresh) return null;
  return {
    id: 'new_trial_no_company',
    floor: MEDIUM_PRIORITY_SCORE,
    reason:
      `Nouvel essai clinique enregistré le ${fresh.firstPosted} sans structure commerciale ` +
      `identifiée (promoteur ${context.sponsorLabel || 'académique'}) — spin-out possible.`,
  };
}

/**
 * Departure rules. One of the two, never both:
 *   · `departure_newco` (HIGH)  — left an incumbent, and a company incorporated
 *     from 90 days before the departure onwards, less than 6 months ago, is
 *     attached to the person (Companies House appointments, a registry creation
 *     they direct, or a company the resolver linked them to);
 *   · `stealth_departure` (MEDIUM) — left within the last year and NO new
 *     mandate is known. When the register can say "no other active mandate at
 *     all" (UK), that is stated; in FR it rests on no creation having surfaced.
 */
function matchesDeparture(signals, context, today) {
  const departure = signals
    .filter((s) => s.recordKind === 'departure')
    .filter((s) => Number.isFinite(s.ageDays) && s.ageDays >= 0 && s.ageDays <= STEALTH_WINDOW_DAYS)
    .sort((a, b) => a.ageDays - b.ageDays)[0];
  if (!departure) return null;

  const incumbent = departure.extra?.incumbent || 'un grand groupe';
  const cutoff = shiftDays(departure.date, -PRE_DEPARTURE_GRACE_DAYS);
  const candidates = [
    ...(departure.extra?.newCompanies ?? []).map((c) => ({ name: c.name, date: c.incorporatedAt || c.appointedOn })),
    ...signals.filter((s) => s.recordKind === 'company_creation').map((s) => ({ name: s.title.replace(/^Création de /, ''), date: s.date })),
    ...(context.linkedCompanies ?? []).map((c) => ({ name: c.name, date: c.incorporatedAt })),
  ].filter((c) => c.date && c.date >= cutoff);

  const newco = candidates
    .map((c) => ({ ...c, ageDays: daysBetween(c.date, today) }))
    .filter((c) => Number.isFinite(c.ageDays) && c.ageDays >= 0 && c.ageDays <= RECENT_COMPANY_DAYS)
    .sort((a, b) => a.ageDays - b.ageDays)[0];

  if (newco) {
    return {
      id: 'departure_newco',
      floor: HIGH_PRIORITY_SCORE,
      reason:
        `A quitté ${incumbent} le ${departure.date} et dirige ${newco.name || 'une société'} ` +
        `créée le ${newco.date} — le spin-out d'un cadre de grand groupe, avant sa première levée.`,
    };
  }
  // Any later mandate (even an older company) means the person is not in stealth.
  if (candidates.length) return null;
  const others = departure.extra?.otherActiveMandates;
  if (others != null && others > 0) return null;

  const months = Math.max(1, Math.round(departure.ageDays / 30));
  return {
    id: 'stealth_departure',
    floor: MEDIUM_PRIORITY_SCORE,
    reason:
      `A quitté ${incumbent} ${departure.extra?.dateIsDetection ? 'vers le' : 'le'} ${departure.date} ` +
      `(il y a ~${months} mois) et n’a ${others === 0 ? 'plus aucun mandat social' : 'aucune nouvelle société connue'} ` +
      `depuis — silence typique d’un projet en stealth.`,
  };
}

/** Priority band for a score. */
export function priorityFor(score) {
  if (score >= HIGH_PRIORITY_SCORE) return 'high';
  if (score >= MEDIUM_PRIORITY_SCORE) return 'medium';
  return 'low';
}

/**
 * Score one lead's evidence.
 *
 * Pure: no I/O, no clock beyond the injected `now`.
 *
 * @param {object} input
 * @param {object[]} input.records  hydrated `SourceRecord[]` attached to the entity
 * @param {object} [input.context]
 * @param {Array<{name: string, incorporatedAt?: string}>} [input.context.linkedCompanies]
 * @param {boolean} [input.context.hasCommercialSponsor]
 * @param {string}  [input.context.sponsorLabel]
 * @param {Record<string, string>} [input.context.trialFirstPostedById]
 * @param {string|number|Date} [input.now]
 * @returns {{ score: number, priority: 'high'|'medium'|'low', signals: object[], reasons: string[], rules: string[] }}
 */
export function scoreLead(input) {
  const { records = [], context = {}, now = Date.now() } = input ?? {};
  const today = isoDay(now);

  const signals = records.map((record) => toSignal(record, today)).filter(Boolean);
  if (!signals.length) {
    return { score: 0, priority: 'low', signals: [], reasons: [], rules: [] };
  }

  // Newest first: the first signal of each kind is the one counted at full weight.
  signals.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const reasons = [];
  let total = 0;

  const seenKinds = new Map(); // recordKind -> bonus already granted
  for (const signal of signals) {
    const factor = recencyFactor(signal.ageDays);
    if (!seenKinds.has(signal.recordKind)) {
      const contribution = signal.baseWeight * factor;
      signal.contribution = round1(contribution);
      total += contribution;
      seenKinds.set(signal.recordKind, 0);
    } else {
      // Repeats add a little — a second patent IS more than one — but with a cap.
      const granted = seenKinds.get(signal.recordKind);
      const room = Math.max(0, MAX_REPEAT_BONUS_PER_KIND - granted);
      const contribution = Math.min(room, signal.baseWeight * REPEAT_FACTOR * factor);
      signal.contribution = round1(contribution);
      total += contribution;
      seenKinds.set(signal.recordKind, granted + contribution);
    }
  }

  const distinctSources = new Set(signals.map((s) => s.source)).size;
  if (distinctSources > 1) {
    const bonus = Math.min(MAX_CROSS_SOURCE_BONUS, (distinctSources - 1) * CROSS_SOURCE_BONUS);
    total += bonus;
    reasons.push(`Corroboré par ${distinctSources} sources indépendantes (+${bonus}).`);
  }

  const weighted = Math.round(Math.max(0, Math.min(100, total)));

  // Which named rules matched.
  const rules = [];
  let floor = 0;
  for (const match of [
    matchesHighPriority(signals, context, today),
    matchesMediumPriority(signals, context, today),
    matchesDeparture(signals, context, today),
  ]) {
    if (!match) continue;
    rules.push(match.id);
    reasons.unshift(match.reason); // the rule is the headline reason
    floor = Math.max(floor, match.floor);
  }

  // The HIGH band is RESERVED for the high-priority pattern. Without this
  // ceiling the weighted sum alone reaches 80 by sheer accumulation, and the
  // first live run with patents proved it: the only "priorité haute" lead was
  // B. Braun Melsungen — an 8 B€ incumbent with ten signals and NO rule matched.
  // A large industrial group files patents, publishes and runs trials
  // continuously, so it out-accumulates exactly the emerging teams this pipeline
  // exists to find. Score >= 80 now means "chercheur + brevet + société < 6 mois",
  // and nothing else; the weighted sum still orders everything below it.
  // `departure_newco` is the second pattern allowed into the band: an executive
  // leaving a major group to direct a 3-month-old company is exactly the
  // pre-round lead this pipeline exists for.
  const ceiling =
    rules.includes('researcher_patent_newco') || rules.includes('departure_newco') ? 100 : HIGH_PRIORITY_SCORE - 1;
  const score = Math.min(ceiling, Math.max(weighted, floor));

  return { score, priority: priorityFor(score), signals, reasons, rules };
}

function shiftDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
