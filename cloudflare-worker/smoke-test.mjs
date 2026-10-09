// Smoke test for worker-github.js — stubs env/caches/fetch, exercises routes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');
const DATA = path.join(DIR, '..', 'data');

// ---- same generation logic as upload-to-kv.js ----
const SLIM_FIELDS = ['id','imdb_id','mal_id','kitsu_id','anilist_id','type','name','description','year','season','status','rating','poster','background','logo','genres','episodeCount','runtime','subtype','countryOfOrigin','broadcastDay','episodes','studios','animeType'];
const TITLE_BUCKET_COUNT = 16;
const CACHE_BUSTER = 'v17';
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0); }

const catalogData = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog.json'), 'utf-8'));
const catalog = catalogData.catalog || catalogData;
const filters = JSON.parse(fs.readFileSync(path.join(DATA, 'filter-options.json'), 'utf-8'));

const slim = catalog.map(a => { const e = {}; for (const k of SLIM_FIELDS) if (k in a) e[k] = a[k]; if (e.description) e.description = e.description.slice(0, 500); return e; });

const buckets = {};
const addB = (ns, raw, entry) => { const k = `${ns}:${hashStr(raw) % TITLE_BUCKET_COUNT}`; (buckets[k] ??= []).push(entry); };
for (const a of catalog) {
  if (a.id) addB('id', a.id, a);
  if (a.imdb_id) addB('tt', a.imdb_id, a);
  if (a.mal_id != null) addB('mal', String(a.mal_id), a);
  if (a.kitsu_id != null) addB('kitsu', String(a.kitsu_id), a);
}
console.log(`buckets: ${Object.keys(buckets).length}, slim: ${slim.length}`);

// ---- KV stub ----
const kvStore = new Map();
kvStore.set(`idx:${CACHE_BUSTER}`, slim);
kvStore.set(`filters:${CACHE_BUSTER}`, filters);
for (const [k, v] of Object.entries(buckets)) kvStore.set(`tb:${CACHE_BUSTER}:${k}`, v);
const kvReads = { count: 0 };
const kvStub = {
  async get(key, type) { kvReads.count++; const v = kvStore.get(key); if (v === undefined) return null; return type === 'json' ? v : JSON.stringify(v); },
  async put(key, val) { kvStore.set(key, JSON.parse(val)); },
};

// ---- Cache API stub ----
const cacheStore = new Map();
const cacheOps = { match: 0, put: 0 };
globalThis.caches = {
  default: {
    async match(key) {
      cacheOps.match++;
      const k = typeof key === 'string' ? key : key.url;
      const r = cacheStore.get(k);
      return r ? r.clone() : undefined;
    },
    async put(key, res) {
      cacheOps.put++;
      const k = typeof key === 'string' ? key : key.url;
      const body = await res.text();
      const headers = {};
      res.headers.forEach((v, h) => headers[h] = v);
      cacheStore.set(k, new Response(body, { status: res.status, headers }));
    },
  },
};

// ---- fetch stub (intercept external calls) ----
const realFetch = globalThis.fetch;
const extCalls = [];
globalThis.fetch = async (input, init) => {
  const u = typeof input === 'string' ? input : input.url;
  extCalls.push(u);
  if (u.includes('v3-cinemeta')) {
    return new Response(JSON.stringify({ meta: { name: 'Stub Show', videos: [{ id: 'x:1:1', season: 1, episode: 1 }] } }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('allanime')) {
    return new Response(JSON.stringify({ data: { shows: { edges: [] }, show: null } }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('anilist')) {
    return new Response(JSON.stringify({ data: {} }), { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};

// ---- import worker ----
const tmp = path.join(os.tmpdir(), 'wg-smoke.mjs');
fs.copyFileSync(path.join(DIR, 'worker-github.js'), tmp);
const worker = (await import((await import('node:url')).pathToFileURL(tmp).href)).default;

const env = { API_CACHE: kvStub, USER_TOKENS: kvStub, ENVIRONMENT: 'production' };
const ctx = { waitUntil: (p) => Promise.resolve(p) };

async function hit(label, url) {
  kvReads.count = 0;
  const res = await worker.fetch(new Request(url), env, ctx);
  const body = await res.text();
  console.log(`${label}  status=${res.status}  x-as-cache=${res.headers.get('x-as-cache') || '-'}  kvReads=${kvReads.count}  body=${body.slice(0, 110)}`);
  return res;
}

const B = 'http://x';
await hit('health        ', `${B}/health`);
await hit('health (2nd)  ', `${B}/health`);
await hit('manifest      ', `${B}/manifest.json`);
await hit('manifest (2nd)', `${B}/manifest.json`);
await hit('meta tt       ', `${B}/meta/series/tt2560140.json`);
await hit('meta tt (2nd) ', `${B}/meta/series/tt2560140.json`);
await hit('meta cfg tt   ', `${B}/sometoken%3Dx%7Cy%3D2/meta/series/tt2560140.json`);
await hit('meta miss     ', `${B}/meta/series/tt999999999.json`);
await hit('meta mal      ', `${B}/meta/series/mal-16498.json`);
await hit('catalog top   ', `${B}/catalog/anime/anime-top-rated.json`);
await hit('catalog (2nd) ', `${B}/catalog/anime/anime-top-rated.json`);
await hit('catalog page2 ', `${B}/catalog/anime/anime-top-rated/skip=100.json`);
await hit('catalog diff-cfg', `${B}/anilistToken%3Dsecret%7CmalToken%3Dzzz/catalog/anime/anime-top-rated.json`);
await hit('search        ', `${B}/catalog/anime/anime-search/search=naruto.json`);
await hit('meta kitsu    ', `${B}/meta/series/kitsu:7442.json`);
await hit('api stats     ', `${B}/api/stats`);
await hit('404           ', `${B}/nope`);
console.log(`\ncacheOps: match=${cacheOps.match} put=${cacheOps.put}  extCalls=${extCalls.length}`);
console.log('external calls:', [...new Set(extCalls)]);
