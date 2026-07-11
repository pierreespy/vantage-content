// Vantage — morning push sender (send path for the 07:30 notification).
//
// Reads every registered Expo push token from Firestore and sends ONE notification
// carrying the day's `pushTeaser` (title + body) about the lead story. This is the
// deterministic counterpart to union.mjs: pure functions + dependency-injected
// Firestore handle, plus a CLI block. Nothing here ships in the app bundle.
//
// Runs server-side with the Admin SDK (service account), which bypasses the
// Firestore rules — that is why clients are denied all reads on `pushTokens`.
//
// Expo Push API: https://docs.expo.dev/push-notifications/sending-notifications/
//   POST https://exp.host/--/api/v2/push/send  with up to 100 messages/request.
// Tokens that come back "DeviceNotRegistered" are pruned so the list self-cleans.

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK = 100;

/**
 * Read all registered push tokens.
 * @param {import('firebase-admin/firestore').Firestore} db
 * @returns {Promise<{uid: string, token: string}[]>}
 */
export async function readPushTokens(db) {
  const snap = await db.collection('pushTokens').get();
  const out = [];
  for (const doc of snap.docs) {
    const token = doc.get('token');
    if (typeof token === 'string' && token.startsWith('ExponentPushToken')) {
      out.push({ uid: doc.id, token });
    }
  }
  return out;
}

/**
 * Build one Expo message per token from the edition's teaser.
 * @param {{uid: string, token: string}[]} tokens
 * @param {{title: string, body: string}} teaser
 */
export function buildMessages(tokens, teaser) {
  return tokens.map(({ token }) => ({
    to: token,
    title: teaser.title,
    body: teaser.body,
    sound: 'default',
    priority: 'high',
  }));
}

/**
 * Send messages in chunks of 100. Returns the flat list of Expo tickets, aligned
 * 1:1 (and in order) with `messages`.
 * @param {object[]} messages
 * @param {typeof fetch} [fetchImpl]
 */
export async function sendExpoPush(messages, fetchImpl = fetch) {
  const tickets = [];
  for (let i = 0; i < messages.length; i += CHUNK) {
    const chunk = messages.slice(i, i + CHUNK);
    const res = await fetchImpl(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(chunk),
    });
    const json = await res.json().catch(() => ({}));
    if (Array.isArray(json?.data)) tickets.push(...json.data);
    else for (let k = 0; k < chunk.length; k++) tickets.push({ status: 'error' });
  }
  return tickets;
}

/**
 * Given tickets aligned with `tokens`, return the tokens Expo says are dead
 * (DeviceNotRegistered) — the app was uninstalled or notifications revoked.
 * @param {{uid: string, token: string}[]} tokens
 * @param {object[]} tickets
 */
export function deadTokens(tokens, tickets) {
  const dead = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tickets[i];
    if (t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered') {
      dead.push(tokens[i]);
    }
  }
  return dead;
}

/** Delete the given tokens' docs (best-effort, batched). */
export async function pruneTokens(db, tokens) {
  let deleted = 0;
  for (let i = 0; i < tokens.length; i += 400) {
    const batch = db.batch();
    for (const { uid } of tokens.slice(i, i + 400)) {
      batch.delete(db.collection('pushTokens').doc(uid));
    }
    await batch.commit();
    deleted += Math.min(400, tokens.length - i);
  }
  return deleted;
}

// CLI: send the teaser from a published edition to all registered tokens.
//   FIREBASE_SERVICE_ACCOUNT=... node backend/push.mjs ./edition.json
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFile } = await import('node:fs/promises');
  const editionPath = process.argv[2] ?? './edition.json';

  const edition = JSON.parse(await readFile(editionPath, 'utf8'));
  const teaser = edition?.pushTeaser;
  if (!teaser?.title || !teaser?.body) {
    console.error('no pushTeaser in edition — nothing to send.');
    process.exit(0);
  }

  const { initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  initializeApp({ credential: raw ? cert(JSON.parse(raw)) : applicationDefault() });
  const db = getFirestore();

  const tokens = await readPushTokens(db);
  console.error(`push: ${tokens.length} registered token(s).`);
  if (tokens.length === 0) process.exit(0);

  const tickets = await sendExpoPush(buildMessages(tokens, teaser));
  const ok = tickets.filter((t) => t?.status === 'ok').length;
  console.error(`push: ${ok}/${tickets.length} accepted by Expo.`);

  const dead = deadTokens(tokens, tickets);
  if (dead.length) {
    const n = await pruneTokens(db, dead);
    console.error(`push: pruned ${n} dead token(s).`);
  }
}
