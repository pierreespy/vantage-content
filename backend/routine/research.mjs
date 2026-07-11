// Vantage — per-startup web research for the favorites news routine.
//
// For ONE startup, ask Claude (with the web_search server tool) for genuinely
// NEW, DISTINCT recent developments that are not already represented in the
// items we currently store. The model is told the stored titles + urls so it can
// (a) skip anything already covered and (b) collapse many articles about the
// SAME affair into a single item ("une affaire = un article").
//
// Returns NewsItem-shaped objects: { title, source, url, publishedAt, date }.
// `publishedAt` comes from the model (ISO AAAA-MM-JJ); `date` (FR display label)
// is derived HERE, deterministically, so the model never has to format dates.
//
// SDK notes (see the claude-api skill, typescript/claude-api/tool-use.md):
//   - model claude-opus-4-8, thinking: { type: "adaptive" };
//   - web_search_20260209 is a SERVER tool: it runs on Anthropic's side, so there
//     is no local tool to execute — we only have to resume on `pause_turn`;
//   - structured output via output_config.format (raw json_schema, so we don't
//     pull in a zod dependency), parsed from the final text block.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-4-8';
const WINDOW_DAYS = 30;

/** Result JSON contract enforced by output_config.format. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: 'New, distinct developments not already stored. May be empty.',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description:
              'Precise FR headline with concrete names: company, amount, lead investor / partner / regulator. No vague phrasing.',
          },
          source: { type: 'string', description: 'Publication name, e.g. "Sifted", "Tech.eu".' },
          url: { type: 'string', description: 'Canonical article URL.' },
          publishedAt: {
            type: 'string',
            description: 'Publication date, ISO AAAA-MM-JJ.',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
        },
        required: ['title', 'source', 'url', 'publishedAt'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

/** FR absolute display label from an ISO date, e.g. "2026-07-08" -> "8 juil. 2026". */
export function frDateLabel(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

function buildSystemPrompt(nowIso) {
  return [
    "Tu es analyste veille pour un fonds de capital-risque en santé (HealthTech / MedTech / Biotech).",
    `La date du jour est ${nowIso}.`,
    'Ta mission : trouver les développements RÉCENTS et NOTABLES concernant UNE startup précise,',
    'via la recherche web, puis les renvoyer au format structuré demandé.',
    '',
    'Règles impératives :',
    `- Fenêtre : uniquement des faits publiés dans les ${WINDOW_DAYS} derniers jours (publishedAt >= ${nowIso} - ${WINDOW_DAYS} j).`,
    '- Nouveauté : ne renvoie QUE des développements réellement nouveaux, NON déjà couverts',
    '  par les éléments déjà en stock (fournis dans le message). Ignore tout doublon.',
    "- Une affaire = un article : si plusieurs sources couvrent le MÊME événement (même levée,",
    '  même partenariat, même résultat clinique), n\'en garde QU\'UN SEUL item — le plus fiable.',
    '- Noms précis, jamais de description vague : société, MONTANT chiffré, investisseur LEAD,',
    '  partenaire, régulateur, molécule. Un titre sans nom concret est à proscrire.',
    "- N'invente jamais une URL, une source ou une date. Si tu n'es pas sûr, n'inclus pas l'item.",
    '- Si tu ne trouves aucun développement nouveau et vérifiable, renvoie une liste vide.',
    '- Titres en français.',
  ].join('\n');
}

function buildUserPrompt(startupName, storedItems) {
  const stored = (storedItems ?? []).map((i) => ({ title: i.title, url: i.url }));
  return [
    `Startup à surveiller : « ${startupName} ».`,
    '',
    'Éléments DÉJÀ EN STOCK pour cette startup (à NE PAS répéter — même affaire = ne pas renvoyer) :',
    stored.length ? JSON.stringify(stored, null, 2) : '(aucun — tout ce qui est récent et notable est nouveau)',
    '',
    'Recherche le web, puis renvoie les développements nouveaux et distincts au format imposé.',
  ].join('\n');
}

/**
 * Research one startup and return new, distinct NewsItem objects.
 *
 * @param {Anthropic} client an initialized Anthropic SDK client
 * @param {string} startupName exact catalog name
 * @param {Array<object>} storedItems items already stored for this startup
 * @param {object} [opts]
 * @param {Date} [opts.now]        reference "today"
 * @param {number} [opts.maxUses]  web_search max_uses (default 6)
 * @param {number} [opts.maxTurns] safety cap on pause_turn resumes (default 8)
 * @returns {Promise<Array<{title,source,url,publishedAt,date}>>}
 */
export async function researchStartup(client, startupName, storedItems = [], opts = {}) {
  const { now = new Date(), maxUses = 6, maxTurns = 8 } = opts;
  const nowIso = now.toISOString().slice(0, 10);

  const messages = [{ role: 'user', content: buildUserPrompt(startupName, storedItems) }];

  const baseParams = {
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: buildSystemPrompt(nowIso),
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxUses }],
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
  };

  let final;
  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({ ...baseParams, messages });

    // web_search is a SERVER tool: Anthropic runs it and streams the results back
    // in the same turn. The only thing we resume locally is `pause_turn`, emitted
    // when a long server-tool turn is parked. Re-send with the paused turn appended.
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    final = response;
    break;
  }

  if (!final) {
    throw new Error(`research for "${startupName}" did not converge within ${maxTurns} turns`);
  }

  const parsed = extractParsed(final, startupName);
  const items = Array.isArray(parsed?.items) ? parsed.items : [];

  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it || typeof it.url !== 'string' || !it.url) continue;
    if (typeof it.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(it.publishedAt)) continue;
    if (seen.has(it.url)) continue; // guard against the model repeating a url
    seen.add(it.url);
    out.push({
      title: String(it.title ?? '').trim(),
      source: String(it.source ?? '').trim(),
      url: it.url,
      publishedAt: it.publishedAt,
      date: frDateLabel(it.publishedAt),
    });
  }
  return out;
}

/**
 * Pull the structured object out of the final message.
 *
 * With `output_config.format` on `messages.create`, the model returns the JSON as
 * TEXT content — `parsed_output` is only populated by `client.messages.parse()`,
 * not by `.create()`. So text-parsing is the PRIMARY path; `parsed_output` is only
 * an opportunistic first try in case a future SDK/path populates it.
 */
function extractParsed(message, startupName = '?') {
  // Opportunistic: use parsed_output only if the SDK actually populated it.
  if (message.parsed_output && typeof message.parsed_output === 'object') {
    return message.parsed_output;
  }

  // Primary path: concatenate every text block, strip markdown fences, JSON.parse.
  const text = message.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();

  if (!text) {
    console.error(`research "${startupName}": no text content to parse — returning []`);
    return null;
  }

  const cleaned = stripCodeFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    console.error(`research "${startupName}": text content was not valid JSON — returning []`);
    return null;
  }
}

/** Remove a wrapping ```json … ``` (or bare ``` … ```) markdown code fence. */
function stripCodeFences(text) {
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return (fenced ? fenced[1] : text).trim();
}

/** Convenience factory so run.mjs doesn't hard-code the env var name. */
export function makeClient() {
  return new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
}
