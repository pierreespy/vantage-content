// node --test backend/signals/api/serve.test.mjs
//
// The handler is exercised directly, without binding a port: these tests are
// about the endpoint CONTRACT (status codes, shapes, error bodies), not sockets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, createLeadsLoader } from './serve.mjs';

const LEADS = [
  {
    id: 'person:dupont',
    kind: 'person',
    name: 'Jean-Marc Dupont',
    aliases: [],
    company: 'Neuroscan Medical',
    companies: ['Neuroscan Medical'],
    country: 'FR',
    countries: ['FR'],
    score: 85,
    priority: 'high',
    rules: ['researcher_patent_newco'],
    reasons: ['Chercheur publiant + brevet déposé + société créée il y a 2 mois.'],
    signals: [{ signalType: 'patent_filing', source: 'epo', title: 'Implantable cardiac sensor', date: '2026-05-15' }],
    keywords: [],
    latestEvidence: '2026-06-14',
    updatedAt: '2026-08-09',
  },
  {
    id: 'person:lefevre',
    kind: 'person',
    name: 'Marie Lefevre',
    aliases: [],
    company: '',
    companies: [],
    country: 'DE',
    countries: ['DE'],
    score: 55,
    priority: 'medium',
    rules: ['new_trial_no_company'],
    reasons: [],
    signals: [],
    keywords: [],
    latestEvidence: '2026-08-05',
    updatedAt: '2026-08-09',
  },
];

const loadLeads = async () => ({ generatedAt: '2026-08-09', leads: LEADS });

/** Fake ServerResponse capturing what the handler wrote. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? '';
    },
    get json() {
      return JSON.parse(this.body);
    },
  };
}

async function get(url, loader = loadLeads) {
  const response = fakeResponse();
  await createHandler(loader)({ method: 'GET', url }, response);
  return response;
}

test('GET /api/medtech/leads returns a paginated envelope', async () => {
  const response = await get('/api/medtech/leads');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /application\/json/);
  const body = response.json;
  assert.equal(body.generatedAt, '2026-08-09');
  assert.equal(body.total, 2);
  assert.equal(body.page, 1);
  assert.equal(body.hasMore, false);
  assert.equal(body.items.length, 2);
});

test('each item carries the signals that triggered its score', async () => {
  const body = (await get('/api/medtech/leads?min_score=80')).json;
  assert.equal(body.total, 1);
  assert.deepEqual(body.items[0].rules, ['researcher_patent_newco']);
  assert.equal(body.items[0].signals[0].signalType, 'patent_filing');
  assert.ok(body.items[0].reasons[0].length > 0);
});

test('filters compose: min_score + pays + plage de dates + pagination', async () => {
  const body = (await get('/api/medtech/leads?min_score=50&pays=FR&date_from=2026-01-01&page_size=1')).json;
  assert.equal(body.total, 1);
  assert.equal(body.pageSize, 1);
  assert.deepEqual(body.filters.country, ['FR']);
});

test('an invalid filter is a 400 with a readable message, not a 500', async () => {
  const response = await get('/api/medtech/leads?min_score=beaucoup');
  assert.equal(response.statusCode, 400);
  assert.equal(response.json.error, 'invalid_query');
  assert.match(response.json.message, /min_score/);
});

test('GET /api/medtech/leads/:id returns one lead, or 404', async () => {
  const found = await get('/api/medtech/leads/person%3Adupont');
  assert.equal(found.statusCode, 200);
  assert.equal(found.json.lead.name, 'Jean-Marc Dupont');

  const missing = await get('/api/medtech/leads/person%3Anobody');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json.error, 'not_found');
});

test('GET /health reports how many leads are loaded', async () => {
  const response = await get('/health');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, { status: 'ok', generatedAt: '2026-08-09', leads: 2 });
});

test('an unknown route is a 404 that points at the real one', async () => {
  const response = await get('/api/leads');
  assert.equal(response.statusCode, 404);
  assert.match(response.json.message, /\/api\/medtech\/leads/);
});

test('non-GET methods are refused with 405', async () => {
  const response = fakeResponse();
  await createHandler(loadLeads)({ method: 'POST', url: '/api/medtech/leads' }, response);
  assert.equal(response.statusCode, 405);
});

test('no leads file yet is an empty result, never a 500', async () => {
  // The endpoint has to answer before the pipeline has ever run.
  const loader = createLeadsLoader('/nope/medtech-leads.json');
  const response = await get('/api/medtech/leads', loader);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.total, 0);
});

test('the loader re-reads only when the file changed on disk', async () => {
  let reads = 0;
  let mtimeMs = 1;
  const loader = createLeadsLoader('/leads.json', {
    read: async () => {
      reads += 1;
      return JSON.stringify({ generatedAt: '2026-08-09', leads: [{ id: 'x' }] });
    },
    statFile: async () => ({ mtimeMs }),
  });

  await loader();
  await loader();
  assert.equal(reads, 1, 'unchanged mtime is served from memory');

  mtimeMs = 2;
  await loader();
  assert.equal(reads, 2, 'a rewritten file is picked up');
});
