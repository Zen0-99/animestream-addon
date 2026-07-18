/**
 * Enrich catalog.json with countryOfOrigin data from AniList API.
 * AniList provides countryOfOrigin (e.g., "JP", "CN", "KR", "TW") for each anime.
 *
 * Usage: node scripts/enrich-country-of-origin.js
 *
 * This script:
 * 1. Loads data/catalog.json
 * 2. Batches AniList IDs (50 per request) and queries the AniList GraphQL API
 * 3. Adds countryOfOrigin field to each catalog entry
 * 4. Saves the enriched catalog back to data/catalog.json
 * 5. Prints a summary of origin distribution
 */

const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'catalog.json');
const FETCHED_PATH = path.join(__dirname, '..', 'data', 'origin-fetched-ids.json');
const ANILIST_API = 'https://graphql.anilist.co';
const BATCH_SIZE = 50; // AniList allows up to 50 IDs per Page query
const RATE_LIMIT_DELAY = 600; // ms between requests to respect rate limits

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchCountryOfOriginBatch(anilistIds, maxRetries = 5) {
  const query = `
    query ($id_in: [Int!], $page: Int) {
      Page(page: $page, perPage: 50) {
        media(id_in: $id_in, type: ANIME) {
          id
          countryOfOrigin
        }
      }
    }
  `;

  const variables = { id_in: anilistIds, page: 1 };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(ANILIST_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 429) {
      // Rate limited - wait with exponential backoff
      const waitMs = 2000 * Math.pow(2, attempt);
      await sleep(waitMs);
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`AniList API returned ${response.status}: ${text.substring(0, 200)}`);
    }

    const data = await response.json();
    if (data.errors) {
      throw new Error(`AniList GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    const media = data.data?.Page?.media || [];
    const result = {};
    for (const m of media) {
      result[m.id] = m.countryOfOrigin || null;
    }
    return result;
  }

  throw new Error('Max retries exceeded for rate limiting');
}

async function main() {
  console.log('Loading catalog...');
  const catalogRaw = fs.readFileSync(CATALOG_PATH, 'utf8');
  const catalogData = JSON.parse(catalogRaw);
  const catalog = catalogData.catalog || catalogData;
  const isWrapped = !!catalogData.catalog;

  console.log(`Total entries: ${catalog.length}`);

  // Collect all AniList IDs
  const entriesWithAl = catalog.filter(a => a.anilist_id);
  const entriesWithoutAl = catalog.filter(a => !a.anilist_id);
  console.log(`Entries with AniList ID: ${entriesWithAl.length}`);
  console.log(`Entries without AniList ID: ${entriesWithoutAl.length}`);

  // Load tracking file (which AniList IDs we've already successfully fetched)
  let fetchedIds = new Set();
  try {
    if (fs.existsSync(FETCHED_PATH)) {
      fetchedIds = new Set(JSON.parse(fs.readFileSync(FETCHED_PATH, 'utf8')));
    }
  } catch {}
  console.log(`Previously fetched IDs: ${fetchedIds.size}`);

  // Check which entries need fetching (have AniList ID but not yet fetched)
  const entriesNeedingFetch = entriesWithAl.filter(a => !fetchedIds.has(a.anilist_id));
  console.log(`Entries needing countryOfOrigin fetch: ${entriesNeedingFetch.length}`);

  if (entriesNeedingFetch.length === 0) {
    console.log('All entries already have countryOfOrigin. Nothing to do.');
    return;
  }

  // Build ID -> entry index map
  const idToIndex = {};
  entriesNeedingFetch.forEach((entry, i) => {
    const idx = catalog.indexOf(entry);
    idToIndex[entry.anilist_id] = idx;
  });

  // Batch fetch
  const allIds = entriesNeedingFetch.map(a => a.anilist_id);
  const originMap = {};
  let fetched = 0;
  let failed = 0;
  const totalBatches = Math.ceil(allIds.length / BATCH_SIZE);

  console.log(`\nFetching from AniList in ${totalBatches} batches (50 IDs each)...`);

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batch = allIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    try {
      const batchResult = await fetchCountryOfOriginBatch(batch);
      Object.assign(originMap, batchResult);
      fetched += Object.keys(batchResult).length;
      console.log(`  Batch ${batchNum}/${totalBatches}: got ${Object.keys(batchResult).length}/${batch.length} origins`);
    } catch (err) {
      failed += batch.length;
      console.error(`  Batch ${batchNum}/${totalBatches}: FAILED - ${err.message}`);
      // Wait longer on failure
      await sleep(2000);
    }

    // Rate limit
    if (batchNum < totalBatches) {
      await sleep(RATE_LIMIT_DELAY);
    }
  }

  console.log(`\nFetched origins for ${fetched} entries, ${failed} failed`);

  // Apply origins to catalog
  let updated = 0;
  for (const [alId, origin] of Object.entries(originMap)) {
    const idx = idToIndex[alId];
    if (idx !== undefined && origin) {
      catalog[idx].countryOfOrigin = origin;
      fetchedIds.add(parseInt(alId));
      updated++;
    }
  }

  // For entries without AniList ID, default to "JP" (most anime is Japanese)
  let defaultJP = 0;
  for (const entry of entriesWithoutAl) {
    if (!entry.countryOfOrigin) {
      entry.countryOfOrigin = 'JP';
      defaultJP++;
    }
  }
  console.log(`Defaulted ${defaultJP} entries (no AniList ID) to JP`);

  // For entries with AniList ID but failed fetch, default to JP
  // (fetchedIds tracking file ensures we retry on next run)
  let defaultFailedJP = 0;
  for (const entry of catalog) {
    if (!entry.countryOfOrigin) {
      entry.countryOfOrigin = 'JP';
      defaultFailedJP++;
    }
  }
  console.log(`Defaulted ${defaultFailedJP} entries (failed fetch) to JP (will retry on next run)`);

  // Print origin distribution
  const originCounts = {};
  for (const entry of catalog) {
    const origin = entry.countryOfOrigin || 'UNKNOWN';
    originCounts[origin] = (originCounts[origin] || 0) + 1;
  }
  console.log('\n=== Country of Origin Distribution ===');
  const sorted = Object.entries(originCounts).sort((a, b) => b[1] - a[1]);
  for (const [origin, count] of sorted) {
    console.log(`  ${origin}: ${count} (${(count / catalog.length * 100).toFixed(1)}%)`);
  }

  // Save enriched catalog
  console.log('\nSaving enriched catalog...');
  const output = isWrapped
    ? { ...catalogData, catalog }
    : catalog;
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(output, null, 2));
  console.log(`Saved to ${CATALOG_PATH}`);

  // Save tracking file
  fs.writeFileSync(FETCHED_PATH, JSON.stringify([...fetchedIds]));
  console.log(`Saved tracking file with ${fetchedIds.size} IDs to ${FETCHED_PATH}`);

  // Also save a gzipped version
  const { gzipSync } = require('zlib');
  const gzipped = gzipSync(Buffer.from(JSON.stringify(output)));
  const gzPath = CATALOG_PATH + '.gz';
  fs.writeFileSync(gzPath, gzipped);
  console.log(`Saved gzipped to ${gzPath} (${(gzipped.length / 1024 / 1024).toFixed(2)} MB)`);

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
