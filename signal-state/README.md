# `signal-state/` — the pipeline's memory

Written by `backend/signals/run.mjs`, committed on every run. **Do not edit by hand.**

This directory is what makes "Voie B" real (see `docs/signals-plan.md` in the
`vantage` repo): a weak signal is not *"this trial exists"*, it is *"this trial
**changed**"* — and telling those apart needs state. The project's architecture
decision is 0 € of infra and no database, so the state is JSON in git.

## Files

| File | Contents |
|---|---|
| `<source>.json` | per-source diffing state — one entry per record id |
| `entities.json` | resolved entities: who is who, across every source |

### `<source>.json`

```jsonc
{
  "updatedAt": "2026-08-09",
  "records": {
    "clinicaltrials:NCT06123456": {
      "fp": "RECRUITING|2026-08-05",  // fingerprint: what "changed" means here
      "firstSeen": "2026-07-21",       // the day WE first saw it
      "lastSeen": "2026-08-09"         // the last run that saw it
    }
  }
}
```

Only the **fingerprint** is stored, never the payload — the file has to stay
small and readable in a diff, since every run commits it. A record re-emits as a
signal when it is new, or when its fingerprint moves. Ids unseen for 400 days are
forgotten.

### `entities.json`

The cross-source memory of **who is who**: a researcher's PubMed author name, EPO
inventor name and Pappers director name resolved into one entity, with the record
references attached.

This file is why the pipeline can find the high-priority pattern at all. A single
run looks back 30 days for publications and trials — it can never see a March
publication, a May patent and a July incorporation together. Only accumulated
entity state can.

Keys are sorted and records are capped per entity, so day-to-day diffs stay
small and reviewable.

## Resetting

Deleting a file here is safe but noisy: the next run re-emits everything it finds
as "new". Deleting `entities.json` additionally loses the accumulated history that
the high-priority rule depends on, and it will take months of runs to rebuild.
