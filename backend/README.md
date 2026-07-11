# Vantage — anonymous favorites backend

The only server surface in an otherwise 100%-on-device app. It exists for **one**
reason: so the morning generation knows **which startups are actually followed**
(the union) and researches just those, never the ~370-startup catalog.

Authoritative contract: [`docs/perso-favoris.md`](../docs/perso-favoris.md).
Privacy policy: [`docs/privacy-policy.md`](../docs/privacy-policy.md).

Platform: **Firebase (Cloud Firestore)** + **Firebase Anonymous Auth** + **App Check**.

---

## Data model

Collection **`follows`**, one document per client:

| | |
|---|---|
| **Document id** | the client's **Firebase Anonymous Auth uid** (a random, per-install id) |
| `startups` | `string[]`, length **≤ 6**, exact startup names from the app catalog |
| `updatedAt` | `serverTimestamp()` — the server clock, not a client-supplied time |

```jsonc
// follows/8f3a... (id == anonymous uid)
{
  "startups": ["Owkin", "Abivax"],
  "updatedAt": <Firestore server Timestamp>
}
```

### Why doc-id == uid
The security rules pin every write to `docId == request.auth.uid`. Because the
document id **is** the caller's uid, a client can physically only write **its own**
document — there is no "write any doc" hole, no need to trust a client-sent id, and
no way to overwrite or read someone else's row. One install = one document, and
re-reporting is an idempotent overwrite of that same doc.

### Why `anonId` is not a stored field
The wire contract in `docs/perso-favoris.md` lists `anonId`, but on Firebase the
`anonId` **is** the document id (the anonymous uid). Storing it again would be
redundant PII surface, so the rules **reject** any doc that carries extra keys —
only `startups` and `updatedAt` are allowed. The client sets the doc id from its
uid; it does not put `anonId` inside the document body.

### Why anonymous auth + App Check (and not accounts)
- **No accounts / no Sign in with Apple / no email**: identity is a Firebase
  *anonymous* uid, minted on device, never linked to Apple ID, IDFA or IDFV, never
  shared across apps. Nothing to log into, nothing to leak.
- **Anonymous Auth** gives each install a stable, unguessable uid so the rules can
  scope writes to the owner — cheap identity with zero PII.
- **App Check** (DeviceCheck / App Attest on iOS) means only genuine builds of the
  real app can obtain a token, so the write path is **not openly spammable** even
  though it is unauthenticated in the human sense. Auth answers *whose doc*; App
  Check answers *is this really our app*.
- **No PII**: the entire payload is an opaque id + up to 6 startup names drawn from
  the app's own catalog. No contact info, no location, no analytics.

---

## Security rules

See [`firestore.rules`](./firestore.rules). Summary of what they enforce:

- **Deny by default** — `match /{document=**} { allow read, write: if false; }`.
- **Client reads: denied.** The union is read only by the generation job via the
  Admin SDK (service account), which bypasses rules. No client ever reads `follows`.
- **Client deletes: denied.** Cleanup is server-side (expiry / purge job).
- **Create/update: allowed only if** `request.auth != null` **and**
  `docId == request.auth.uid` **and** the payload is well-formed:
  - keys are exactly `{ startups, updatedAt }` (no extra fields / no PII smuggling),
  - `startups` is a `list` of `string`, `size() <= 6`,
  - `updatedAt == request.time` (must be a server timestamp, so the 30-day expiry
    can be trusted).

> **Reviewed for the "anyone can write any doc" hole:** the only non-`false` rule is
> `create, update` under `/follows/{uid}`, and it is gated by `docId == request.auth.uid`.
> A caller cannot target an arbitrary `{uid}` because the rule compares it to their
> own token. Everything else resolves to `false`. Enable App Check enforcement
> (below) to also block non-app callers.

### App Check enforcement
After the app ships an App-Check-enabled build, turn on **enforcement** for
Cloud Firestore in the Firebase console (App Check → Firestore → Enforce). Until
then it can run in monitoring mode so real users are never locked out during rollout.

---

## Read path — the union (watchlist)

Query, in words: *all `follows` docs where `updatedAt >= now − 30 days`, take the
union of their `startups`, dedupe.* Startups unseen for 30 days fall out of the
window and stop being researched (retention + erasure-by-expiry).

Reference implementation: [`union.mjs`](./union.mjs) (`firebase-admin`).

```bash
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node backend/union.mjs > watchlist.json
# -> { "generatedAt": "...", "watchlist": ["Abivax", "Owkin", ...] }
```

`union.mjs` also exports `purgeExpired()` — an optional cron that physically
deletes docs older than 30 days so nothing lingers on disk past the retention
window (the union already ignores them; the purge makes the deletion real).

The single-field auto-index on `updatedAt` is enough for the `where('updatedAt', …)`
range query; no composite index needed.

---

## App Store privacy-nutrition-label answers

Give these exact answers in App Store Connect → App Privacy:

- **Data collected: Product interaction** (or **User content**, "Other user content")
  — the list of startup names a user follows.
  - Linked to the user's identity? **No — Not Linked to Identity.**
  - Used for tracking? **No — Not Used for Tracking.**
  - Purpose: **App Functionality** only.
- **Identifiers:** the anonymous uid is an app-scoped, self-generated id used only to
  scope a user's own document. It is **not** a device/advertising identifier. Declare
  it, if at all, as **not linked to identity / not used for tracking**; it is never
  the IDFA/IDFV and never leaves this app.
- **No** other categories: no contact info, no location, no financial info, no
  browsing history, no diagnostics tied to identity.

Consequences of "not used for tracking":
- **No ATT prompt** (`AppTrackingTransparency`) is required — there is no cross-app
  or cross-site tracking and no advertising identifier.
- **No account-deletion screen** is required — there are **no accounts** (Apple's
  account-deletion rule applies only to apps that let you create an account). Erasure
  is covered by the in-app reset + the automatic 30-day expiry (see privacy policy).

---

## Provisioning (free tier)

1. **Create a Firebase project** at <https://console.firebase.google.com>. The
   **Spark (free) plan** is sufficient at this scale — Firestore's free quota
   (~50k reads, 20k writes, 1 GiB/day) dwarfs one small write per install per change
   plus one union read each morning. **No card / no billing** needed for Spark.
2. **Enable Cloud Firestore** (production mode) and deploy the rules:
   ```bash
   firebase deploy --only firestore:rules   # uses backend/firestore.rules
   ```
   (point `firestore.rules` in `firebase.json` at `backend/firestore.rules`).
3. **Enable Authentication → Sign-in method → Anonymous.**
4. **Enable App Check** with the **App Attest / DeviceCheck** provider for the iOS
   app; start in monitoring, switch to **Enforce** once the app build ships.
5. **App config:** in the Firebase console, add an iOS app and download
   `GoogleService-Info.plist` (the client config — safe to ship; it is not a secret).
   The app initializes Firebase, calls `signInAnonymously()`, then writes
   `follows/<uid>` with `setDoc({ startups, updatedAt: serverTimestamp() })` whenever
   the followed set changes (debounced). All of that is the `vantage-app` stream.
6. **Generation credentials:** in **Project settings → Service accounts**, generate a
   private key JSON for the Admin SDK. Keep it **off-device and out of git**; the
   morning job points `GOOGLE_APPLICATION_CREDENTIALS` at it to run `union.mjs`.

> The client `GoogleService-Info.plist` / config keys are **not** secrets (they only
> identify the project; the rules + App Check are what protect data). The **service
> account key is** a secret — never bundle it in the app or commit it.
