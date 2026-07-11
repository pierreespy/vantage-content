// Vantage — CCR (Claude Code Remote) deterministic merge step.
//
// Mode B, no API key AND no GitHub token: the scheduled Claude Code session
// publishes through its own GitHub connection, so this script does NOT clone,
// commit, or push. It is a PURE, deterministic merge:
//
//   inputs  (argv):
//     1. candidates.json   NEW items the session found via native web search:
//                          { "<Startup>": [ {title,source,url,publishedAt,date}, ... ] }
//     2. current.json      the CURRENTLY published startup-news.json, fetched by
//                          the session (via the GitHub get_file_contents tool):
//                          { "generatedAt": "...", "news": { "<Startup>": NewsItem[] } }
//     3. output.json       where to write the merged startup-news.json
//
//   for every startup in (existing ∪ candidates):
//     mergeStartupNews(existing, incoming, { now, windowDays:30, maxPerStartup:3 })
//   drop startups that end up empty (no empty arrays); set generatedAt = today.
//
// The session then publishes output.json to pierreespy/vantage-content with the
// GitHub create_or_update_file tool (using the blob SHA it read alongside the
// current content). No env secrets are needed by THIS script.
//
// Usage:
//   node ccr-merge.mjs <candidates.json> <current.json> <output.json>

import { readFile, writeFile } from 'node:fs/promises';

import { mergeStartupNews } from './merge.mjs';

/** Read + parse a JSON file, with a clear error if it's missing/invalid. */
async function readJson(path, label) {
  if (!path) throw new Error(`usage: node ccr-merge.mjs <candidates.json> <current.json> <output.json> (missing ${label})`);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`could not read/parse ${label} "${path}": ${err.message}`);
  }
}

async function main() {
  const [candidatesPath, currentPath, outputPath] = process.argv.slice(2);
  if (!outputPath) {
    throw new Error('usage: node ccr-merge.mjs <candidates.json> <current.json> <output.json>');
  }

  const now = Date.now();
  const todayIso = new Date(now).toISOString().slice(0, 10);

  const candidates = await readJson(candidatesPath, 'candidates');
  if (!candidates || typeof candidates !== 'object' || Array.isArray(candidates)) {
    throw new Error('candidates JSON must be an object mapping startup name -> item[]');
  }

  const current = await readJson(currentPath, 'current');
  const news = current && typeof current.news === 'object' && !Array.isArray(current.news) ? current.news : {};

  // Merge over the union of startups present in EITHER the current file or the
  // candidates, so retention (30-day window / top-3) is re-applied to stored
  // startups even when the session found nothing new for them.
  const names = new Set([...Object.keys(news), ...Object.keys(candidates)]);

  const nextNews = {};
  for (const name of names) {
    const existing = Array.isArray(news[name]) ? news[name] : [];
    const incoming = Array.isArray(candidates[name]) ? candidates[name] : [];
    const merged = mergeStartupNews(existing, incoming, { now, windowDays: 30, maxPerStartup: 3 });
    console.error(`  ${name}: stored=${existing.length} new=${incoming.length} -> kept=${merged.length}`);
    // Absent from the map (no empty arrays) when nothing survives.
    if (merged.length) nextNews[name] = merged;
  }

  const output = { generatedAt: todayIso, news: nextNews };
  await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.error(`wrote merged startup-news.json -> ${outputPath} (generatedAt=${todayIso}, ${Object.keys(nextNews).length} startup(s))`);
}

main().catch((err) => {
  console.error('ccr-merge failed:', err);
  process.exit(1);
});
