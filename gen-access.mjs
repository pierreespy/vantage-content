#!/usr/bin/env node
/**
 * Génère `access.json` — le code d'accès quotidien qui débloque le palier étendu
 * des Favoris (voir GENERATION.md, « Le code d'accès quotidien »).
 *
 * Usage :
 *   node gen-access.mjs "<passphrase-du-jour>"
 *
 * Écrit `access.json` avec UNIQUEMENT le hash salé — JAMAIS le code en clair.
 * (access.json est servi publiquement via GitHub Pages : le clair n'y va jamais.)
 * Affiche le code en clair sur stdout pour que la session le transmette à Pierre.
 *
 * La canonicalisation ci-dessous DOIT rester identique à `canonicalCode()` dans
 * l'app (src/content/accessTypes.ts), sinon un code correct ne validera pas.
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const code = (process.argv[2] ?? '').trim();
if (!code) {
  console.error('Usage : node gen-access.mjs "<passphrase-du-jour>"');
  process.exit(1);
}
if (code.length > 80) {
  console.error('Passphrase trop longue (max 80 caractères).');
  process.exit(1);
}

// Canonicalisation IDENTIQUE à l'app (src/content/accessTypes.ts) :
const canonical = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

const salt = randomBytes(9).toString('hex');
const hash = createHash('sha256').update(salt + ':' + canonical(code)).digest('hex');
const date = new Date().toISOString().slice(0, 10); // AAAA-MM-JJ (UTC)

const manifest = {
  date,
  algo: 'sha256',
  salt,
  hash,
  hint: 'Code du jour — demandez-le à Pierre (LinkedIn). Il change chaque matin.',
};

writeFileSync('access.json', JSON.stringify(manifest, null, 2) + '\n');

console.log('');
console.log('access.json écrit pour le ' + date + ' (hash salé uniquement).');
console.log('────────────────────────────────────────────────────────────');
console.log('CODE DU JOUR (en clair) : ' + code);
console.log('→ À transmettre à Pierre. NE PAS committer, NE PAS mettre dans un fichier.');
console.log('────────────────────────────────────────────────────────────');
