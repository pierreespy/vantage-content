// Vantage — favorites news routine orchestrator (runs on a cron, every other day).
//
// Pipeline (see docs/perso-favoris.md §"La routine de mise à jour"):
//   1. read the Firestore union of followed startups (backend/union.mjs);
//   2. clone the vantage-content repo and read the current startup-news.json;
//   3. for each followed startup: research NEW items -> merge with retention;
//   4. set generatedAt = today, write startup-news.json;
//   5. commit + push to vantage-content (the app picks it up on next fetch).
//
// A startup ends up ABSENT from the `news` map (never an empty array) when it has
// neither stored nor new in-window items — per the data contract.
//
// This file lives in backend/routine, which has its OWN package.json (firebase-admin,
// @anthropic-ai/sdk, simple-git). It imports ../union.mjs, which is dependency-
// injected: we build the Firestore `db` here (from THIS package's firebase-admin)
// and pass it in, so union.mjs never has to resolve firebase-admin from its own dir.
//
// Env:
//   ANTHROPIC_API_KEY          research (Anthropic SDK)
//   FIREBASE_SERVICE_ACCOUNT   service-account JSON (string) for the union read
//   CONTENT_REPO               "owner/repo", e.g. pierreespy/vantage-content
//   CONTENT_REPO_TOKEN         PAT with push access to CONTENT_REPO
//   CONTENT_NEWS_PATH          path of the news file in the repo (default startup-news.json)
//   CONTENT_BRANCH             branch to push (default main)
//   DRY_RUN                    "1" to skip the git push (local testing)

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';

import { readUnion, purgeExpired } from '../union.mjs';
import { mergeStartupNews } from './merge.mjs';
import { researchStartup, makeClient } from './research.mjs';

const NEWS_PATH = process.env.CONTENT_NEWS_PATH || 'startup-news.json';
const BRANCH = process.env.CONTENT_BRANCH || 'main';
const DRY_RUN = process.env.DRY_RUN === '1';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

/** Build a Firestore handle from the service-account JSON in FIREBASE_SERVICE_ACCOUNT. */
async function initFirestore() {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const serviceAccount = JSON.parse(requireEnv('FIREBASE_SERVICE_ACCOUNT'));
  initializeApp({ credential: cert(serviceAccount) });
  return getFirestore();
}

/** Clone vantage-content into a temp dir and return { git, dir, filePath, data }. */
async function checkoutContent() {
  const repo = requireEnv('CONTENT_REPO'); // owner/repo
  const token = requireEnv('CONTENT_REPO_TOKEN');
  const url = `https://x-access-token:${token}@github.com/${repo}.git`;

  const dir = await mkdtemp(join(tmpdir(), 'vantage-content-'));
  const git = simpleGit();
  await git.clone(url, dir, ['--depth', '1', '--branch', BRANCH]);
  const repoGit = simpleGit(dir);
  await repoGit.addConfig('user.name', 'vantage-news-bot');
  await repoGit.addConfig('user.email', 'bot@vantage.local');

  const filePath = join(dir, NEWS_PATH);
  let data = { generatedAt: '', news: {} };
  if (existsSync(filePath)) {
    try {
      data = JSON.parse(await readFile(filePath, 'utf8'));
      if (!data.news || typeof data.news !== 'object') data.news = {};
    } catch {
      data = { generatedAt: '', news: {} };
    }
  }
  return { git: repoGit, dir, filePath, data };
}

async function main() {
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);

  const db = await initFirestore();
  const watchlist = await readUnion(db, now.getTime());
  console.log(`union: ${watchlist.length} followed startup(s): ${watchlist.join(', ') || '(none)'}`);

  // Make the "expiration 30 j = effacement" claim real: physically delete follow
  // docs older than the retention window (the union already ignores them; this
  // erases them on disk). Best-effort — a purge failure must never abort the run.
  // Skipped under DRY_RUN so local test runs never mutate Firestore.
  if (!DRY_RUN) {
    try {
      const purged = await purgeExpired(db, now.getTime());
      console.log(`purge: deleted ${purged} expired follow doc(s).`);
    } catch (err) {
      console.error(`purge failed (continuing): ${err.message}`);
    }
  } else {
    console.log('DRY_RUN=1 — skipping expired-follow purge.');
  }

  const { git, filePath, data } = await checkoutContent();
  const client = makeClient();

  const nextNews = {};
  for (const name of watchlist) {
    const stored = Array.isArray(data.news[name]) ? data.news[name] : [];
    let fresh = [];
    try {
      fresh = await researchStartup(client, name, stored, { now });
    } catch (err) {
      // Never let one startup sink the whole run: keep what we already stored,
      // still trimmed to the retention window below.
      console.error(`research failed for "${name}": ${err.message}`);
    }
    const merged = mergeStartupNews(stored, fresh, { now });
    console.log(`  ${name}: stored=${stored.length} new=${fresh.length} -> kept=${merged.length}`);
    // Absent from the map (no empty arrays) when nothing survives.
    if (merged.length) nextNews[name] = merged;
  }

  const output = { generatedAt: todayIso, news: nextNews };
  await writeFile(filePath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  const status = await git.status();
  if (status.isClean()) {
    console.log('startup-news.json unchanged — nothing to commit.');
    return;
  }
  if (DRY_RUN) {
    console.log('DRY_RUN=1 — wrote file but skipping commit/push.');
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  await git.add(NEWS_PATH);
  await git.commit(`chore(news): refresh startup-news.json (${todayIso})`);
  await git.push('origin', BRANCH);
  console.log(`pushed startup-news.json to ${process.env.CONTENT_REPO}@${BRANCH}`);
}

main().catch((err) => {
  console.error('routine failed:', err);
  process.exit(1);
});
