#!/usr/bin/env node
/**
 * check-en.mjs — vérifie que la version anglaise d'un fichier est le MIROIR exact de la
 * version française : mêmes clés, mêmes longueurs de tableaux, et champs factuels
 * identiques (url, company, name, amount, stage, pillar, signalType, strength, kind, term,
 * n). Seuls les textes changent. Sort en code 1 au premier écart.
 *
 * Usage : node check-en.mjs [edition.json] [edition.en.json]
 */
import { readFileSync } from 'node:fs';

const frPath = process.argv[2] || 'edition.json';
const enPath = process.argv[3] || frPath.replace(/\.json$/, '.en.json');
const SAME = new Set(['url', 'company', 'name', 'stage', 'pillar', 'signalType', 'strength', 'kind', 'term', 'n', 'ai']);

const fr = JSON.parse(readFileSync(frPath, 'utf8'));
const en = JSON.parse(readFileSync(enPath, 'utf8'));
const errors = [];

function walk(a, b, path) {
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return errors.push(`${path}: tableau de longueur différente`);
    a.forEach((x, i) => walk(x, b[i], `${path}[${i}]`));
  } else if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object') return errors.push(`${path}: objet manquant`);
    const ka = Object.keys(a).sort().join(','), kb = Object.keys(b).sort().join(',');
    if (ka !== kb) errors.push(`${path}: clés différentes (fr: ${ka} / en: ${kb})`);
    for (const k of Object.keys(a)) {
      if (SAME.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k])) errors.push(`${path}.${k}: doit être identique`);
      else walk(a[k], b[k], `${path}.${k}`);
    }
  } else if (typeof a !== typeof b) {
    errors.push(`${path}: type différent`);
  }
}

walk(fr, en, '$');
if (errors.length) {
  console.error(`check-en: ${enPath} ne correspond pas à ${frPath} :\n  - ${errors.join('\n  - ')}`);
  process.exit(1);
}
console.log(`check-en: ${enPath} OK (miroir de ${frPath}).`);
