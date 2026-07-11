// Vantage — CCR (Claude Code Remote) morning push sender.
//
// The 07:30 job: send ONE notification carrying the day's `pushTeaser` (about the
// lead story) to every registered device. Fully deterministic — no web research,
// no Anthropic key. Reuses ../push.mjs with dependency injection, mirroring
// ccr-union.mjs (Firestore built here from FIREBASE_SERVICE_ACCOUNT and passed in),
// so firebase-admin resolves from this folder's own node_modules.
//
// Reads the already-published edition at the repo root (../../edition.json): if it
// has no pushTeaser, there is nothing to send and we exit cleanly.
//
// Env:
//   FIREBASE_SERVICE_ACCOUNT   service-account key as a JSON STRING (not a path)

import { readFile } from 'node:fs/promises';
import {
  readPushTokens,
  buildMessages,
  sendExpoPush,
  deadTokens,
  pruneTokens,
} from '../push.mjs';

const EDITION_PATH = new URL('../../edition.json', import.meta.url);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

async function initFirestore() {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const serviceAccount = JSON.parse(requireEnv('FIREBASE_SERVICE_ACCOUNT'));
  initializeApp({ credential: cert(serviceAccount) });
  return getFirestore();
}

async function main() {
  const edition = JSON.parse(await readFile(EDITION_PATH, 'utf8'));
  const teaser = edition?.pushTeaser;
  if (!teaser?.title || !teaser?.body) {
    console.error('no pushTeaser in edition.json — nothing to send. Exiting.');
    return;
  }
  console.error(`push teaser: ${teaser.title} — ${teaser.body}`);

  const db = await initFirestore();
  const tokens = await readPushTokens(db);
  console.error(`push: ${tokens.length} registered token(s).`);
  if (tokens.length === 0) return;

  const tickets = await sendExpoPush(buildMessages(tokens, teaser));
  const ok = tickets.filter((t) => t?.status === 'ok').length;
  console.error(`push: ${ok}/${tickets.length} accepted by Expo.`);

  const dead = deadTokens(tokens, tickets);
  if (dead.length) {
    const n = await pruneTokens(db, dead);
    console.error(`push: pruned ${n} dead token(s).`);
  }
}

main().catch((err) => {
  console.error('ccr-push failed:', err);
  process.exit(1);
});
