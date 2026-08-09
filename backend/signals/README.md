# Vantage — MedTech weak-signal pipeline

Phases 1 & 2 of [`docs/signals-plan.md`](../../../vantage/docs/signals-plan.md) (in the
`vantage` repo). Ingests public MedTech data sources, resolves them into entities,
scores them, and publishes **sourcing leads** — the researchers and just-formed
companies worth contacting *before* a funding round makes them obvious.

**Zero dependencies. Zero infra. Zero euro.** Plain Node ESM, `node:test`, state in
git, jobs in GitHub Actions — the architecture the plan fixed.

```bash
node run.mjs                    # one full run
DRY_RUN=1 node run.mjs          # compute everything, write nothing
node --test                     # the whole suite (~200 tests, no network)
node api/serve.mjs              # the leads endpoint on :8787
```

---

## The five steps

```
sources/  ──▶  lib/state.mjs  ──▶  resolve/  ──▶  score.mjs  ──▶  publish.mjs
 INGEST         DIFF               RESOLVE        SCORE           PUBLISH
 6 APIs         new or changed?    who is who?    weights+rules   medtech-leads.json
```

| Step | Module | What it does |
|---|---|---|
| **1. Ingest** | `sources/` | Six connectors, run concurrently, each rate-limited and cached |
| **2. Diff** | `lib/state.mjs` | Compare to `signal-state/` — only **new or changed** records emit a signal |
| **3. Resolve** | `resolve/` | Join authors ↔ inventors ↔ directors into persistent entities |
| **4. Score** | `score.mjs`, `leads.mjs` | Weighted signals + the two rule floors |
| **5. Publish** | `publish.mjs` | Write `medtech-leads.json`; the workflow commits it |

---

## 1. Sources

| Connector | API | Key? | Signal |
|---|---|---|---|
| `pubmed.mjs` | NCBI E-utilities | optional (raises 3→10 req/s) | publications + **authors** |
| `europepmc.mjs` | Europe PMC | no | publications + preprints, **ORCID** + affiliations |
| `patents.mjs` | EPO OPS (Espacenet) | **yes** (OAuth2) | patents + **inventors** |
| `trials.mjs` | ClinicalTrials.gov v2 | no | new trials **and status changes** |
| `grants.mjs` | i-Lab / i-PhD / EIC | configurable | grant laureates |
| `registry.mjs` | Pappers (French RNE/RCS) | **yes** | incorporations + **directors** |

Every connector produces the same `SourceRecord` (`lib/record.mjs`), so adding a
seventh source means writing one parser and nothing else.

**A missing credential is never fatal**: that source logs a warning, returns `[]`,
and the run continues. Same for a source that throws.

### On the grants connector

None of i-Lab, i-PhD or EIC Accelerator publishes a free, documented, stable JSON
API — Bpifrance publishes laureates as web pages and PDFs, and the EIC/CORDIS
exports are bulk CSV/JSON with versioned URLs. Hard-coding a URL would ship
something that 404s within a season.

So `grants.mjs` is a **configurable adapter**: a feed descriptor says where the
rows are and which column means what (`grants.feeds.json`). The shipped feeds
point at empty placeholders in `sources/data/`; override any of them with an
`https:` export or a `file:` curated list via `GRANTS_*_URL`. It parses JSON and
CSV out of the box.

> Google Patents is deliberately **not** used as a patent fallback: no official
> public API, and scraping it would breach its terms — the same reason LinkedIn
> is excluded in the plan.

### Rate limiting & caching

Connectors never call `fetch`. They go through `lib/http.mjs`, which layers:

- **per-host rate limiting** (`lib/ratelimit.mjs`) — one limiter per host, shared
  across connectors, because the published limit is per host, not per caller.
  Exceeding NCBI's gets an IP *banned*, not throttled;
- **TTL disk cache** (`lib/cache.mjs`) — 12 h by default, which is what keeps
  repeated runs inside free quotas;
- **bounded retries** with exponential backoff, honouring `Retry-After`, on the
  errors that are actually transient (network, 429, 5xx) and never on a 404.

---

## 2. Diffing — why there is state at all

A weak signal is not *"this trial exists"*, it is *"this trial **changed**"*.
Each source defines a **fingerprint** over the fields whose change *is* the
signal — for a trial, `overallStatus|lastUpdatePostDate`. A record re-emits only
when it is new or its fingerprint moved, which is what stops the pipeline from
re-announcing the same trial every morning.

State lives in [`signal-state/`](../../signal-state/), committed on every run.

---

## 3. Entity resolution

The plan calls name matching **"Risque n°1"**, and it is: the same person is
spelled differently by every source.

```
PubMed    "Dupont JM"
EPO       "DUPONT JEAN-MARC [FR]"
Pappers   "Jean-Marc Dupont"
```

`lib/normalize.mjs` canonicalises all three to the same key; `resolve/match.mjs`
scores pairs; `resolve/resolve.mjs` clusters them into entities stored in
`signal-state/entities.json`.

The bias is towards **precision**. A false negative loses one lead; a false
positive *invents* one, which is worse. So a shared family name and a single
initial is deliberately **below** the merge threshold — it needs corroboration
(an ORCID, an agreeing full given name, or overlapping affiliations), and very
common family names are penalised further.

**Entities persist across runs, and they must.** A single run looks back 30 days;
the March publication, May patent and June incorporation that form the
high-priority pattern can only ever meet through accumulated state.

---

## 4. Scoring

Two layers, and the distinction matters:

**(a) a weighted sum**, which gives fine-grained ordering:

| Signal | Weight | Maps to |
|---|---|---|
| Company incorporation | 30 | `company_incorporation` |
| Patent filing | 25 | `patent_filing` |
| Grant award | 20 | `grant_award` |
| Clinical trial | 20 | `clinical_update` |
| Publication / preprint | 15 | `publication_preprint` |

…discounted by age (flat for 30 days, then decaying to a 0.35 floor), with
repeats of one kind capped (+12 max) and a cross-source corroboration bonus
(+5 per extra source, +15 max).

**(b) rule floors**, which *guarantee* the thresholds the product promises:

| Rule | Pattern | Floor |
|---|---|---|
| `researcher_patent_newco` | author + patent + company incorporated **< 6 months** | **80** |
| `new_trial_no_company` | new trial, **no commercial structure** identified | **50** |

A floor is `max(score, floor)` — never a replacement — so a lead matching a rule
*and* carrying five other signals still outranks a bare match.

> Implementing the thresholds as floors rather than hoping the weights sum to 80
> is deliberate: the rules are a product promise, and a promise that depends on
> weight tuning breaks the first time a weight is adjusted.

Signal types are the **app's own vocabulary** (`src/content/signalTypes.ts` in
`vantage`), so a lead renders with the existing `SignalBadge`, no translation.

---

## 5. The leads API

The production read path is the **static `medtech-leads.json`**, published to
GitHub Pages exactly like `edition.json` / `startup-news.json` / `words.json`
(see `src/config.ts`). `api/serve.mjs` is the same data over HTTP, for local and
CI use — and the reference implementation of the contract. Both share the pure
query core in `api/query.mjs`, so the semantics cannot drift.

```
GET /api/medtech/leads       list, filter, paginate
GET /api/medtech/leads/:id   one lead with its full signal detail
GET /health                  liveness + leads loaded
```

| Parameter | Aliases | Meaning |
|---|---|---|
| `min_score` | `minScore`, `score_min` | 0-100 |
| `country` | `pays`, `countries` | comma-separated ISO-3166 alpha-2 |
| `keywords` | `mots_cles`, `q` | comma-separated; searches names, aliases, companies, keywords and signal titles |
| `match` | — | `all` (default, narrows) or `any` |
| `date_from` / `date_to` | `date_debut` / `date_fin` | ISO `AAAA-MM-JJ`, filtered on latest evidence |
| `priority` | `priorite` | `high` / `medium` / `low` |
| `sort` | — | `score` (default), `date`, `name` |
| `page` / `page_size` | `par_page` | 1-based; page size max 100, default 25 |

An invalid value is a **400 with a readable message**, never a silent full result
— a typo in `min_score` must fail loudly.

```bash
curl 'http://localhost:8787/api/medtech/leads?min_score=80&pays=FR&page_size=5'
```

```jsonc
{
  "generatedAt": "2026-08-09",
  "page": 1, "pageSize": 5, "total": 12, "totalPages": 3, "hasMore": true,
  "filters": { "min_score": 80, "country": ["FR"], "…": "…" },
  "items": [
    {
      "id": "person:dupont:1a2b3c4d",
      "kind": "person",
      "name": "Jean-Marc Dupont",
      "company": "NEUROSCAN MEDICAL SAS",
      "country": "FR",
      "score": 85,
      "priority": "high",
      "rules": ["researcher_patent_newco"],
      "reasons": [
        "Chercheur publiant + brevet déposé + société créée il y a 2 mois (2026-06-14) — le trio qui précède un tour d'amorçage."
      ],
      "signals": [
        { "signalType": "patent_filing", "source": "epo", "sourceId": "EP4123456A1",
          "date": "2026-05-15", "contribution": 25, "isNew": true, "…": "…" }
      ]
    }
  ]
}
```

Each lead carries **the signals that produced its score, with each one's
contribution** — a score nobody can audit is a score nobody will act on. The
typed contract lives in `src/content/leadTypes.ts` (`vantage`), so the two repos
cannot drift silently.

---

## Configuration

Every variable is documented in [`.env.example`](../../.env.example) and read in
exactly one place, `config.mjs`. Nothing below the entrypoints touches
`process.env`, which is what lets every test construct the config it wants.

## Tests

```bash
node --test          # everything
node --test score.test.mjs
```

No test touches the network: `fetch`, the clock and `sleep` are injected. Parser
tests run on realistic recorded payload shapes — including the two that actually
broke things: EPO collapsing single-element lists into bare objects, and Europe
PMC doing the same. `pipeline.test.mjs` drives the whole thing end to end through
the real connectors with a stub `fetch`.
