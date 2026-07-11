#!/usr/bin/env node
/**
 * remember-word.mjs — met à jour `words.json`, le GLOSSAIRE : chaque « mot du jour »
 * passé avec son explication complète (contrairement à recent-words.json, qui ne garde
 * que term/full/date sur 30 jours pour éviter les répétitions).
 *
 * Usage :
 *   node remember-word.mjs [edition.json] [words.json]
 *   (défauts : edition.json + words.json à la racine du dépôt)
 *
 * Prend le `word` complet de l'édition du jour, l'ajoute EN TÊTE avec sa date, et
 * dédoublonne par terme (insensible à la casse/aux accents) — le plus récent gagne.
 * Aucune fenêtre de rétention : le glossaire grossit indéfiniment. Déterministe, sans
 * dépendances. L'app le télécharge (config.wordsUrl) et l'affiche dans l'écran Glossaire.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const editionPath = process.argv[2] || 'edition.json';
const glossaryPath = process.argv[3] || 'words.json';

const today = new Date().toISOString().slice(0, 10); // AAAA-MM-JJ (UTC)

const edition = JSON.parse(readFileSync(editionPath, 'utf8'));
const word = edition.word;
if (!word || typeof word.term !== 'string') {
  console.error('remember-word: edition.json sans word.term valide — rien à faire.');
  process.exit(1);
}

/** Terme normalisé (minuscule, sans accents) — clé de dédup. */
const fold = (s) =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const entry = { ...word, date: today, dateLong: edition.dateLong || '' };

/** Glossaire existant. */
let previous = [];
if (existsSync(glossaryPath)) {
  try {
    const parsed = JSON.parse(readFileSync(glossaryPath, 'utf8'));
    if (parsed && Array.isArray(parsed.words)) previous = parsed.words;
  } catch {
    // repart d'un glossaire vide si le fichier est illisible
  }
}

// Dédup par terme : retire l'ancienne entrée du même terme, puis préfixe celle du jour.
const key = fold(entry.term);
const kept = previous.filter((w) => w && typeof w.term === 'string' && fold(w.term) !== key);
const words = [entry, ...kept];

const out = { generatedAt: today, words };
writeFileSync(glossaryPath, JSON.stringify(out, null, 2) + '\n');
console.log(`words.json : « ${entry.term} » ajouté ; ${words.length} terme(s) au glossaire.`);
