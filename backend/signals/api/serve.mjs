// Vantage — the MedTech leads HTTP endpoint.
//
//   GET /api/medtech/leads       list + filter + paginate (see api/query.mjs)
//   GET /api/medtech/leads/:id    one lead with its full signal detail
//   GET /health                   liveness + how many leads are loaded
//
// Built on `node:http` with ZERO dependencies, on purpose. docs/signals-plan.md
// fixes the architecture at "0 € d'infra": there is no server to run Express on,
// and the production read path is the STATIC medtech-leads.json published to
// GitHub Pages — the same pattern as edition.json / startup-news.json / words.json
// in src/config.ts. This server is the local + CI way to query that same data
// interactively (and the reference implementation of the endpoint contract),
// not a component anyone has to host.
//
//   node backend/signals/api/serve.mjs
//   curl 'http://localhost:8787/api/medtech/leads?min_score=80&pays=FR&page_size=5'

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { loadConfig } from '../config.mjs';
import { QueryError, parseQueryParams, queryLeads } from './query.mjs';

const LEADS_ROUTE = '/api/medtech/leads';

/**
 * Load the leads file, re-reading it only when it changed on disk. The cron
 * rewrites the file under a long-running server, so caching on mtime keeps the
 * hot path off the filesystem without ever serving stale data.
 */
export function createLeadsLoader(path, { read = readFile, statFile = stat } = {}) {
  let cached = { generatedAt: '', leads: [] };
  let cachedMtime = -1;

  return async function loadLeads() {
    try {
      const { mtimeMs } = await statFile(path);
      if (mtimeMs === cachedMtime) return cached;
      const parsed = JSON.parse(await read(path, 'utf8'));
      cached = {
        generatedAt: typeof parsed?.generatedAt === 'string' ? parsed.generatedAt : '',
        leads: Array.isArray(parsed?.leads) ? parsed.leads : [],
      };
      cachedMtime = mtimeMs;
      return cached;
    } catch {
      // No file yet (the pipeline has never run) is a legitimate empty state,
      // not a 500 — the endpoint answers with zero results.
      return cached;
    }
  };
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Read-only public data, so a permissive GET policy is safe and lets a
    // browser or a notebook query it directly.
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=60',
  });
  response.end(payload);
}

/**
 * The request handler, exported separately from the server so tests can call it
 * without binding a port.
 */
export function createHandler(loadLeads) {
  return async function handle(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'method_not_allowed', message: 'Seul GET est supporté.' });
      return;
    }

    const url = new URL(request.url, 'http://localhost');

    if (url.pathname === '/health') {
      const { leads, generatedAt } = await loadLeads();
      sendJson(response, 200, { status: 'ok', generatedAt, leads: leads.length });
      return;
    }

    if (url.pathname === LEADS_ROUTE) {
      const { leads, generatedAt } = await loadLeads();
      try {
        const filters = parseQueryParams(url.searchParams);
        sendJson(response, 200, queryLeads(leads, filters, { generatedAt }));
      } catch (err) {
        if (err instanceof QueryError) {
          sendJson(response, err.status, { error: 'invalid_query', message: err.message });
          return;
        }
        throw err;
      }
      return;
    }

    if (url.pathname.startsWith(`${LEADS_ROUTE}/`)) {
      const id = decodeURIComponent(url.pathname.slice(LEADS_ROUTE.length + 1));
      const { leads, generatedAt } = await loadLeads();
      const lead = leads.find((candidate) => candidate.id === id);
      if (!lead) {
        sendJson(response, 404, { error: 'not_found', message: `Aucun lead « ${id} ».` });
        return;
      }
      sendJson(response, 200, { generatedAt, lead });
      return;
    }

    sendJson(response, 404, {
      error: 'not_found',
      message: `Route inconnue. Essayez GET ${LEADS_ROUTE}.`,
    });
  };
}

/** Build (but do not start) the server. */
export function createLeadsServer(opts = {}) {
  const { config = loadConfig(), loadLeads = createLeadsLoader(config.leadsPath) } = opts;
  const handle = createHandler(loadLeads);

  return createServer((request, response) => {
    handle(request, response).catch((err) => {
      console.error('leads endpoint failed:', err);
      sendJson(response, 500, { error: 'internal_error', message: 'Erreur interne.' });
    });
  });
}

// CLI entrypoint.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  createLeadsServer({ config }).listen(config.port, () => {
    console.log(`leads endpoint on http://localhost:${config.port}${LEADS_ROUTE}`);
    console.log(`serving ${config.leadsPath}`);
  });
}
