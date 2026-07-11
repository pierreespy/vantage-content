# Vantage — favorites news routine

Maintains **`startup-news.json`** at the root of this repo (`vantage-content`). It is
the machinery behind the Favoris tab: the app filters this one shared, per-startup
file down to each user's on-device favorites.

> **This routine now lives in — and runs from — `vantage-content`** (moved out of the
> `vantage` app repo, so the app repo only changes for real software updates). In the
> default mode (**Mode B / Claude Code Remote**) the scheduled session is already inside
> this checkout, so it publishes `startup-news.json` with a **plain `git push`** — no
> GitHub token, no `create_or_update_file`. The playbook the session follows is
> [`CCR_ROUTINE.md`](./CCR_ROUTINE.md).

Authoritative data contract: `docs/perso-favoris.md` (in the `vantage` app repo).
This directory has its **own** `package.json` / `node_modules`; its deps
(`@anthropic-ai/sdk`, `firebase-admin`, `simple-git`) are server-only.

## How it works

There are **two modes** that share the same deterministic core (`../union.mjs` for
the union + purge, `merge.mjs` for retention) and produce the identical
`startup-news.json`:

- **Mode A — GitHub Actions + Anthropic API** (`run.mjs` + `research.mjs` +
  `.github/workflows/favoris-news.yml`). Fully automated cron; research runs through
  the paid Anthropic API. Documented immediately below.
- **Mode B — Claude Code Remote (no API key)** (`ccr-union.mjs` + `ccr-publish.mjs`
  + [`CCR_ROUTINE.md`](./CCR_ROUTINE.md)). A scheduled Claude Code session does the
  web research **natively**; the two Node scripts are just the deterministic
  bookends. See the section near the end.

### Mode A — `run.mjs` orchestrates, once per run:

1. **Union** — reads the deduped set of *actually followed* startups from Firestore
   via [`../union.mjs`](../union.mjs) (`readUnion(db, now)`), never the ~370-startup
   catalog. Expired follows (>30 days) are already excluded by that query.
2. **Checkout** — shallow-clones `vantage-content` with a token and reads the
   current `startup-news.json` (empty scaffold if absent).
3. **Research** — [`research.mjs`](./research.mjs): for each startup, Claude
   (`claude-opus-4-8`, adaptive thinking, `web_search_20260209`, structured output
   via `output_config.format`) returns **new, distinct** developments. The model is
   handed the startup's already-stored titles + urls so it (a) skips what we already
   have and (b) collapses many articles about the same event into one ("une affaire
   = un article"). Precise-names rule enforced (company, amount, lead investor).
4. **Merge (retention)** — [`merge.mjs`](./merge.mjs), a pure deterministic
   function: dedupe by url, drop items >30 days old (sliding window), keep the 3
   newest. This is the *only* place retention is enforced; the app has none.
5. **Publish** — writes `startup-news.json` with `generatedAt = today`, commits and
   pushes to `vantage-content`. Startups with no stored **and** no new items stay
   **absent** from the map (never an empty array).

### Dependency injection into `union.mjs`

`union.mjs` lives one directory up and has no `node_modules` of its own, so it does
**not** import `firebase-admin` at module scope. `run.mjs` builds the Firestore
`db` from *this* package's `firebase-admin` (using `FIREBASE_SERVICE_ACCOUNT`) and
passes it to `readUnion(db, now)`. The `node backend/union.mjs` CLI still works — it
imports `firebase-admin` lazily in its own entrypoint block.

## Secrets & variables to create

In the repo hosting this workflow: **Settings → Secrets and variables → Actions**.

| Kind | Name | Value |
|---|---|---|
| Secret | `ANTHROPIC_API_KEY` | Anthropic API key used for research. |
| Secret | `FIREBASE_SERVICE_ACCOUNT` | The **full JSON** of a Firebase service-account key (Project settings → Service accounts → Generate new private key). Paste the file contents verbatim. |
| Secret | `CONTENT_REPO_TOKEN` | A PAT (fine-grained, **Contents: read/write** on `vantage-content`) used to clone + push. |
| Variable | `CONTENT_REPO` | `owner/repo` of the content repo, e.g. `pierreespy/vantage-content`. |

Optional env (defaults in `run.mjs`): `CONTENT_NEWS_PATH` (default
`startup-news.json`), `CONTENT_BRANCH` (default `main`), `DRY_RUN=1` (write but do
not commit/push).

> The service-account JSON is a real secret — never commit it or bundle it in the
> app. The client `GoogleService-Info.plist` is *not* a secret and is unrelated to
> this job.

## Run locally

```bash
cd backend/routine
npm ci

# Unit test the deterministic retention merge:
npm test                 # -> node --test, 6 cases (top-3, 30-day window, url-dedup, empty…)

# Full dry run (needs the 4 secrets in your env; writes but does not push):
DRY_RUN=1 \
ANTHROPIC_API_KEY=... \
FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)" \
CONTENT_REPO=pierreespy/vantage-content \
CONTENT_REPO_TOKEN=... \
node run.mjs
```

## Mode B: Claude Code Remote routine (no API key)

Same output, no paid Anthropic API **and no GitHub PAT**. A scheduled **Claude Code
Remote** session (running **inside this `vantage-content` checkout**) does the research
with its **own native web search**, then publishes `startup-news.json` with a **plain
`git push`**; two deterministic Node scripts do the non-research work. The step-by-step
the session follows is [`CCR_ROUTINE.md`](./CCR_ROUTINE.md) — this is a summary.

**Research hard rule (30-day window):** the session must keep only articles whose
`publishedAt` is within the last 30 days of today and **discard anything older** —
the retention merge drops >30-day items anyway, so older articles are wasted effort.
This is stated as a hard per-startup rule in `CCR_ROUTINE.md`.

Pieces:

- **`ccr-union.mjs`** — inits `firebase-admin` from `FIREBASE_SERVICE_ACCOUNT`
  (a JSON **string**, `JSON.parse` + `cert(...)`), calls `readUnion(db, Date.now())`,
  and prints `{"startups":[...]}` to **stdout** (all logs to stderr, so the session
  can capture just the JSON). Also `purgeExpired(db, Date.now())`, best-effort.
- **`ccr-merge.mjs <candidates.json> <current.json> <output.json>`** — a **pure**
  deterministic merge (no git, no token, no network). Takes the NEW items the session
  found and the CURRENT published file (**already in the checkout** at the repo root:
  `../../startup-news.json` — no GitHub fetch), applies the SAME
  `mergeStartupNews(…, { windowDays:30, maxPerStartup:3 })` retention per startup
  over (existing ∪ candidates), drops empties, sets `generatedAt` to today, and
  **writes** the merged JSON to `<output.json>`. The **session** then moves it over
  `startup-news.json` and publishes with `git add` + `git commit` + `git push`.

How it differs from Mode A:

| | Mode A (`run.mjs`) | Mode B (CCR) |
|---|---|---|
| Research | `research.mjs` → Anthropic API (`claude-opus-4-8`, `web_search_20260209`) | Claude Code session's **native** web search |
| API key | `ANTHROPIC_API_KEY` required | **none** |
| Trigger | GitHub Actions cron | scheduled Claude Code session |
| Union read | inline in `run.mjs` | `ccr-union.mjs` (stdout JSON) |
| Merge | inline in `run.mjs` | `ccr-merge.mjs` (pure, writes local file) |
| Publish | `simple-git` clone + push with `CONTENT_REPO_TOKEN` | **plain `git push`** in-repo (session already in `vantage-content`), no token |
| Union + merge core | `../union.mjs` + `merge.mjs` | **same** `../union.mjs` + `merge.mjs` |

The **only** secret for Mode B is `FIREBASE_SERVICE_ACCOUNT` (union read + purge).
There is **no** `ANTHROPIC_API_KEY`, **no** `CONTENT_REPO_TOKEN`, and **no**
`CONTENT_REPO`: the session runs inside this repo and publishes with git.

```bash
cd backend/routine && npm ci
node ccr-union.mjs > union.json           # {"startups":[...]}
# current published file is already here: ../../startup-news.json (no fetch)
# ... session researches each startup natively -> candidates.json ...
node ccr-merge.mjs candidates.json ../../startup-news.json merged.json   # pure merge (retention)
mv merged.json ../../startup-news.json
cd ../.. && git add startup-news.json && git commit -m "chore(news): refresh startup-news.json (<date>)" && git push
```

## Cadence caveat — "one morning in two"

The workflow cron is `0 6 */2 * *` (06:00 UTC). `*/2` on the **day-of-month** field
means days 1, 3, 5, … 31 — every other day *within* a month, but the step **resets
at each month boundary**. Consequences:

- A 31-day month runs on the 31st **and** the 1st (two mornings in a row).
- After a 30-day month, the 1st also follows the 29th.

This is harmless, but note the nuance: a **same-day** re-run is idempotent (identical
`generatedAt` + deterministic merge → clean tree → "nothing to commit"). A
**cross-date** back-to-back run (e.g. 31st then 1st) is **not** a no-op: `generatedAt`
is set to today's date, so it always differs from the previous day's file and the run
**always commits at least a `generatedAt` bump** (plus any new articles). That extra
commit is benign. If strict 48-hour spacing ever matters, switch to a **daily** cron
and skip odd days via an epoch-based check inside `run.mjs`.
