// Vantage — union read path for the morning generation.
//
// Returns the deduped union of followed startup names across every `follows`
// document whose `updatedAt` is within the last 30 days. This IS the watchlist
// `vantage-content` researches: never the ~370-startup catalog, only what people
// actually follow. Startups unseen for 30 days silently drop out (retention +
// right-to-erasure by expiry).
//
// This runs server-side with the Admin SDK (a service account), which bypasses
// the Firestore security rules — that is why clients are denied all reads in
// firestore.rules. Nothing here is ever shipped in the app bundle.
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node backend/union.mjs
//   node backend/union.mjs > watchlist.json
//
// Auth options (pick one):
//   - GOOGLE_APPLICATION_CREDENTIALS pointing at a service-account key file, or
//   - run inside a Google environment (Cloud Functions / Cloud Run) where the
//     default credentials are already the project's service account.
//
// firebase-admin is NOT imported at module scope. `readUnion` / `purgeExpired`
// take an already-constructed Firestore `db` (dependency injection), so importers
// that live in a different package (e.g. backend/routine, with its own isolated
// node_modules) can supply the handle without this file needing to resolve
// firebase-admin from its own directory. The CLI block below builds a `db`
// lazily, so `node backend/union.mjs` still works exactly as before.

const RETENTION_DAYS = 30;

/**
 * @param {import('firebase-admin/firestore').Firestore} db an initialized Firestore handle.
 * @param {number} [now] epoch ms; defaults to Date.now().
 * @returns {Promise<string[]>} sorted, deduped startup names seen in the last 30 days.
 */
export async function readUnion(db, now = Date.now()) {
  // A JS Date is auto-converted to a Firestore Timestamp by the Admin SDK, so we
  // don't need to import Timestamp here.
  const cutoff = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Server-side filter on updatedAt so expired docs never enter the union.
  // (Also lets Firestore skip them; a single-field index on updatedAt suffices.)
  const snap = await db
    .collection('follows')
    .where('updatedAt', '>=', cutoff)
    .get();

  const union = new Set();
  for (const doc of snap.docs) {
    const startups = doc.get('startups');
    if (!Array.isArray(startups)) continue;
    for (const name of startups) {
      if (typeof name === 'string' && name.trim()) union.add(name);
    }
  }

  return [...union].sort((a, b) => a.localeCompare(b, 'fr'));
}

// Optional hard erasure: physically delete docs older than the retention window
// so the store never keeps data past 30 days (the union already ignores them;
// this makes the deletion real on disk). Run occasionally, e.g. from a cron.
export async function purgeExpired(db, now = Date.now()) {
  const cutoff = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const snap = await db.collection('follows').where('updatedAt', '<', cutoff).get();
  let deleted = 0;
  const batchSize = 400;
  for (let i = 0; i < snap.docs.length; i += batchSize) {
    const batch = db.batch();
    for (const doc of snap.docs.slice(i, i + batchSize)) batch.delete(doc.ref);
    await batch.commit();
    deleted += Math.min(batchSize, snap.docs.length - i);
  }
  return deleted;
}

// CLI entrypoint: print the watchlist as JSON on stdout. firebase-admin is
// imported here (lazily) rather than at module scope, so importing this file for
// its pure exports never forces a firebase-admin resolution.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { initializeApp, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: applicationDefault() });
  const db = getFirestore();
  readUnion(db)
    .then((names) => {
      process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), watchlist: names }, null, 2) + '\n');
    })
    .catch((err) => {
      console.error('union read failed:', err);
      process.exit(1);
    });
}
