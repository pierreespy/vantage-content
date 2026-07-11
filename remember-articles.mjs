#!/usr/bin/env node
/**
 * remember-articles.mjs — met à jour `recent-articles.json`, la mémoire des articles
 * déjà publiés dans l'édition, pour que la génération ne republie pas les mêmes d'un
 * jour à l'autre. Fenêtre glissante de 14 jours.
 *
 * Usage :
 *   node remember-articles.mjs [edition.json] [recent-articles.json]
 *   (défauts : edition.json + recent-articles.json à la racine du dépôt)
 *
 * Extrait les articles porteurs d'URL (la une, le deal du jour, les brèves Europe +
 * International), les ajoute EN TÊTE avec la date du jour, dédoublonne par URL, puis
 * élague tout ce qui a plus de 14 jours. Déterministe, sans dépendances.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const WINDOW_DAYS = 14;
const editionPath = process.argv[2] || 'edition.json';
const memoryPath = process.argv[3] || 'recent-articles.json';

const today = new Date().toISOString().slice(0, 10); // AAAA-MM-JJ (UTC)

const edition = JSON.parse(readFileSync(editionPath, 'utf8'));

/** Articles du jour (uniquement ceux qui portent une URL — clé de dédup). */
const fresh = [];
const add = (company, title, url) => {
  if (typeof url === 'string' && url.trim()) {
    fresh.push({ date: today, company: company || '', title: title || '', url: url.trim() });
  }
};
if (edition.lead) add(edition.lead.company, edition.lead.title, edition.lead.url);
if (edition.deal)
  add(edition.deal.company, edition.deal.round ? `${edition.deal.company} · ${edition.deal.round}` : edition.deal.company, edition.deal.url);
for (const b of edition.brefsEurope ?? []) add(b.company, b.title, b.url);
for (const b of edition.brefsIntl ?? []) add(b.company, b.title, b.url);

/** Mémoire existante. */
let previous = [];
if (existsSync(memoryPath)) {
  try {
    const parsed = JSON.parse(readFileSync(memoryPath, 'utf8'));
    if (parsed && Array.isArray(parsed.articles)) previous = parsed.articles;
  } catch {
    // repart d'une mémoire vide si le fichier est illisible
  }
}

// Dédup par URL : retire d'abord les anciennes entrées ayant une URL republiée
// aujourd'hui, puis préfixe celles du jour.
const freshUrls = new Set(fresh.map((e) => e.url));
const kept = previous.filter((a) => a && typeof a.url === 'string' && !freshUrls.has(a.url));
let all = [...fresh, ...kept];

// Fenêtre 14 jours : garde aujourd'hui + les 13 jours précédents (comparaison
// lexicale d'ISO AAAA-MM-JJ, valide pour l'ordre chronologique).
const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
all = all.filter((a) => typeof a.date === 'string' && a.date >= cutoff);

const out = {
  _comment:
    'Mémoire des articles publiés dans l’édition (une, deal, brèves) sur ~14 jours. La tâche du matin la LIT pour ne pas republier les mêmes ; remember-articles.mjs la MET À JOUR après chaque édition (ajout du jour + élagage > 14 j). Voir GENERATION.md.',
  articles: all,
};
writeFileSync(memoryPath, JSON.stringify(out, null, 2) + '\n');
console.log(
  `recent-articles.json : +${fresh.length} du jour, ${all.length} au total (fenêtre ${WINDOW_DAYS} j, coupure ${cutoff}).`
);
