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
 *   node upload-to-kv.js           # Upload all 3 files
 *   node upload-to-kv.js catalog   # Upload only catalog.json
 *   node upload-to-kv.js filters   # Upload only filter-options.json
 *   node upload-to-kv.js mappings  # Upload only id-mappings.json
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
const CACHE_BUSTER = 'v16';

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
};

function uploadFile(name) {
  const file = FILES[name];
  if (!file) {
    console.error(`Unknown file: ${name}. Valid options: ${Object.keys(FILES).join(', ')}`);
    process.exit(1);
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
    const cmd = `npx wrangler kv key put --namespace-id=${NAMESPACE_ID} "${file.key}" --path="${file.path}" --remote`;
    console.log(`  Running: ${cmd}`);
    execSync(cmd, { stdio: 'inherit', cwd: WORKER_DIR });
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
