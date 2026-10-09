#!/usr/bin/env node

/**
 * Upload catalog data files to Cloudflare KV (API_CACHE namespace)
 *
 * This replaces fetching from raw.githubusercontent.com on every worker cold start.
 * The worker reads these from KV first, falling back to GitHub only if KV is empty.
 *
 * Keys are versioned via CACHE_BUSTER (e.g. "catalog:v15") so updating the catalog
 * only requires re-running this script after bumping CACHE_BUSTER in worker-github.js.
 *
 * Usage:
 *   node upload-to-kv.js           # Upload all files + generated index/buckets
 *   node upload-to-kv.js catalog   # Upload only catalog.json
 *   node upload-to-kv.js filters   # Upload only filter-options.json
 *   node upload-to-kv.js mappings  # Upload only id-mappings.json
 *   node upload-to-kv.js index     # Generate + upload slim catalog index (idx:{v})
 *   node upload-to-kv.js titles    # Generate + upload title buckets (tb:{v}:{ns}:{0-15})
 *
 * Prerequisites:
 *   - wrangler logged in (npx wrangler login)
 *   - API_CACHE KV namespace created (npx wrangler kv namespace create API_CACHE)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKER_DIR = __dirname;
const DATA_DIR = path.join(__dirname, '..', 'data');
const NAMESPACE_ID = 'cd4c8644874547f18a077cc646eda3d6';

// Must match CACHE_BUSTER in worker-github.js
const CACHE_BUSTER = 'v17';

// Fields kept in the slim index (idx:{v}) — everything the worker's catalog
// handlers, filters, formatAnimeMeta and searchDatabase actually read.
// Dropped: slug, cast, ageRating, popularity, synonyms, _matchSource,
// _mergedSeasons, anidb_id, broadcastTime. Descriptions truncated to 500
// chars (formatAnimeMeta truncates to 200 anyway).
const SLIM_FIELDS = [
  'id', 'imdb_id', 'mal_id', 'kitsu_id', 'anilist_id', 'type', 'name',
  'description', 'year', 'season', 'status', 'rating', 'poster',
  'background', 'logo', 'genres', 'episodeCount', 'runtime', 'subtype',
  'countryOfOrigin', 'broadcastDay', 'episodes', 'studios', 'animeType',
];
const SLIM_DESC_LEN = 500;

// Title-bucket sharding — must stay in sync with findAnimeByIdFast in
// worker-github.js (same hashStr, same bucket count, same ns/raw forms).
const TITLE_BUCKET_COUNT = 16;

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0);
}

const FILES = {
  catalog: {
    key: `catalog:${CACHE_BUSTER}`,
    path: path.join(DATA_DIR, 'catalog.json'),
    desc: 'Catalog data (15MB+)',
  },
  filters: {
    key: `filters:${CACHE_BUSTER}`,
    path: path.join(DATA_DIR, 'filter-options.json'),
    desc: 'Filter options',
  },
  mappings: {
    key: `mappings:${CACHE_BUSTER}`,
    path: path.join(DATA_DIR, 'id-mappings.json'),
    desc: 'ID mappings',
  },
  index: {
    key: `idx:${CACHE_BUSTER}`,
    gen: 'index',
    desc: 'Slim catalog index (~7MB)',
  },
  titles: {
    prefix: `tb:${CACHE_BUSTER}:`,
    gen: 'buckets',
    desc: 'Title lookup buckets (64 keys)',
  },
};

function kvPut(key, filePath) {
  const cmd = `npx wrangler kv key put --namespace-id=${NAMESPACE_ID} "${key}" --path="${filePath}" --remote`;
  execSync(cmd, { stdio: 'inherit', cwd: WORKER_DIR });
}

function loadCatalog() {
  const p = path.join(DATA_DIR, 'catalog.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return data.catalog || data;
}

function slimEntry(a) {
  const e = {};
  for (const k of SLIM_FIELDS) if (k in a) e[k] = a[k];
  if (e.description) e.description = e.description.slice(0, SLIM_DESC_LEN);
  return e;
}

function buildTitleBuckets(catalog) {
  const buckets = {}; // 'ns:bucketIdx' -> entries[]
  const add = (ns, raw, entry) => {
    const k = `${ns}:${hashStr(raw) % TITLE_BUCKET_COUNT}`;
    (buckets[k] ??= []).push(entry);
  };
  for (const a of catalog) {
    if (a.id) add('id', a.id, a);
    if (a.imdb_id) add('tt', a.imdb_id, a);
    if (a.mal_id != null) add('mal', String(a.mal_id), a);
    if (a.kitsu_id != null) add('kitsu', String(a.kitsu_id), a);
  }
  return buckets;
}

function uploadGenerated(name) {
  const file = FILES[name];
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'askv-'));
  const catalog = loadCatalog();

  if (file.gen === 'index') {
    const slim = catalog.map(slimEntry);
    const out = path.join(tmpDir, 'idx.json');
    fs.writeFileSync(out, JSON.stringify(slim));
    const sizeMB = (fs.statSync(out).size / 1024 / 1024).toFixed(2);
    console.log(`\nUploading ${file.desc}...`);
    console.log(`  Key:  ${file.key}  (${slim.length} entries, ${sizeMB} MB)`);
    kvPut(file.key, out);
    console.log(`  ✓ Uploaded successfully`);
    return;
  }

  if (file.gen === 'buckets') {
    const buckets = buildTitleBuckets(catalog);
    const keys = Object.keys(buckets);
    console.log(`\nUploading ${file.desc}...`);
    console.log(`  ${keys.length} bucket keys under ${file.prefix}{ns}:{0-15}`);
    let done = 0;
    for (const k of keys) {
      const out = path.join(tmpDir, `${k.replace(':', '_')}.json`);
      fs.writeFileSync(out, JSON.stringify(buckets[k]));
      const sizeKB = (fs.statSync(out).size / 1024).toFixed(0);
      kvPut(`${file.prefix}${k}`, out);
      done++;
      console.log(`  ✓ ${file.prefix}${k} (${buckets[k].length} entries, ${sizeKB} KB) [${done}/${keys.length}]`);
    }
    return;
  }
}

function uploadFile(name) {
  const file = FILES[name];
  if (!file) {
    console.error(`Unknown file: ${name}. Valid options: ${Object.keys(FILES).join(', ')}`);
    process.exit(1);
  }

  if (file.gen) {
    uploadGenerated(name);
    return;
  }

  if (!fs.existsSync(file.path)) {
    console.error(`File not found: ${file.path}`);
    process.exit(1);
  }

  const sizeMB = (fs.statSync(file.path).size / 1024 / 1024).toFixed(2);
  console.log(`\nUploading ${file.desc}...`);
  console.log(`  Key:  ${file.key}`);
  console.log(`  Path: ${file.path}`);
  console.log(`  Size: ${sizeMB} MB`);

  if (parseFloat(sizeMB) > 25) {
    console.error(`  ERROR: File exceeds KV's 25MB value limit!`);
    process.exit(1);
  }

  try {
    kvPut(file.key, file.path);
    console.log(`  ✓ Uploaded successfully`);
  } catch (error) {
    console.error(`  ✗ Upload failed:`, error.message);
    process.exit(1);
  }
}

// Determine which files to upload
const args = process.argv.slice(2);
const toUpload = args.length > 0 ? args : Object.keys(FILES);

console.log('='.repeat(60));
console.log('Uploading catalog data to Cloudflare KV');
console.log(`Namespace: ${NAMESPACE_ID}`);
console.log(`Version:   ${CACHE_BUSTER}`);
console.log('='.repeat(60));

for (const name of toUpload) {
  uploadFile(name);
}

console.log('\n✓ All uploads complete!');
console.log('\nThe worker will now read catalog data from KV instead of GitHub raw.');
console.log('To update the catalog after changes:');
console.log('  1. Bump CACHE_BUSTER in cloudflare-worker/worker-github.js');
console.log('  2. Re-run: node cloudflare-worker/upload-to-kv.js');
console.log('  3. Deploy: cd cloudflare-worker && npx wrangler deploy');
