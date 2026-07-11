// Vantage — CCR (Claude Code Remote) union reader.
//
// Mode B entrypoint: prints the followed-startup union to STDOUT as JSON so a
// scheduled Claude Code session can capture it and do the web research natively
// (no paid Anthropic API key needed). Deterministic bookend #1.
//
// Contract:
//   stdout: exactly one line of JSON -> {"startups":["Abivax","Owkin",...]}
//   stderr: all human logs (so stdout stays machine-parseable)
//
// Reuses ../union.mjs (readUnion / purgeExpired) with dependency injection: we
// build the Firestore handle here from FIREBASE_SERVICE_ACCOUNT and pass it in.
//
// Env:
//   FIREBASE_SERVICE_ACCOUNT   service-account key as a JSON STRING (not a path)

import { readUnion, purgeExpired } from '../union.mjs';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

/** Build a Firestore handle from the service-account JSON string. */
async function initFirestore() {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const serviceAccount = JSON.parse(requireEnv('FIREBASE_SERVICE_ACCOUNT'));
  initializeApp({ credential: cert(serviceAccount) });
  return getFirestore();
}

async function main() {
  const now = Date.now();
  const db = await initFirestore();

  const startups = await readUnion(db, now);
  console.error(`union: ${startups.length} followed startup(s): ${startups.join(', ') || '(none)'}`);

  // Best-effort hard erasure of expired follow docs — a failure must not prevent
  // us from emitting the union the session needs.
  try {
    const purged = await purgeExpired(db, now);
    console.error(`purge: deleted ${purged} expired follow doc(s).`);
  } catch (err) {
    console.error(`purge failed (continuing): ${err.message}`);
  }

  // ONLY the JSON goes to stdout.
  process.stdout.write(JSON.stringify({ startups }) + '\n');
}

main().catch((err) => {
  console.error('ccr-union failed:', err);
  process.exit(1);
});
